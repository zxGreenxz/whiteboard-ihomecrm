#!/usr/bin/env node
// Kiểm staged snapshot bằng kế hoạch dùng chung với CI.
// --plan chỉ in lựa chọn; --full mở rộng bộ active, vẫn giữ module DEFERRED.
// --live thêm gate cần credential (env/vault); luôn chạy Vitest liên quan tới diff.
// Generator chỉ chạy khi đầu vào liên quan đổi, chỉ stage artifact thuộc sở hữu.
// Receipt local không thay bằng chứng CI. Exit 1 = lỗi, 3 = chưa đủ đầu vào.

import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { khopGlob } from "./check-risk-classifier.mjs";
import { DAO } from "./check-strict-islands.mjs";
import { isDeferredGate } from "./lib/deferred-modules.mjs";
import { GATE_REGISTRY, GENERATOR_REGISTRY, getGate } from "./lib/gate-registry.mjs";
import { createGateReceipt, canReuseGateReceipt } from "./lib/gate-evidence.mjs";
import { indexInputConflicts } from "./lib/local-gate-snapshot.mjs";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
// Compatibility exports for callers; execution below uses the selected plan.
export const GATE_TAM_HOAN = JSON.parse(readFileSync(join(repoRoot, 'tooling/deferred-modules.json'), 'utf8')).modules.flatMap((m) => m.gates);
export const GATE_NHANH = Object.values(GATE_REGISTRY).filter((g) => g.local && g.job === 'quality-gates' && !g.id.startsWith('suite:') && !['check-ts-baseline','check-eslint-baseline'].includes(g.id)).map((g) => g.id);
export const GATE_NANG = [...DAO.map((d) => ['check-strict-islands', '--dao', d.ten]), 'check-ts-baseline', 'check-eslint-baseline'];
export const TU_CHUA = Object.values(GENERATOR_REGISTRY).map((g) => [g.id, g.args, { soHuu: g.owns, kieu: g.patch ? 'va-tay' : 'may', mang: g.external }]);

/**
 * Số cửa chạy cùng lúc: chừa 2 luồng cho máy, tối thiểu 2, tối đa 8.
 * Đo 01/10/2026 trên máy 16 luồng: 41 cửa tĩnh lần lượt 72 s, 8 cùng lúc 42 s.
 */
export const soLuongSongSong = (soLuong) => Math.max(2, Math.min(8, soLuong - 2));

/** Nhóm nặng xếp trước để việc dài khởi động sớm; `--khong-dao-strict` bỏ hẳn nhóm nặng. */
export const danhSachChay = ({ boDaoStrict }) => (boDaoStrict ? [...GATE_NHANH] : [...GATE_NANG, ...GATE_NHANH]);

/**
 * Chạy các việc bất đồng bộ với tối đa `gioiHan` việc cùng lúc.
 * Kết quả trả về ĐÚNG THỨ TỰ KHAI, không theo thứ tự xong — để bảng kết quả và
 * phần in lỗi không đổi chỗ giữa các lượt chạy.
 */
export async function chayGioiHan(cacViec, gioiHan) {
  const ketQua = new Array(cacViec.length);
  let tiep = 0;
  const tho = async () => {
    while (tiep < cacViec.length) {
      const i = tiep;
      tiep += 1;
      ketQua[i] = await cacViec[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(gioiHan, cacViec.length) }, tho));
  return ketQua;
}

