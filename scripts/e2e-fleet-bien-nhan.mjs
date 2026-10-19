#!/usr/bin/env node
// Chạy các spec fleet E2E mà gate đòi bằng chứng live, rồi ghi BIÊN NHẬN để
// CI/gate-aggregate/promote nhận mà không cần credential. Biên nhận CHỈ được sinh
// bằng runner này (Contract §3); viết hay sửa tay là làm giả bằng chứng.
//
//   FLEET_BASE_URL=<web TEST> FLEET_TARGET_ENV=TEST npm run with-cred -- npm run e2e:fleet:bien-nhan
//   npm run e2e:fleet:bien-nhan -- --plan                 # chỉ in danh sách spec bắt buộc
//   npm run e2e:fleet:bien-nhan -- --base origin/main     # mặc định origin/production
//   npm run e2e:fleet:bien-nhan -- --spec .e2e-fleet/specs/x.spec.ts   # chạy thêm spec
//
// Tập spec bắt buộc lấy từ chính bộ lập kế hoạch gate trên dải <base>..HEAD (mặc định
// production..HEAD — đúng dải mà CI main và promote sẽ plan). Trước khi chạy:
//   - TOÀN BỘ cây làm việc phải sạch (không sửa, không staged, không untracked) để
//     commit = HEAD trong biên nhận đúng là byte đã chạy;
//   - đích phải thật sự dùng Supabase TEST: đọc ref từ HTML/JS của đích, lệch ⇒ dừng.
// Sau khi chạy luôn ghi biên nhận (xanh hoặc ĐỎ) nếu có report; biên nhận đỏ cùng tree
// làm gate chặn. Report Playwright (có thể chứa dữ liệu nhạy cảm) giữ NGOÀI repo ở
// FLEET_REPORT_DIR (mặc định ~/ihomecrm-backups/e2e-fleet-reports); biên nhận chỉ mang sha256.
//
// Thoát 0 biên nhận xanh (hoặc không có gì phải chạy) · 1 có spec không đạt · 3 không chạy được.

import { spawnSync, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planFromGit } from './lib/gate-plan.mjs';
import { khopGlob } from './check-risk-classifier.mjs';
import { isDeferredTest } from './lib/deferred-modules.mjs';
import {
  FLEET_ROOT, LIVE_BROWSER_OBLIGATION, LOCAL_E2E_EVIDENCE_DIR, LOCAL_E2E_SUITES, classifyTarget,
  createLocalE2eReceipt, gitFleetResolver, summarizePlaywrightReport, validateLocalE2eReceipt,
} from './lib/gate-e2e-local-evidence.mjs';
import { dirtyEntries, probeTarget, verifyTestTarget } from './lib/e2e-fleet-runner.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
// Ném thay vì process.exit để lỗi được báo gọn và mã thoát giữ đúng hợp đồng.
class Stop extends Error { constructor(message, code) { super(message); this.code = code; } }
const stop = (message, code = 3) => { throw new Stop(message, code); };

function args(argv) {
  const out = { base: 'origin/production', specs: [], plan: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--plan') out.plan = true;
    else if (argv[i] === '--base') out.base = argv[++i];
    else if (argv[i] === '--spec') out.specs.push(String(argv[++i] ?? '').replace(/\\/g, '/'));
    else stop(`Tham số không hiểu: ${argv[i]}`);
  }
  if (!out.base) stop('--base cần một ref');
  return out;
}

const dirty = () => dirtyEntries(git('status', '--porcelain', '--untracked-files=all'));
// Tên git (không lấy email: repo PUBLIC). Thiếu cấu hình thì ghi rõ là không biết.
const gitUserName = () => { try { return git('config', 'user.name').trim() || 'unknown'; } catch { return 'unknown'; } };

