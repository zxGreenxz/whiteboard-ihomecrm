#!/usr/bin/env node
// Chạy các spec fleet E2E mà gate đòi bằng chứng live, rồi ghi BIÊN NHẬN để
// CI/gate-aggregate/promote nhận mà không cần credential.
//
//   FLEET_BASE_URL=<web TEST> FLEET_TARGET_ENV=TEST npm run with-cred -- npm run e2e:fleet:bien-nhan
//   npm run e2e:fleet:bien-nhan -- --plan                 # chỉ in danh sách spec bắt buộc
//   npm run e2e:fleet:bien-nhan -- --base origin/main     # mặc định origin/production
//   npm run e2e:fleet:bien-nhan -- --spec .e2e-fleet/specs/x.spec.ts   # chạy thêm spec
//
// Tập spec bắt buộc lấy từ chính bộ lập kế hoạch gate trên dải <base>..HEAD (mặc định
// production..HEAD — đúng dải mà CI main và promote sẽ plan). Biên nhận chỉ được ghi
// khi MỌI spec đạt, cây `.e2e-fleet/` sạch và không đổi trong lúc chạy. Không ghi
// token/mật khẩu/tiêu đề test: chỉ số đếm theo file, origin đích, commit và tree.
//
// Thoát 0 đã ghi biên nhận (hoặc không có gì phải chạy) · 1 có spec không đạt · 3 không chạy được.

import { spawnSync, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planFromGit } from './lib/gate-plan.mjs';
import { khopGlob } from './check-risk-classifier.mjs';
import { isDeferredTest } from './lib/deferred-modules.mjs';
import {
  FLEET_ROOT, LIVE_BROWSER_OBLIGATION, LOCAL_E2E_EVIDENCE_DIR, LOCAL_E2E_SUITES, classifyTarget,
  createLocalE2eReceipt, gitFleetResolver, summarizePlaywrightReport, validateLocalE2eReceipt,
} from './lib/gate-e2e-local-evidence.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
// Ném thay vì process.exit để khối finally dọn thư mục tạm.
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

function fleetDirty() {
  return git('status', '--porcelain', '--untracked-files=all', '--', FLEET_ROOT).trim();
}

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

function main() {
  const opts = args(process.argv.slice(2));
  const head = git('rev-parse', '--verify', 'HEAD^{commit}').trim();
  const baseSha = git('rev-parse', '--verify', `${opts.base}^{commit}`).trim();
  const files = requiredSpecs(baseSha, opts.specs);
  if (opts.plan) { console.log(JSON.stringify({ head, base: { ref: opts.base, sha: baseSha }, specs: files }, null, 2)); return; }
  if (!files.length) { console.log(`Dải ${opts.base}..HEAD không có spec fleet nào cần bằng chứng live; không ghi biên nhận.`); return; }

  if (process.env.FLEET_TARGET_ENV !== 'TEST') stop('Đặt FLEET_TARGET_ENV=TEST: biên nhận chỉ hợp lệ cho lượt chạy trên môi trường TEST.');
  const target = classifyTarget(process.env.FLEET_BASE_URL);
  if (!target) stop('FLEET_BASE_URL phải là web Preview nhánh test-env (https://ihomecrm-git-test-env-….vercel.app) hoặc dev server loopback trỏ TEST.');
  if (process.env.EXPECTED_SOURCE_SHA && process.env.EXPECTED_SOURCE_SHA !== head) stop('EXPECTED_SOURCE_SHA khác HEAD; checkout đúng commit cần kiểm.');
  if (fleetDirty()) stop(`${FLEET_ROOT}/ có thay đổi chưa commit; commit (hoặc bỏ) trước khi chạy để byte chạy = byte trong biên nhận.`);
  const { fleetTreeOf, resolveCommit } = gitFleetResolver(git, head);
  const fleetTree = fleetTreeOf(head);
  if (!fleetTree) stop(`HEAD không có ${FLEET_ROOT}/`);

  const temp = mkdtempSync(join(tmpdir(), 'ihomecrm-fleet-receipt-'));
  const report = join(temp, 'report.json');
  try {
    console.log(`Chạy ${files.length} spec fleet trên ${target.origin} (commit ${head.slice(0, 12)}):\n${files.map((f) => `  - ${f}`).join('\n')}`);
    const startedAt = new Date().toISOString();
    const cli = join(root, 'node_modules', '@playwright', 'test', 'cli.js');
    if (!existsSync(cli)) stop('Thiếu node_modules/@playwright/test; chạy npm ci trước.');
    const run = spawnSync(process.execPath, [cli, 'test', '--config', `${FLEET_ROOT}/playwright.config.ts`, ...files, '--reporter=list,json', '--retries=0'], {
      cwd: root, stdio: 'inherit',
      env: { ...process.env, EXPECTED_SOURCE_SHA: head, PLAYWRIGHT_JSON_OUTPUT_NAME: report, PLAYWRIGHT_JSON_OUTPUT_FILE: report },
    });
    const completedAt = new Date().toISOString();
    if (git('rev-parse', 'HEAD').trim() !== head || fleetDirty() || fleetTreeOf(head) !== fleetTree) stop('HEAD hoặc .e2e-fleet/ đổi trong lúc chạy; không ghi biên nhận.');
    if (!existsSync(report)) stop(`Playwright không ghi report JSON (exit ${run.status}); không ghi biên nhận.`);
    const parsed = JSON.parse(readFileSync(report, 'utf8'));
    const specs = summarizePlaywrightReport(parsed);
    const missing = files.filter((f) => !specs.some((s) => s.file === f));
    const red = specs.filter((s) => s.tests < 1 || s.passed !== s.tests);
    const receipt = createLocalE2eReceipt({ commit: head, fleetTree, target, runner: { node: process.version, playwright: String(parsed?.config?.version ?? 'unknown') }, runId: randomUUID(), startedAt, completedAt, specs });
    const checked = validateLocalE2eReceipt(receipt, { planFleetTree: fleetTree, resolveCommit });
    if (run.status !== 0 || missing.length || red.length || !checked.valid) {
      const lines = [`KHÔNG ĐẠT — không ghi biên nhận (exit ${run.status}).`,
        ...missing.map((f) => `  - chưa chạy: ${f}`),
        ...red.map((s) => `  - ${s.file}: ${s.passed}/${s.tests} đạt, ${s.failed} đỏ, ${s.skipped} skip, ${s.flaky} flaky`),
        ...checked.problems.map((p) => `  - ${p}`)];
      stop(lines.join('\n'), 1);
    }
    const dir = join(root, LOCAL_E2E_EVIDENCE_DIR);
    mkdirSync(dir, { recursive: true });
    const name = `${completedAt.slice(0, 10)}-${head.slice(0, 12)}-${receipt.runId.slice(0, 8)}.json`;
    writeFileSync(join(dir, name), JSON.stringify(receipt, null, 2) + '\n');
    console.log(`\nĐẠT ${specs.length} spec. Biên nhận: ${LOCAL_E2E_EVIDENCE_DIR}/${name}`);
    console.log(`Tiếp theo: git add -- ${LOCAL_E2E_EVIDENCE_DIR}/${name} rồi commit; KHÔNG sửa ${FLEET_ROOT}/ sau đó (biên nhận gắn tree ${fleetTree.slice(0, 12)}).`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

try { main(); } catch (error) {
  if (!(error instanceof Stop)) throw error;
  console.error(error.message);
  process.exitCode = error.code;
}