const goiGit = (args) =>
  (spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" }).stdout ?? "")
    .split("\n")
    .filter(Boolean)
    .map((p) => p.replace(/\\/g, "/"));

/** File tracked đang khác index + file mới chưa add, GIỚI HẠN trong `paths`. */
const dangKhacIndexTrong = (paths) => {
  if (paths.length === 0) return [];
  return [
    ...goiGit(["diff", "--name-only", "--", ...paths]),
    ...goiGit(["ls-files", "--others", "--exclude-standard", "--", ...paths]),
  ];
};

/** `file` có thuộc danh sách sở hữu không — khớp đích danh, hoặc tiền tố kết thúc `/`. */
export const thuocSoHuu = (file, soHuu) =>
  soHuu.some((s) => (s.endsWith("/") ? file.startsWith(s) : file === s));

/** Rút danh sách file từ các dòng `DA_SUA <path>` mà generator va-tay in ra. */
export const layDaSua = (stdout) =>
  [...String(stdout ?? "").matchAll(/^DA_SUA (.+)$/gm)].map((m) => m[1].trim().replace(/\\/g, "/"));

/**
 * Tập file được phép tự stage. Thuần để test không đụng git.
 *
 * @param cacMuc [{ten, kieu: "may"|"va-tay", soHuu, thanhCong, daSua}]
 * @param dangKhacIndex Set — file đang khác index (chỉ cần phủ vùng soHuu)
 * @param banTruoc Set — file đã bẩn TRƯỚC khi Bước 1 chạy
 */
export function tinhTapStage(cacMuc, dangKhacIndex, banTruoc) {
  const stage = new Set();
  const boQua = [];
  for (const m of cacMuc) {
    if (!m.thanhCong) continue;
    if (m.kieu === "va-tay") {
      for (const f of m.daSua ?? []) {
        if (banTruoc.has(f)) boQua.push({ file: f, ten: m.ten });
        else stage.add(f);
      }
    } else {
      for (const f of dangKhacIndex) {
        if (thuocSoHuu(f, m.soHuu ?? [])) stage.add(f);
      }
    }
  }
  return { stage: [...stage].sort(), boQua };
}

/**
 * Staged diff có đụng migration không.
 *
 * `supabase/migrations-archive/` KHÔNG tính: nó là kho đã đóng băng, sửa ở đó
 * không đổi schema production nên không cần đo lại rò.
 */
export const dungMigration = (files) =>
  files.some((f) => f.startsWith("supabase/migrations/"));

/**
 * Bước 3 — đo rò chéo tổ chức (`scripts/measure-org-leak.mjs`) làm gì lượt này?
 *
 * Phép đo này chỉ chạy ở job `security-gates`, tức CHỈ sau khi đã push lên main
 * VÀ chỉ khi repo có SUPABASE_PAT. Người ngồi máy không có đường nào biết trước,
 * nên nó được kéo về đây. Nhưng nó cần mạng + credential, và một gate cần mạng
 * mà im lặng khi offline là gate nói dối theo hướng an toàn — đúng thứ chính
 * measure-org-leak.mjs cảnh báo ở đầu file nó.
 *
 * Nên ba lối ra, không phải hai:
 *   - có credential        → "chay"     (đo thật, exit 3 của nó vẫn là ⚠ riêng)
 *   - thiếu, không migration → "canh-bao" (⚠: offline không phải lỗi của code)
 *   - thiếu, CÓ migration    → "do"     (❌: đúng lúc phép đo có giá trị nhất)
 *
 * @returns "bo-qua" | "chay" | "canh-bao" | "do"
 */
export function quyetDinhDoRoOrg({ bat = true, coCredential = false, dungMigration: coMigration = false }) {
  if (!bat) return "bo-qua";
  if (coCredential) return "chay";
  return coMigration ? "do" : "canh-bao";
}

/**
 * Lock đã tồn tại là "song" (phải chờ) hay "stale" (chiếm được)?
 * Stale khi không đọc được hoặc pid đã chết. Không cướp lock sống theo tuổi.
 */
export function danhGiaLock(lock, pidConSong) {
  if (!lock || typeof lock.pid !== "number" || typeof lock.batDauMs !== "number") return "stale";
  if (!pidConSong(lock.pid)) return "stale";
  return "song";
}

// ── Lock: một worktree một lượt gate — hai phiên chạy đồng thời sẽ ghi đè
// artifact của nhau giữa chừng rồi cùng stage sai. Lock nằm trong git-dir CỦA
// WORKTREE (rev-parse --absolute-git-dir) nên hai worktree khác nhau vẫn chạy
// song song được — đúng mô hình mỗi-hạng-mục-một-worktree của Contract §3.
function chiemLock() {
  const gitDir = spawnSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: repoRoot, encoding: "utf8" })
    .stdout?.trim();
  if (!gitDir) return { loi: "không tìm được git-dir — đang đứng ngoài repo?" };
  const duong = join(gitDir, "gate-truoc-push.lock");
  const ghi = () => {
    const fd = openSync(duong, "wx");
    writeSync(fd, JSON.stringify({ pid: process.pid, batDauMs: Date.now() }));
    closeSync(fd);
  };
  try {
    ghi();
    return { duong };
  } catch {
    let lock = null;
    try { lock = JSON.parse(readFileSync(duong, "utf8")); } catch { /* hỏng ⇒ stale */ }
    const pidConSong = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    if (danhGiaLock(lock, pidConSong, Date.now()) === "song") {
      return {
        loi:
          `phiên khác đang chạy gate:truoc-push (pid ${lock.pid}, từ ${new Date(lock.batDauMs).toISOString()}).\n` +
          `   Chờ nó xong rồi chạy lại. Lock: ${duong} — chỉ xoá tay khi chắc chắn phiên kia đã chết.`,
      };
    }
    try { unlinkSync(duong); ghi(); return { duong }; } catch (e) {
      return { loi: `không chiếm được lock (${e.message})` };
    }
  }
}

