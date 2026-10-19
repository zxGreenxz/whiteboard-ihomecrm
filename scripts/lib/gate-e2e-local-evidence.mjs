// Biên nhận E2E fleet chạy LOCAL — đường duy nhất để nghĩa vụ "Live browser
// evidence" của suite e2e-fleet được coi là thoả trên CI/promote.
//
// VÌ SAO
//   Fleet E2E cần credential + môi trường TEST nên chỉ chạy được ở máy chủ dự án.
//   Trước đây đổi một spec `.e2e-fleet/specs/**` là mọi plan production..HEAD báo
//   "Unverifiable required obligation: e2e-fleet" và chặn MỌI promote, kể cả khi
//   spec đã chạy xanh ở local. Biên nhận này mang kết quả lượt chạy đó vào repo.
//
// HỢP ĐỒNG (fail-closed)
//   - Biên nhận CHỈ do `npm run e2e:fleet:bien-nhan` sinh (Contract §3); cấm viết tay.
//   - Gắn commit đủ 40 ký tự VÀ tree hash của `.e2e-fleet/` tại commit đó. Commit phải
//     tồn tại, là tổ tiên (hoặc chính) đầu plan, và tree của nó phải đúng tree khai —
//     giả SHA hay giả tree đều bị loại. Runner chỉ ghi khi TOÀN BỘ cây làm việc sạch.
//   - Tree `.e2e-fleet/` của snapshot đang plan phải BẰNG tree trong biên nhận: đổi bất
//     kỳ byte nào trong fleet sau lượt chạy ⇒ biên nhận vô hiệu, phải chạy lại.
//   - Đích phải là project Supabase TEST: runner đọc ref thật từ HTML/JS của đích trước
//     khi chạy (targetSupabaseRef); gate chỉ nhận ref TEST.
//   - Mỗi spec trong biên nhận phải đạt hết (≥1 test, không failed/skipped/flaky); một
//     biên nhận ở đúng tree hiện tại có spec bắt buộc bị đỏ thì CHẶN, kể cả khi có biên
//     nhận xanh khác. Runner ghi cả biên nhận đỏ.
//   - Chỉ suite trong LOCAL_E2E_SUITES được nhận; mọi nghĩa vụ khác giữ nguyên.
//   - Khoá của biên nhận là danh sách trắng: không chỗ nào để nhét token/mật khẩu/dữ liệu
//     khách; đích chỉ ghi origin (không path/query); report Playwright giữ ngoài repo,
//     biên nhận chỉ mang sha256 của nó.
//
// Biên nhận KHÔNG chứng minh bản app ở FLEET_BASE_URL dựng từ đúng commit (targetBuildSha
// chỉ ghi lại, có thể null), và số đếm do máy chạy tự khai (không ký) — xem rủi ro ở
// docs/CODEBASE_STRUCTURE.md.

import { isDeferredTest } from './deferred-modules.mjs';

export const LOCAL_E2E_EVIDENCE_DIR = 'docs/generated/e2e-fleet-evidence';
export const LOCAL_E2E_SUITES = Object.freeze(['e2e-fleet']);
export const FLEET_ROOT = '.e2e-fleet';
export const RECEIPT_KIND = 'e2e-fleet-local-receipt';
export const LIVE_BROWSER_OBLIGATION = 'live-browser';
// Project ref công khai (đã có trong .e2e-fleet/specs/moi-truong-test.spec.ts và
// src/lib/appEnvironment.ts); không phải credential.
export const TEST_SUPABASE_REF = 'hzulujxgonszuleqticb';
export const PROD_SUPABASE_REF = 'tryymsxyyckgbrmmvozx';

const HASH = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SPEC = /^\.e2e-fleet\/specs\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.spec\.ts$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LABEL = /^[^\u0000-\u001f\u007f]{1,100}$/;
const TOP_KEYS = ['actor', 'commit', 'completedAt', 'environment', 'fleetTree', 'kind', 'reportSha256', 'runId', 'runner', 'schemaVersion', 'specs', 'startedAt', 'status', 'suiteId', 'target', 'targetBuildSha', 'targetSupabaseRef'];
const SPEC_KEYS = ['failed', 'file', 'flaky', 'passed', 'skipped', 'tests'];
const RUNNER_KEYS = ['node', 'playwright'];
const TARGET_KEYS = ['kind', 'origin'];
const ACTOR_KEYS = ['gitUser', 'host'];
// Web Preview nhánh test-env (host thật, ghim cả team slug) hoặc dev server loopback.
// Origin chỉ là lớp đầu; lớp quyết định là targetSupabaseRef đọc từ chính đích.
export const TARGETS = Object.freeze({
  'test-env-preview': /^https:\/\/ihomecrm-git-test-env-zxgreenxzs-projects\.vercel\.app$/,
  loopback: /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d{2,5}$/,
});

const sameKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const count = (n) => Number.isInteger(n) && n >= 0;
const specPassed = (s) => s.tests > 0 && s.passed === s.tests && !s.failed && !s.skipped && !s.flaky;

/** Origin của FLEET_BASE_URL nếu nó là đích TEST được chấp nhận; ngược lại null. */
export function classifyTarget(baseUrl) {
  let origin;
  try { origin = new URL(String(baseUrl)).origin; } catch { return null; }
  for (const [kind, pattern] of Object.entries(TARGETS)) if (pattern.test(origin)) return { kind, origin };
  return null;
}

/**
 * Đếm kết quả theo file từ report JSON của Playwright. Chỉ giữ số đếm — tiêu đề,
 * lỗi, attachment (có thể mang mật khẩu DEMO/TEST) không bao giờ rời hàm này.
 * Lưu ý: `test.describe.configure({ retries })` thắng `--retries=0`, và Playwright vẫn
 * thoát 0 khi có test flaky/skip — nên trạng thái từng test mới là căn cứ.
 */
export function summarizePlaywrightReport(report) {
  const byFile = new Map();
  const visit = (suite) => {
    for (const spec of suite.specs ?? []) {
      const file = `${FLEET_ROOT}/specs/${String(spec.file ?? suite.file ?? '').replace(/\\/g, '/').replace(/^specs\//, '')}`;
      const row = byFile.get(file) ?? { file, tests: 0, passed: 0, failed: 0, skipped: 0, flaky: 0 };
      for (const test of spec.tests ?? []) {
        row.tests++;
        const results = test.results ?? [];
        if (test.status === 'skipped' || results.some((r) => r.status === 'skipped')) row.skipped++;
        else if (test.status === 'flaky') row.flaky++;
        else if (test.status === 'expected' && results.length > 0 && results.every((r) => r.status === 'passed')) row.passed++;
        else row.failed++;
      }
      byFile.set(file, row);
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report?.suites ?? []) visit(suite);
  return [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file));
}

/** `runOk=false` (exit khác 0, thiếu spec…) luôn cho biên nhận đỏ, kể cả khi các dòng đều xanh. */
export function createLocalE2eReceipt({ commit, fleetTree, target, targetSupabaseRef, targetBuildSha = null, actor, reportSha256, runner, runId, startedAt, completedAt, specs, runOk = true }) {
  const allPassed = runOk === true && specs.length > 0 && specs.every(specPassed);
  return {
    schemaVersion: 1, kind: RECEIPT_KIND, suiteId: 'e2e-fleet', status: allPassed ? 'passed' : 'failed',
    commit, fleetTree, environment: 'TEST', target: { kind: target.kind, origin: target.origin },
    targetSupabaseRef, targetBuildSha: targetBuildSha ?? null,
    actor: { gitUser: String(actor.gitUser), host: String(actor.host) }, reportSha256,
    runner: { node: String(runner.node), playwright: String(runner.playwright) }, runId, startedAt, completedAt,
    specs: specs.map(({ file, tests, passed, failed, skipped, flaky }) => ({ file, tests, passed, failed, skipped, flaky })),
  };
}

/**
 * Kiểm một biên nhận, độc lập với tập spec bắt buộc.
 * resolveCommit(sha) → { fleetTree, committedAt (ms), isAncestor } | null — do git của
 * snapshot đang plan trả lời, không tin trường nào trong biên nhận. Biên nhận khác tree
 * đã vô hiệu nên không tốn tiến trình git cho nó.
 */