function requiredSpecs(base, extra) {
  const plan = planFromGit({ root, mode: 'commit', base, head: 'HEAD', environment: 'local', localEvidence: false });
  const files = new Set(plan.unavailable.filter((u) => LOCAL_E2E_SUITES.includes(u?.suiteId) && u.kind === LIVE_BROWSER_OBLIGATION).flatMap((u) => u.files));
  const matrix = JSON.parse(git('show', 'HEAD:tooling/test-matrix.json'));
  const suite = matrix.suites.find((s) => s.id === 'e2e-fleet');
  for (const file of extra) {
    const owned = suite && suite.includes.some((g) => khopGlob(file, g)) && !(suite.excludes ?? []).some((g) => khopGlob(file, g));
    if (!owned || isDeferredTest(file)) stop(`${file} không thuộc suite e2e-fleet đang hoạt động`);
    try { git('cat-file', '-e', `HEAD:${file}`); } catch { stop(`${file} không có trong HEAD`); }
    files.add(file);
  }
  return [...files].sort();
}

async function fetchText(url) {
  // Chìa bypass Vercel chỉ gửi tới chính host đích (cùng origin), không bao giờ ghi ra đâu.
  const headers = process.env.VERCEL_AUTOMATION_BYPASS_SECRET ? { 'x-vercel-protection-bypass': process.env.VERCEL_AUTOMATION_BYPASS_SECRET } : {};
  const response = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function main() {
  const opts = args(process.argv.slice(2));
  const head = git('rev-parse', '--verify', 'HEAD^{commit}').trim();
  let baseSha;
  try { baseSha = git('rev-parse', '--verify', `${opts.base}^{commit}`).trim(); } catch { stop(`Không phân giải được ${opts.base}; chạy git fetch origin production (hoặc truyền --base).`); }
  const files = requiredSpecs(baseSha, opts.specs);
  if (opts.plan) { console.log(JSON.stringify({ head, base: { ref: opts.base, sha: baseSha }, specs: files }, null, 2)); return; }
  if (!files.length) { console.log(`Dải ${opts.base}..HEAD không có spec fleet nào cần bằng chứng live; không ghi biên nhận.`); return; }

  if (process.env.FLEET_TARGET_ENV !== 'TEST') stop('Đặt FLEET_TARGET_ENV=TEST: biên nhận chỉ hợp lệ cho lượt chạy trên môi trường TEST.');
  const target = classifyTarget(process.env.FLEET_BASE_URL);
  if (!target) stop('FLEET_BASE_URL phải là web Preview nhánh test-env (https://ihomecrm-git-test-env-zxgreenxzs-projects.vercel.app) hoặc dev server loopback trỏ TEST.');
  if (process.env.EXPECTED_SOURCE_SHA && process.env.EXPECTED_SOURCE_SHA !== head) stop('EXPECTED_SOURCE_SHA khác HEAD; checkout đúng commit cần kiểm.');
  const before = dirty();
  if (before.length) stop(`Cây làm việc chưa sạch (${before.length} mục, vd ${before[0]}); commit/bỏ hết — kể cả file untracked hay biên nhận chưa commit — rồi chạy lại.`);
  const { fleetTreeOf, resolveCommit } = gitFleetResolver(git, head);
  const fleetTree = fleetTreeOf(head);
  if (!fleetTree) stop(`HEAD không có ${FLEET_ROOT}/`);

  const probe = await probeTarget({ origin: target.origin, fetchText });
  const verdict = verifyTestTarget(probe);
  if (!verdict.ok) stop(`${verdict.problem} (đã đọc ${probe.filesScanned} file từ ${target.origin})`);
  console.log(`Đích ${target.origin} dùng Supabase TEST (${verdict.ref}); build-sha: ${probe.buildSha ?? 'không đọc được'}.`);

  const runId = randomUUID();
  const reportDir = resolve(process.env.FLEET_REPORT_DIR || join(homedir(), 'ihomecrm-backups', 'e2e-fleet-reports'));
  const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  if (fold(reportDir) === fold(root) || fold(reportDir).startsWith(fold(root) + (process.platform === 'win32' ? '\\' : '/'))) stop('FLEET_REPORT_DIR phải nằm ngoài repo: report có thể chứa dữ liệu nhạy cảm.');
  mkdirSync(reportDir, { recursive: true });
  const report = join(reportDir, `${runId}.json`);
  console.log(`Chạy ${files.length} spec fleet trên ${target.origin} (commit ${head.slice(0, 12)}):\n${files.map((f) => `  - ${f}`).join('\n')}`);
  const startedAt = new Date().toISOString();
  const cli = join(root, 'node_modules', '@playwright', 'test', 'cli.js');
  if (!existsSync(cli)) stop('Thiếu node_modules/@playwright/test; chạy npm ci trước.');
  const run = spawnSync(process.execPath, [cli, 'test', '--config', `${FLEET_ROOT}/playwright.config.ts`, ...files, '--reporter=list,json', '--retries=0'], {
    cwd: root, stdio: 'inherit',
    env: { ...process.env, EXPECTED_SOURCE_SHA: head, PLAYWRIGHT_JSON_OUTPUT_NAME: report, PLAYWRIGHT_JSON_OUTPUT_FILE: report },
  });
  const completedAt = new Date().toISOString();
  const after = dirty();
  if (git('rev-parse', 'HEAD').trim() !== head || after.length || fleetTreeOf(head) !== fleetTree) stop(`HEAD hoặc cây làm việc đổi trong lúc chạy${after.length ? ` (vd ${after[0]})` : ''}; không ghi biên nhận.`);
  if (!existsSync(report)) stop(`Playwright không ghi report JSON (exit ${run.status}); không ghi biên nhận.`);
  const reportBytes = readFileSync(report);
  const parsed = JSON.parse(reportBytes.toString('utf8'));
  const specs = summarizePlaywrightReport(parsed);
  const missing = files.filter((f) => !specs.some((s) => s.file === f));
  const red = specs.filter((s) => s.tests < 1 || s.passed !== s.tests);
  const receipt = createLocalE2eReceipt({
    commit: head, fleetTree, target, targetSupabaseRef: verdict.ref, targetBuildSha: probe.buildSha,
    actor: { gitUser: gitUserName(), host: hostname() || 'unknown' },
    reportSha256: createHash('sha256').update(reportBytes).digest('hex'),
    runner: { node: process.version, playwright: String(parsed?.config?.version ?? 'unknown') }, runId, startedAt, completedAt, specs,
    runOk: run.status === 0 && missing.length === 0,
  });
  const checked = validateLocalE2eReceipt(receipt, { planFleetTree: fleetTree, resolveCommit });
  const dir = join(root, LOCAL_E2E_EVIDENCE_DIR);
  mkdirSync(dir, { recursive: true });
  const name = `${completedAt.slice(0, 10)}-${head.slice(0, 12)}-${runId.slice(0, 8)}.json`;
  writeFileSync(join(dir, name), JSON.stringify(receipt, null, 2) + '\n');
  console.log(`\nReport (ngoài repo, không commit): ${report}`);
  console.log(`Biên nhận: ${LOCAL_E2E_EVIDENCE_DIR}/${name}`);
  if (receipt.status !== 'passed' || !checked.valid) {
    const lines = [`KHÔNG ĐẠT (exit ${run.status}) — đã ghi biên nhận ĐỎ; gate sẽ chặn tree ${fleetTree.slice(0, 12)} của .e2e-fleet/.`,
      ...missing.map((f) => `  - chưa chạy: ${f}`),
      ...red.map((s) => `  - ${s.file}: ${s.passed}/${s.tests} đạt, ${s.failed} đỏ, ${s.skipped} skip, ${s.flaky} flaky`),
      ...(receipt.status === 'passed' ? checked.problems.map((p) => `  - ${p}`) : []),
      `Commit biên nhận đỏ này (git add -- ${LOCAL_E2E_EVIDENCE_DIR}/${name}); xoá nó để chạy lại là che lượt đỏ. Sửa spec/app rồi chạy lại.`];
    stop(lines.join('\n'), 1);
  }
  console.log(`ĐẠT ${specs.length} spec. Tiếp theo: git add -- ${LOCAL_E2E_EVIDENCE_DIR}/${name} rồi commit riêng; KHÔNG sửa ${FLEET_ROOT}/ sau đó (biên nhận gắn tree ${fleetTree.slice(0, 12)}).`);
}

try { await main(); } catch (error) {
  if (!(error instanceof Stop)) throw error;
  console.error(error.message);
  process.exitCode = error.code;
}