const laLive = (gate) => gate?.evidenceClass === 'live';

/** `--live` thêm gate cần credential mà plan chọn; `--live --full` thêm mọi gate live đang hoạt động. */
export function selectLocalGates(plan, { full = false, live = false } = {}) {
  const tatCaLive = live && full ? Object.keys(GATE_REGISTRY).filter((id) => laLive(GATE_REGISTRY[id]) && !isDeferredGate(id)) : [];
  return [...new Set([...plan.gateIds, ...tatCaLive])].map((id) => getGate(id, plan))
    .filter((gate) => gate.local || (full && gate.id.startsWith('suite:') && gate.evidenceClass === 'static') || (live && laLive(gate)));
}

/**
 * Env cho gate live chạy ở máy: env có sẵn thắng, thiếu thì đọc vault qua resolver
 * của test-env (Contract §9). Giá trị chỉ vào env của tiến trình gate; thiếu thì
 * chỉ báo TÊN — không bao giờ in giá trị.
 */
export function credentialLive(env, vaultText = '') {
  const tuVault = (re) => re.exec(vaultText)?.[1] ?? null;
  const pat = env.SUPABASE_PAT || tuVault(/\b(sbp_[a-f0-9]{40})\b/);
  const them = {
    SUPABASE_PAT: pat,
    SUPABASE_ACCESS_TOKEN: env.SUPABASE_ACCESS_TOKEN || pat,
    SUPABASE_TEST_EMAIL: env.SUPABASE_TEST_EMAIL || tuVault(/Email:\s*`([^`]+)`/),
    SUPABASE_TEST_PASSWORD: env.SUPABASE_TEST_PASSWORD || tuVault(/Password:\s*`([^`]+)`/),
  };
  return Object.fromEntries(Object.entries(them).filter(([, value]) => value));
}

/** Diff đụng migration, bề mặt RPC hay file phân quyền ⇒ gợi ý `--live` trước khi lên main. */
export function goiYLive(plan, riskMap) {
  const mau = ['supabase/migrations/**', 'contracts/surfaces/**', ...(riskMap?.tiers?.authorization?.paths ?? [])];
  const paths = (plan.changedPaths ?? []).filter((path) => mau.some((glob) => khopGlob(path, glob)));
  const gates = plan.gateIds.filter((id) => laLive(GATE_REGISTRY[id]));
  return paths.length || gates.length ? { paths, gates } : null;
}