export function validateLocalE2eReceipt(receipt, { planFleetTree, resolveCommit, now = Date.now() } = {}) {
  const problems = []; const failedFiles = [];
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return { valid: false, problems: ['Receipt is not an object'], failedFiles };
  if (!sameKeys(receipt, TOP_KEYS)) problems.push('Unexpected or missing receipt fields');
  if (receipt.schemaVersion !== 1 || receipt.kind !== RECEIPT_KIND) problems.push('Unsupported receipt schema');
  if (!LOCAL_E2E_SUITES.includes(receipt.suiteId)) problems.push('Suite does not accept local evidence');
  if (receipt.status !== 'passed') problems.push(`Run did not pass (${receipt.status})`);
  if (receipt.environment !== 'TEST') problems.push('Environment must be TEST');
  if (!sameKeys(receipt.target, TARGET_KEYS) || !TARGETS[receipt.target.kind]?.test(receipt.target.origin)) problems.push('Target is not an accepted TEST origin');
  if (receipt.targetSupabaseRef !== TEST_SUPABASE_REF) problems.push('Target Supabase project is not TEST');
  if (receipt.targetBuildSha !== null && !(typeof receipt.targetBuildSha === 'string' && SHA40.test(receipt.targetBuildSha))) problems.push('Invalid target build SHA');
  if (!sameKeys(receipt.actor, ACTOR_KEYS) || ACTOR_KEYS.some((k) => typeof receipt.actor[k] !== 'string' || !LABEL.test(receipt.actor[k]))) problems.push('Invalid actor');
  if (typeof receipt.reportSha256 !== 'string' || !SHA256.test(receipt.reportSha256)) problems.push('Invalid report digest');
  if (!sameKeys(receipt.runner, RUNNER_KEYS) || RUNNER_KEYS.some((k) => typeof receipt.runner[k] !== 'string' || receipt.runner[k].length > 40)) problems.push('Invalid runner identity');
  if (typeof receipt.runId !== 'string' || !UUID.test(receipt.runId)) problems.push('Invalid run id');
  const started = Date.parse(receipt.startedAt); const completed = Date.parse(receipt.completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started || completed > now) problems.push('Invalid receipt timestamps');
  if (!Array.isArray(receipt.specs) || receipt.specs.length === 0) problems.push('No executed specs');
  else {
    const seen = new Set();
    for (const spec of receipt.specs) {
      if (!sameKeys(spec, SPEC_KEYS) || typeof spec.file !== 'string' || !SPEC.test(spec.file) || isDeferredTest(spec.file) || seen.has(spec.file) ||
        !SPEC_KEYS.filter((k) => k !== 'file').every((k) => count(spec[k]))) { problems.push('Invalid spec row'); continue; }
      seen.add(spec.file);
      if (!(spec.tests >= 1 && spec.passed === spec.tests && !spec.failed && !spec.skipped && !spec.flaky)) {
        failedFiles.push(spec.file); problems.push(`Spec did not fully pass: ${spec.file}`);
      }
    }
  }
  const hashes = typeof receipt.commit === 'string' && HASH.test(receipt.commit) && typeof receipt.fleetTree === 'string' && HASH.test(receipt.fleetTree);
  if (!hashes) problems.push('Commit/tree must be full hashes');
  const sameTree = Boolean(planFleetTree) && receipt.fleetTree === planFleetTree;
  if (!sameTree) problems.push('Fleet tree changed after the run');
  if (hashes && sameTree) {
    let resolved = null;
    try { resolved = resolveCommit?.(receipt.commit) ?? null; } catch { resolved = null; }
    if (!resolved) problems.push('Receipt commit not found');
    else {
      if (resolved.fleetTree !== receipt.fleetTree) problems.push('Receipt tree does not belong to its commit');
      if (resolved.isAncestor !== true) problems.push('Receipt commit is not an ancestor of the planned head');
      if (!Number.isFinite(resolved.committedAt) || !Number.isFinite(started) || started < resolved.committedAt) problems.push('Run started before its commit existed');
    }
  }
  return { valid: problems.length === 0, problems, failedFiles };
}

// Chẩn đoán: biên nhận cùng tree trước, rồi mới nhất trước — kho chỉ tăng, tên theo ngày.
const newestFirst = (planFleetTree) => (a, b) =>
  Number(b.receipt?.fleetTree === planFleetTree) - Number(a.receipt?.fleetTree === planFleetTree) ||
  String(b.receipt?.completedAt ?? '').localeCompare(String(a.receipt?.completedAt ?? '')) || b.path.localeCompare(a.path);

/**
 * Thay nghĩa vụ live-browser của suite cho phép bằng biên nhận hợp lệ. Trả plan mới;
 * nghĩa vụ không thoả giữ nguyên trong `unavailable` kèm chẩn đoán.
 */
