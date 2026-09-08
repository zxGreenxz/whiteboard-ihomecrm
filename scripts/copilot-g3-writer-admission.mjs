/** Cross-ref admission. GitHub's retained run identity is the predecessor ledger, never runner-local absence. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { digest } from './copilot-golden-browser-evidence.mjs';
import { validateG3Journal, validateG3Receipt } from './copilot-g3-voucher-lifecycle.mjs';
const ensure = (ok, message) => { if (!ok) throw new Error(message); };
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
function identity(c) { ensure(c && Object.keys(c).length === 6 && /^[0-9]+$/.test(c.runId) && c.runAttempt === '1' && SHA.test(c.sourceSha) && SHA.test(c.buildSha) && c.workflow === 'copilot-e2e.yml' && /^[\w.-]+\/[\w.-]+$/.test(c.repository), 'g3_admission_identity'); }
function validateReceiptBundle(bundle) {
  const fields = ['kind', 'runId', 'runAttempt', 'sourceSha', 'buildSha', 'workflow', 'repository', 'admissionDigest', 'journals'];
  ensure(bundle && Object.keys(bundle).length === fields.length && Object.keys(bundle).every(key => fields.includes(key)) && bundle.kind === 'g3-writer-receipts-v1' && HASH.test(bundle.admissionDigest) && Array.isArray(bundle.journals) && bundle.journals.length === 2, 'g3_artifact_receipts_schema');
  identity({ runId: bundle.runId, runAttempt: bundle.runAttempt, sourceSha: bundle.sourceSha, buildSha: bundle.buildSha, workflow: bundle.workflow, repository: bundle.repository });
  bundle.journals.forEach(validateG3Receipt);
}
export function selectPriorG3Run(runs, current) {
  const self = runs.filter(r => String(r.id) === current.runId); ensure(self.length === 1 && self[0].run_attempt === 1, 'g3_run_history_missing');
  ensure(!runs.some(r => r.run_number > self[0].run_number && !['queued', 'requested', 'waiting', 'pending'].includes(r.status)), 'g3_newer_writer');
  const previous = runs.filter(r => r.run_number < self[0].run_number).sort((a, b) => b.run_number - a.run_number)[0];
  ensure(previous, 'g3_bootstrap_history_required');
  return { runId: String(previous.id), runAttempt: String(previous.run_attempt), sourceSha: previous.head_sha, status: previous.status, conclusion: previous.conclusion };
}
export function validateG3Admission({ current, prior, receipts, reconciliation, reconciliationDigest }) {
  identity(current); ensure(prior && /^[0-9]+$/.test(prior.runId) && /^[1-9][0-9]*$/.test(prior.runAttempt) && SHA.test(prior.sourceSha) && prior.runId !== current.runId && prior.status === 'completed', 'g3_prior_unresolved');
  let evidenceDigest;
  if (reconciliation) {
    const r = reconciliation;
    const keys = ['kind', 'priorRunId', 'priorRunAttempt', 'priorSourceSha', 'admittedSourceSha', 'repository', 'workflow', 'evidenceDigest', 'priorArtifactDigest', 'settled', 'noExecutablePlans', 'ownedFixturesTerminal', 'completeHistoryVerified', 'externalOperatorsClear'];
    ensure(Object.keys(r).length === keys.length && Object.keys(r).every(k => keys.includes(k)) && digest(r) === reconciliationDigest && r.kind === 'g3-readonly-reconciliation-v1' && r.priorRunId === prior.runId && r.priorRunAttempt === prior.runAttempt && r.priorSourceSha === prior.sourceSha && r.admittedSourceSha === current.sourceSha && r.repository === current.repository && r.workflow === current.workflow && HASH.test(r.evidenceDigest) && HASH.test(r.priorArtifactDigest) && ['settled', 'noExecutablePlans', 'ownedFixturesTerminal', 'completeHistoryVerified', 'externalOperatorsClear'].every(k => r[k] === true), 'g3_reconciliation_invalid');
    evidenceDigest = digest(r);
  } else {
    validateReceiptBundle(receipts);
    ensure(prior.conclusion === 'success' && receipts?.kind === 'g3-writer-receipts-v1' && receipts.runId === prior.runId && receipts.runAttempt === prior.runAttempt && receipts.sourceSha === prior.sourceSha && receipts.workflow === current.workflow && receipts.repository === current.repository && Array.isArray(receipts.journals) && receipts.journals.length === 2, 'g3_prior_receipt_missing');
    ensure(new Set(receipts.journals.map(j => j.attempt.caseNo)).size === 2, 'g3_prior_cases_missing');
    for (const j of receipts.journals) { validateG3Receipt(j); ensure(j.attempt.runId === prior.runId && j.attempt.runAttempt === prior.runAttempt && j.attempt.sourceSha === prior.sourceSha && j.attempt.workflow === current.workflow && j.business === 'passed' && j.voucherId && j.operations.filter(op => op.kind === 'execute').length === 2, 'g3_prior_receipt_identity'); }
    evidenceDigest = digest(receipts);
  }
  const result = { kind: 'g3-writer-admission-v1', ...current, priorRunId: prior.runId, priorRunAttempt: prior.runAttempt, priorSourceSha: prior.sourceSha, evidenceDigest };
  return { ...result, admissionDigest: digest(result) };
}
export function validateG3AdmissionFile(value, current) {
  identity(current); const { admissionDigest, ...body } = value ?? {};
  ensure(Object.keys(body).length === 11 && body.kind === 'g3-writer-admission-v1' && Object.entries(current).every(([k, v]) => body[k] === v) && HASH.test(body.evidenceDigest) && SHA.test(body.priorSourceSha) && /^[0-9]+$/.test(body.priorRunId) && /^[1-9][0-9]*$/.test(body.priorRunAttempt) && admissionDigest === digest(body), 'g3_admission_file'); return value;
}
export function collectG3Journals(directory) {
  const journals = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('g3_artifact_symlink');
    if (entry.isDirectory()) journals.push(...collectG3Journals(join(directory, entry.name)));
    else if (/^journal(?:-[a-f0-9-]{36})?\.json$/.test(entry.name)) journals.push(validateG3Journal(JSON.parse(readFileSync(join(directory, entry.name), 'utf8'))));
    else if (entry.name === 'admission.json') {
      const a = JSON.parse(readFileSync(join(directory, entry.name), 'utf8'));
      validateG3AdmissionFile(a, { runId: a.runId, runAttempt: a.runAttempt, sourceSha: a.sourceSha, buildSha: a.buildSha, workflow: a.workflow, repository: a.repository });
    } else if (entry.name === 'lock.json') {
      const lock = JSON.parse(readFileSync(join(directory, entry.name), 'utf8'));
      ensure(Object.keys(lock).length === 1 && /^[a-f0-9-]{36}$/.test(lock.token), 'g3_artifact_lock_schema');
    } else if (entry.name === 'writer-receipts.json') {
      const bundle = JSON.parse(readFileSync(join(directory, entry.name), 'utf8'));
      validateReceiptBundle(bundle);
    } else throw new Error('g3_artifact_unrecognized');
  }
  return journals;
}
function containsPath(root, path) { const child = relative(root, path); return child === '' || !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`); }
function createDownloadScratch(scratchRoot, uploadRoots) {
  ensure(Array.isArray(uploadRoots) && uploadRoots.length > 0, 'g3_upload_roots_required');
  const roots = uploadRoots.map(root => existsSync(root) ? realpathSync(root) : resolve(root));
  const candidate = existsSync(scratchRoot) ? realpathSync(scratchRoot) : resolve(scratchRoot);
  ensure(roots.every(root => !containsPath(root, candidate)), 'g3_scratch_inside_upload');
  mkdirSync(candidate, { recursive: true, mode: 0o700 });
  const parent = realpathSync(candidate);
  ensure(roots.every(root => !containsPath(root, parent)), 'g3_scratch_inside_upload');
  const scratch = mkdtempSync(join(parent, 'prior-'));
  try { ensure(roots.every(root => !containsPath(root, scratch) && !containsPath(scratch, root)), 'g3_scratch_overlaps_upload'); }
  catch (error) { rmdirSync(scratch); throw error; }
  return scratch;
}
export async function prepareG3Writer({ current, reviewedSourceSha, token, directory, reconciliation, reconciliationDigest, fetch, scratchRoot = tmpdir(), uploadRoots = [resolve(directory, '..')] }) {
  identity(current); ensure(reviewedSourceSha === current.sourceSha && token, 'g3_reviewed_source_required');
  mkdirSync(directory, { recursive: true });
  async function get(path) { const response = await fetch(`https://api.github.com/repos/${current.repository}/${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, redirect: 'error' }); ensure(response.ok, 'g3_github_read_failed'); return response.json(); }
  const runs = []; let total;
  for (let page = 1; page <= 100; page++) { const result = await get(`actions/workflows/copilot-e2e.yml/runs?per_page=100&page=${page}`); ensure(Array.isArray(result.workflow_runs) && Number.isInteger(result.total_count) && (total === undefined || total === result.total_count), 'g3_run_history_incomplete'); total = result.total_count; runs.push(...result.workflow_runs); if (runs.length === total) break; ensure(result.workflow_runs.length === 100 && runs.length < total && page < 100, 'g3_run_history_incomplete'); }
  const prior = selectPriorG3Run(runs, current); let receipts = null;
  if (!reconciliation) {
    const artifacts = await get(`actions/runs/${prior.runId}/artifacts?per_page=100`);
    ensure(artifacts.total_count <= 100 && artifacts.artifacts.length === artifacts.total_count, 'g3_artifacts_incomplete');
    const matches = artifacts.artifacts.filter(a => a.name === `copilot-g3-lifecycle-${prior.runId}-${prior.runAttempt}` && a.expired === false);
    ensure(matches.length === 1 && /^https:\/\/api.github.com\//.test(matches[0].archive_download_url), 'g3_prior_artifact_missing');
    const response = await fetch(matches[0].archive_download_url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }, redirect: 'manual' });
    ensure(response.status === 302, 'g3_artifact_download'); const location = response.headers.get('location'); ensure(location && new URL(location).protocol === 'https:', 'g3_artifact_location');
    // Signed artifact URL gets no authorization header. Extract exactly one named entry, never paths from ZIP.
    const archive = await fetch(location, { redirect: 'error' }); ensure(archive.ok, 'g3_artifact_download');
    const scratch = createDownloadScratch(scratchRoot, uploadRoots), zip = join(scratch, 'prior.zip');
    try {
      writeFileSync(zip, Buffer.from(await archive.arrayBuffer()), { mode: 0o600 });
      try { receipts = JSON.parse(execFileSync('unzip', ['-p', zip, 'writer-receipts.json'], { encoding: 'utf8', maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })); }
      catch { throw new Error('g3_prior_artifact_invalid'); }
      validateReceiptBundle(receipts);
    } finally {
      // These are the exact paths allocated above; no recursive deletion or ZIP entry extraction.
      // Cleanup also precedes admission validation, so a rejected predecessor leaves no archive.
      try { rmSync(zip, { force: true }); } finally { rmdirSync(scratch); }
    }
  }
  const admission = validateG3Admission({ current, prior, receipts, reconciliation, reconciliationDigest });
  writeFileSync(join(directory, 'admission.json'), JSON.stringify(admission, null, 2), { mode: 0o600 }); return admission;
}
async function cli() {
  const env = process.env, directory = env.COPILOT_G3_JOURNAL_DIR;
  ensure(directory && env.COPILOT_G3_ADMISSION_FILE === join(directory, 'admission.json'), 'g3_safe_directory');
  const current = { runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT, sourceSha: env.GITHUB_SHA, buildSha: env.EXPECTED_SOURCE_SHA, workflow: 'copilot-e2e.yml', repository: env.GITHUB_REPOSITORY };
  if (process.argv[2] === 'prepare') {
    ensure(env.RUNNER_TEMP, 'g3_runner_scratch_required');
    let reconciliation; try { reconciliation = env.COPILOT_G3_RECONCILIATION_JSON ? JSON.parse(env.COPILOT_G3_RECONCILIATION_JSON) : undefined; } catch { throw new Error('g3_reconciliation_json'); }
    await prepareG3Writer({ current, reviewedSourceSha: env.COPILOT_G3_REVIEWED_SOURCE_SHA, token: env.GH_TOKEN, directory, reconciliation, reconciliationDigest: env.COPILOT_G3_RECONCILIATION_DIGEST, fetch, scratchRoot: join(env.RUNNER_TEMP, 'copilot-g3-downloads'), uploadRoots: [join(env.RUNNER_TEMP, 'copilot-e2e')] });
  } else if (process.argv[2] === 'collect') {
    if (!existsSync(directory)) return;
    const retained = collectG3Journals(directory); for (const j of retained) validateG3Journal(j);
    const journals = retained.filter(j => j.attempt.runId === current.runId && j.attempt.runAttempt === current.runAttempt);
    for (const j of journals) ensure(j.attempt.sourceSha === current.sourceSha && j.attempt.buildSha === current.buildSha && j.attempt.workflow === current.workflow, 'g3_current_receipt_identity');
    // Preserve unresolved sanitized journals, but never write a fake finalized bundle.
    if (journals.length === 2 && journals.every(j => { try { validateG3Receipt(j); return true; } catch { return false; } })) {
      const admission = validateG3AdmissionFile(JSON.parse(readFileSync(join(directory, 'admission.json'), 'utf8')), current);
      writeFileSync(join(directory, 'writer-receipts.json'), JSON.stringify({ kind: 'g3-writer-receipts-v1', ...current, admissionDigest: admission.admissionDigest, journals }, null, 2), { mode: 0o600 });
    }
  } else throw new Error('g3_admission_command');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) cli().catch(() => { console.error('G3 writer admission/artifact validation failed closed.'); process.exitCode = 1; });