// Default preview is for a human/agent. The complete snapshot stays in JSON evidence.
export function summarizeGatePlan(plan) {
  return {
    snapshot: plan.snapshot, profiles: plan.profiles, fullFallback: plan.fullFallback,
    changedPaths: plan.changedPaths, reasons: plan.reasons, gateIds: plan.gateIds,
    gates: plan.gateIds.map((id) => { const gate = getGate(id, plan); return { id, command: gate.command, args: gate.args, local: gate.local, job: gate.job, evidenceClass: gate.evidenceClass, requires: gate.requires }; }),
    suites: plan.suiteSelections.map(({ id, runner, mode, files, viewports }) => ({ id, runner, mode, testFileCount: files.length, viewports })),
    generatorIds: plan.generatorIds, requiredJobs: plan.requiredJobs,
    requiredExternalWorkflows: plan.requiredExternalWorkflows, browserRequirements: plan.browserRequirements,
    unavailable: plan.unavailable, executionMismatches: plan.executionMismatches,
    deferred: 'Zalo/Copilot — không chạy và không tính là pass',
  };
}

function execute(gate, env = process.env) {
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const child = spawn(gate.command, gate.args, { cwd: repoRoot, env });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (data) => { stdout += data; });
    child.stderr.setEncoding('utf8').on('data', (data) => { stderr += data; });
    child.on('error', (error) => resolve({ status: 'blocked', exitCode: 3, stdout, stderr: error.message, startedAt, completedAt: new Date().toISOString() }));
    child.on('close', (code) => resolve({ status: code === 0 ? 'passed' : code === 3 ? 'blocked' : 'failed', exitCode: code ?? 3, stdout, stderr, startedAt, completedAt: new Date().toISOString() }));
  });
}