export function applyLocalE2eEvidence(plan, { receipts = [], planFleetTree, resolveCommit, now = Date.now() } = {}) {
  const remaining = []; const accepted = [];
  const checked = receipts.map(({ path, receipt }) => ({ path, receipt, result: validateLocalE2eReceipt(receipt, { planFleetTree, resolveCommit, now }) }))
    .sort(newestFirst(planFleetTree));
  for (const obligation of plan.unavailable ?? []) {
    const eligible = obligation && typeof obligation === 'object' && LOCAL_E2E_SUITES.includes(obligation.suiteId) &&
      obligation.kind === LIVE_BROWSER_OBLIGATION && Array.isArray(obligation.files) && obligation.files.length > 0;
    if (!eligible) { remaining.push(obligation); continue; }
    const red = checked.filter((c) => planFleetTree && c.receipt?.fleetTree === planFleetTree && c.result.failedFiles.some((f) => obligation.files.includes(f)));
    const valid = checked.filter((c) => c.result.valid && c.receipt.suiteId === obligation.suiteId);
    const covered = new Set(valid.flatMap((c) => c.receipt.specs.map((s) => s.file)));
    const missing = obligation.files.filter((f) => !covered.has(f));
    if (!red.length && !missing.length) {
      accepted.push({ suiteId: obligation.suiteId, files: [...obligation.files], fleetTree: planFleetTree,
        receipts: valid.filter((c) => c.receipt.specs.some((s) => obligation.files.includes(s.file)))
          .map((c) => ({ path: c.path, commit: c.receipt.commit, runId: c.receipt.runId, completedAt: c.receipt.completedAt })) });
    } else {
      remaining.push({ ...obligation, localEvidence: { evidenceDir: LOCAL_E2E_EVIDENCE_DIR, fleetTree: planFleetTree ?? null, missing,
        failedReceipts: red.map((c) => c.path),
        rejected: checked.filter((c) => !c.result.valid).slice(0, 5).map((c) => ({ path: c.path, problems: c.result.problems.slice(0, 3) })) } });
    }
  }
  return { ...plan, unavailable: remaining, localEvidence: [...(plan.localEvidence ?? []), ...accepted] };
}

/**
 * Câu trả lời từ lịch sử Git cho validateLocalE2eReceipt. `git(...args)` trả stdout
 * và NÉM khi lệnh thoát khác 0; `target` là commit đầu plan.
 */
export function gitFleetResolver(git, target) {
  const fleetTreeOf = (ref) => { try { return git('rev-parse', '--verify', '--quiet', `${ref}:${FLEET_ROOT}`).trim() || null; } catch { return null; } };
  const resolveCommit = (sha) => {
    if (git('cat-file', '-t', sha).trim() !== 'commit') return null;
    let isAncestor = sha === target;
    if (!isAncestor) { try { git('merge-base', '--is-ancestor', sha, target); isAncestor = true; } catch { isAncestor = false; } }
    return { fleetTree: fleetTreeOf(sha), committedAt: Number(git('show', '-s', '--format=%ct', sha).trim()) * 1000, isAncestor };
  };
  return { fleetTreeOf, resolveCommit };
}

/** Hình dạng tối thiểu của localEvidence trong aggregate (promote kiểm lại). */
export function validLocalEvidenceSummary(items) {
  return Array.isArray(items) && items.every((item) => item && LOCAL_E2E_SUITES.includes(item.suiteId) &&
    typeof item.fleetTree === 'string' && HASH.test(item.fleetTree) && Array.isArray(item.files) && item.files.length > 0 &&
    item.files.every((f) => typeof f === 'string' && SPEC.test(f)) && Array.isArray(item.receipts) && item.receipts.length > 0 &&
    item.receipts.every((r) => r && typeof r.commit === 'string' && HASH.test(r.commit)));
}

/** Dòng in cho promote: lần phát hành này dựa vào biên nhận local nào. */
export function describeLocalEvidence(items = []) {
  return items.flatMap((item) => item.receipts.map((r) =>
    `${item.suiteId}: ${item.files.length} spec · ${r.path ?? '?'} · commit ${String(r.commit).slice(0, 12)} · run ${String(r.runId ?? '?').slice(0, 8)} · ${r.completedAt ?? '?'}`));
}