async function main() {
  const { planFromGit } = await import('./lib/gate-plan.mjs');
  const full = process.argv.includes('--full');
  const dry = process.argv.includes('--plan');
  const live = process.argv.includes('--live');
  const riskMap = JSON.parse(readFileSync(join(repoRoot, 'tooling/risk-map.json'), 'utf8'));
  let plan = planFromGit({ root: repoRoot, mode: 'staged', environment: 'local', full });
  if (dry) { console.log(JSON.stringify(process.argv.includes('--json') ? plan : { ...summarizeGatePlan(plan), goiYLive: goiYLive(plan, riskMap) }, null, 2)); return; }
  if (plan.unavailable?.length) { console.error('CHƯA KIỂM: ' + JSON.stringify(plan.unavailable)); process.exitCode = 3; return; }
  const lock = chiemLock();
  if (lock.loi) { console.error(lock.loi); process.exitCode = 3; return; }
  const release = () => { try { unlinkSync(lock.duong); } catch { /* already released */ } };
  process.once('exit', release);
  process.once('SIGINT', () => { release(); process.exit(130); });
  try {
    if (process.argv.includes('--khong-dao-strict') || process.argv.includes('--khong-do-ro-org')) {
      console.warn('Cờ cũ không hạ nghĩa vụ: bộ chọn quyết định gate cần chạy; phép kiểm CI chưa chạy không tính là đạt.');
    }
    let selected = selectLocalGates(plan, { full, live });
    const inputs = [...new Set([...selected.flatMap((gate) => gate.inputs), ...(plan.inputPaths ?? []), ...(plan.inputPatterns ?? [])])];
    const conflicts = indexInputConflicts(repoRoot, inputs);
    if (conflicts.length) { console.error('Đầu vào khác INDEX; stage đúng phần dự định trước khi kiểm:\n' + conflicts.join('\n')); process.exitCode = 3; return; }
    const before = new Set(goiGit(['diff', '--name-only']));
    const prepared = [];
    for (const id of plan.generatorIds) {
      const generator = GENERATOR_REGISTRY[id];
      if (!generator) throw new Error('Unknown generator: ' + id);
      if (generator.requires?.some((key) => !process.env[key])) {
        console.error('CHƯA KIỂM: generator ' + id + ' thiếu credential ' + generator.requires.filter((key) => !process.env[key]).join(', '));
        process.exitCode = 3; return;
      }
      const result = await execute(generator);
      if (result.status !== 'passed') { console.error(id + ': ' + result.stderr + result.stdout); process.exitCode = result.exitCode; return; }
      prepared.push({ ten: id, kieu: generator.patch ? 'va-tay' : 'may', soHuu: generator.owns ?? [], thanhCong: true, daSua: generator.patch ? layDaSua(result.stdout) : [] });
    }
    const owned = prepared.filter((g) => g.kieu === 'may').flatMap((g) => g.soHuu);
    const { stage, boQua } = tinhTapStage(prepared, new Set(dangKhacIndexTrong(owned)), before);
    if (boQua.length) { console.error('Không stage artifact lẫn sửa tay: ' + boQua.map((item) => item.file).join(', ')); process.exitCode = 3; return; }
    if (stage.length) {
      const added = spawnSync('git', ['add', '--', ...stage], { cwd: repoRoot, encoding: 'utf8' });
      if (added.status !== 0) throw new Error(added.stderr || 'Cannot stage owned artifacts');
    }
    // Generated inputs belong to this snapshot, not the plan from before preparation.
    plan = planFromGit({ root: repoRoot, mode: 'staged', environment: 'local', full });
    if (plan.unavailable?.length) { console.error('CHƯA KIỂM: ' + JSON.stringify(plan.unavailable)); process.exitCode = 3; return; }
    selected = selectLocalGates(plan, { full, live });
    const finalInputs = [...new Set([...selected.flatMap((gate) => gate.inputs), ...(plan.inputPaths ?? []), ...(plan.inputPatterns ?? [])])];
    const afterConflicts = indexInputConflicts(repoRoot, finalInputs);
    if (afterConflicts.length) { console.error('Đầu vào vẫn khác INDEX: ' + afterConflicts.join(', ')); process.exitCode = 3; return; }
    const runId = 'local-' + randomUUID();
    const cache = join(repoRoot, '.cache/gate-receipts'); mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
    console.log('Phạm vi: ' + plan.profiles.join(', ') + '; ' + selected.length + ' gate local; DEFERRED không tính pass.');
    const started = Date.now();
    let envLive = process.env;
    if (live) {
      const { docVault } = await import('./test-env/lib.mjs');
      envLive = { ...process.env, ...credentialLive(process.env, docVault()) };
    }
    const chayGate = (gate, env) => async () => {
      const receiptPath = join(cache, gate.id.replace(/[^a-z0-9-]/gi, '_') + '.json');
      let previous; try { previous = JSON.parse(readFileSync(receiptPath, 'utf8')); } catch { /* no receipt */ }
      if (previous && canReuseGateReceipt(previous, { gate, plan, runId, trustedRunIds: [previous.runId], runtime: { node: process.version } })) {
        return { id: gate.id, status: 'passed', reused: true };
      }
      const thieu = (gate.requires ?? []).filter((name) => !env[name]);
      if (thieu.length) return { id: gate.id, status: 'blocked', exitCode: 3, stdout: '', stderr: 'CHƯA KIỂM: thiếu credential ' + thieu.join(', ') + ' (env hoặc vault).\n' };
      const result = await execute(gate, env);
      const changedWhileRunning = indexInputConflicts(repoRoot, gate.inputs);
      if (changedWhileRunning.length) { result.status = 'blocked'; result.exitCode = 3; result.stderr += '\nInput changed during execution: ' + changedWhileRunning.join(', '); }
      const currentTree = spawnSync('git', ['write-tree'], { cwd: repoRoot, encoding: 'utf8' }).stdout?.trim();
      if (currentTree !== plan.snapshot.tree) { result.status = 'blocked'; result.exitCode = 3; result.stderr += '\nINDEX changed during execution'; }
      const receipt = createGateReceipt({ gate, plan, runId, ...result });
      writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
      return { id: gate.id, ...result };
    };
    const results = await chayGioiHan(selected.filter((gate) => !laLive(gate)).map((gate) => chayGate(gate, process.env)), soLuongSongSong(availableParallelism()));
    // Gate live gọi Management API: từng gate một để không chạm giới hạn tốc độ.
    results.push(...await chayGioiHan(selected.filter(laLive).map((gate) => chayGate(gate, envLive)), 1));
    // Chạy sau, một mình: test DOM hết giờ khi chạy chen với các gate song song.
    results.push({ id: 'vitest-related', ...await execute({ command: process.execPath, args: ['scripts/run-related-vitest.mjs', '--plan', join(cache, 'plan.json')] }) });
    const finalTree = spawnSync('git', ['write-tree'], { cwd: repoRoot, encoding: 'utf8' }).stdout?.trim();
    const finalConflicts = indexInputConflicts(repoRoot, finalInputs);
    if (finalTree !== plan.snapshot.tree || finalConflicts.length) {
      console.error('CHƯA KIỂM: đầu vào đổi trong lượt chạy: ' + (finalTree !== plan.snapshot.tree ? 'INDEX; ' : '') + finalConflicts.join(', '));
      process.exitCode = 3;
    }
    for (const result of results) {
      // Vitest liên quan có thể không có gì để chạy — in phạm vi để "xanh" không bị đọc nhầm.
      const phamVi = result.id === 'vitest-related' ? (String(result.stdout ?? '').replace(/\x1b\[[0-9;]*m/g, '').match(/Vitest liên quan[^\n]*|Test Files[^\n]*/g) ?? []).map((s) => s.trim()).join('; ') : '';
      console.log((result.status === 'passed' ? '✅ ' : '❌ ') + result.id + (result.reused ? ' (dùng lại biên nhận đúng đầu vào)' : '') + (phamVi ? ` (${phamVi})` : ''));
      if (result.status !== 'passed') console.error(result.stdout + result.stderr);
    }
    const requiredOnCi = plan.gateIds.filter((id) => !selected.some((gate) => gate.id === id));
    if (plan.browserRequirements?.length) console.log('KIỂM UI CẦN BẰNG CHỨNG RIÊNG (gate kỹ thuật không xác nhận giao diện): ' + JSON.stringify(plan.browserRequirements));
    if (requiredOnCi.length) console.log('CHƯA KIỂM ở local — CI chịu trách nhiệm: ' + requiredOnCi.join(', '));
    const goiY = live ? null : goiYLive(plan, riskMap);
    if (goiY) {
      console.log('GỢI Ý: diff đụng ' + (goiY.paths.length ? goiY.paths.join(', ') : 'phạm vi cần gate live') + '.');
      console.log('   `npm run gate:truoc-push -- --live` chạy ' + (goiY.gates.length || 'các') + ' gate cần credential ngay trên máy (credential từ env/vault), thay vì chờ main đỏ.');
    }
    console.log('Local: ' + results.filter((r) => r.status === 'passed').length + '/' + results.length + ' đạt, ' + Math.round((Date.now() - started) / 1000) + 's. Phát hành vẫn cần CI của đúng commit.');
    if (results.some((r) => r.status !== 'passed')) process.exitCode = results.some((r) => r.status === 'failed') ? 1 : 3;
  } finally { release(); process.removeListener('exit', release); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(`❌ gate:truoc-push hỏng giữa chừng: ${e?.stack ?? e}`);
    process.exitCode = 1;
  });
}
