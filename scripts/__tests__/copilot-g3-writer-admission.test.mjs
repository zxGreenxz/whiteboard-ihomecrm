import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../copilot-golden-browser-evidence.mjs';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, relative, delimiter } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { parse } from 'yaml';
import { inspectCopilotE2EArtifactDirectory } from '../copilot-e2e-artifact-safety.mjs';
import { createG3Attempt } from '../copilot-g3-voucher-lifecycle.mjs';
const module = await import('../copilot-g3-writer-admission.mjs').catch(() => ({}));
const current = { runId: '101', runAttempt: '1', sourceSha: 'a'.repeat(40), buildSha: 'b'.repeat(40), workflow: 'copilot-e2e.yml', repository: 'owner/repo' };
const prior = { runId: '100', runAttempt: '1', sourceSha: 'c'.repeat(40), status: 'completed', conclusion: 'failure' };
function reconciliation() { return { kind: 'g3-readonly-reconciliation-v1', priorRunId: '100', priorRunAttempt: '1', priorSourceSha: prior.sourceSha, admittedSourceSha: current.sourceSha, repository: current.repository, workflow: current.workflow, evidenceDigest: 'd'.repeat(64), priorArtifactDigest: 'e'.repeat(64), settled: true, noExecutablePlans: true, ownedFixturesTerminal: true, completeHistoryVerified: true, externalOperatorsClear: true }; }
function validate(extra = {}) { assert.equal(typeof module.validateG3Admission, 'function', 'cross-run admission must exist'); return module.validateG3Admission({ current, prior, receipts: null, ...extra }); }
test('missing, cancelled, expired or failed prior artifact cannot become bootstrap', () => { for (const conclusion of ['success', 'failure', 'cancelled', 'timed_out']) assert.throws(() => validate({ prior: { ...prior, conclusion } })); assert.throws(() => validate({ prior: null })); });
test('bootstrap requires pinned reviewed reconciliation matching exact prior and reviewed source', () => { const r = reconciliation(); const admitted = validate({ reconciliation: r, reconciliationDigest: digest(r) }); assert.equal(admitted.priorRunId, '100'); assert.equal(admitted.sourceSha, current.sourceSha); assert.equal(admitted.kind, 'g3-writer-admission-v1'); });
test('old green run, guessed prior identity, altered review or external operator conflict blocks', () => {
  for (const change of [r => { r.priorRunId = '99'; }, r => { r.priorRunAttempt = '2'; }, r => { r.priorSourceSha = current.sourceSha; }, r => { r.admittedSourceSha = prior.sourceSha; }, r => { r.completeHistoryVerified = false; }, r => { r.externalOperatorsClear = false; }, r => { r.settled = false; }]) { const r = reconciliation(); change(r); assert.throws(() => validate({ reconciliation: r, reconciliationDigest: digest(r) })); }
  const r = reconciliation(); assert.throws(() => validate({ reconciliation: r, reconciliationDigest: '0'.repeat(64) }));
});
test('retry of same GitHub run is never admitted as a fresh writer', () => { const r = reconciliation(); assert.throws(() => validate({ current: { ...current, runAttempt: '2' }, reconciliation: r, reconciliationDigest: digest(r) })); });
test('selection is cross-ref complete, blocks newer started run and incomplete pagination', () => {
  assert.equal(typeof module.selectPriorG3Run, 'function'); const runs = [{ id: 101, run_number: 3, run_attempt: 1, status: 'in_progress', head_sha: current.sourceSha }, { id: 100, run_number: 2, run_attempt: 1, status: 'completed', conclusion: 'failure', head_sha: prior.sourceSha, head_branch: 'different-ref' }, { id: 99, run_number: 1, run_attempt: 1, status: 'completed', conclusion: 'success', head_sha: prior.sourceSha }];
  assert.equal(module.selectPriorG3Run(runs, current).runId, '100'); assert.throws(() => module.selectPriorG3Run(runs.filter(r => r.id !== 101), current)); assert.throws(() => module.selectPriorG3Run([{ id: 102, run_number: 4, status: 'completed' }, ...runs], current));
});
function receipt(caseNo, context = prior) {
  const uuid = n => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
  const attempt = createG3Attempt({ actorId: uuid(1), caseNo, sourceSha: context.sourceSha, buildSha: context.buildSha ?? context.sourceSha, runId: context.runId, runAttempt: context.runAttempt, workflow: current.workflow });
  const canonical = { organization_id: attempt.organizationId, type: 'EXPENSE', name: attempt.marker, amount: 1000, building_id: uuid(2), type_id: uuid(3), voucher_date: '2026-09-08' };
  const j = { version: 1, attempt, attemptDigest: digest(attempt), state: 'finalized', business: 'passed', lockReleased: true, planId: uuid(4), voucherId: uuid(5), canonical, payloadDigest: digest(canonical), voucherDigest: 'f'.repeat(64), approvalVersion: 1, postingVersion: 1, operations: [{ kind: 'preview', outcome: 'success' }, { kind: 'plan_create', outcome: 'success' }, { kind: 'approve', outcome: 'success' }, { kind: 'execute', step: 1, outcome: 'success' }, { kind: 'execute', step: caseNo === 3 ? 2 : 1, outcome: caseNo === 3 ? 'success' : 'rejected' }, { kind: 'cancel', outcome: 'success' }], terminal: { voucherId: uuid(5), approvalStatus: 'CANCELLED', reviewState: 'RESOLVED', postingStatus: 'UNPOSTED', cancellationKind: 'CANCELLED_UNPOSTED', approvalVersion: 2, postingVersion: 1, requestId: null, requestState: null, voucherDigest: 'e'.repeat(64) }, history: { complete: true, authorityDigest: 'd'.repeat(64), proofDigest: 'e'.repeat(64) } };
  return { ...j, receiptDigest: digest(j) };
}
test('validated finalized prior receipts automatically admit next writer without new reconciliation', () => {
  const receipts = { kind: 'g3-writer-receipts-v1', runId: prior.runId, runAttempt: prior.runAttempt, sourceSha: prior.sourceSha, buildSha: prior.sourceSha, workflow: current.workflow, repository: current.repository, admissionDigest: 'd'.repeat(64), journals: [receipt(3), receipt(8)] };
  const result = validate({ prior: { ...prior, conclusion: 'success' }, receipts }); assert.equal(result.evidenceDigest, digest(receipts)); module.validateG3AdmissionFile(result, current);
  for (const change of [r => { r.journals.pop(); }, r => { r.journals[0].lockReleased = false; }, r => { r.journals[0].operations[3].outcome = 'unknown'; }, r => { r.runAttempt = '2'; }, r => { r.journals[0].history.complete = false; }]) { const bad = structuredClone(receipts); change(bad); assert.throws(() => validate({ prior: { ...prior, conclusion: 'success' }, receipts: bad })); }
});
test('real admission transport reads all refs and records exact reviewed predecessor before writes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'g3-admission-')), calls = [], r = reconciliation();
  const fetch = async (url, init) => { calls.push(url); assert.equal(init.headers.Authorization, 'Bearer synthetic-github-token'); assert.equal(init.redirect, 'error'); return { ok: true, json: async () => ({ total_count: 2, workflow_runs: [{ id: 101, run_number: 2, run_attempt: 1, status: 'in_progress', head_sha: current.sourceSha }, { id: 100, run_number: 1, run_attempt: 1, status: 'completed', conclusion: 'failure', head_sha: prior.sourceSha }] }) }; };
  await module.prepareG3Writer({ current, reviewedSourceSha: current.sourceSha, token: 'synthetic-github-token', directory, reconciliation: r, reconciliationDigest: digest(r), fetch });
  assert.equal(calls[0], 'https://api.github.com/repos/owner/repo/actions/workflows/copilot-e2e.yml/runs?per_page=100&page=1'); const saved = JSON.parse(readFileSync(join(directory, 'admission.json'), 'utf8')); assert.equal(saved.priorRunId, '100'); assert.equal(JSON.stringify(saved).includes('synthetic-github-token'), false);
});
test('missing artifact on ephemeral runner fails before an admission file is emitted', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'g3-admission-'));
  await assert.rejects(module.prepareG3Writer({ current, reviewedSourceSha: current.sourceSha, token: 'test', directory, fetch: async url => ({ ok: true, json: async () => url.includes('/artifacts?') ? { total_count: 0, artifacts: [] } : { total_count: 2, workflow_runs: [{ id: 101, run_number: 2, run_attempt: 1, status: 'in_progress' }, { id: 100, run_number: 1, run_attempt: 1, status: 'completed', conclusion: 'success', head_sha: prior.sourceSha }] } }) })); assert.equal(existsSync(join(directory, 'admission.json')), false);
});
test('CLI collector retains earlier journals but only publishes receipts of this admitted run', () => {
  const directory = mkdtempSync(join(tmpdir(), 'g3-collect-')), r = reconciliation();
  const admission = validate({ reconciliation: r, reconciliationDigest: digest(r) });
  writeFileSync(join(directory, 'admission.json'), JSON.stringify(admission));
  for (const j of [receipt(3), receipt(8), receipt(3, current), receipt(8, current)]) writeFileSync(join(directory, `journal-${j.attempt.attemptId}.json`), JSON.stringify(j));
  const env = { ...process.env, COPILOT_G3_JOURNAL_DIR: directory, COPILOT_G3_ADMISSION_FILE: join(directory, 'admission.json'), GITHUB_RUN_ID: current.runId, GITHUB_RUN_ATTEMPT: current.runAttempt, GITHUB_SHA: current.sourceSha, EXPECTED_SOURCE_SHA: current.buildSha, GITHUB_REPOSITORY: current.repository };
  const result = spawnSync(process.execPath, ['scripts/copilot-g3-writer-admission.mjs', 'collect'], { env, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); assert.ok(existsSync(join(directory, 'writer-receipts.json')), 'must publish this run despite retained prior journals');
  const bundle = JSON.parse(readFileSync(join(directory, 'writer-receipts.json'), 'utf8')); assert.equal(bundle.journals.length, 2); assert.ok(bundle.journals.every(j => j.attempt.runId === current.runId));
});

const workflow = parse(readFileSync('.github/workflows/copilot-e2e.yml', 'utf8'));
const admissionStep = workflow.jobs['copilot-e2e'].steps.find(step => step.id === 'g3-admission');
const secretNames = ['FLEET_PASS_CHUNHA', 'FLEET_PASS_KETOAN', 'FLEET_PASS_QUANLY', 'FLEET_PASS_QUANLY2', 'FLEET_PASS_SYSADMIN'];
const syntheticSecrets = Object.fromEntries(secretNames.map(name => [name, `synthetic-${name}-secret-8391532746`]));
function configuredGuard(directory, withPasswords = true) {
  const line = admissionStep.run.split('\n').find(line => line.includes(' guard '));
  const command = line?.trim().match(/^node (\S+) guard "\$([A-Z0-9_]+)"$/);
  assert.ok(command, 'configured admission must invoke the actual artifact guard');
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(FLEET_PASS_|COPILOT_E2E_PIN$|VERCEL_AUTOMATION_BYPASS_SECRET$)/.test(name)));
  for (const [name, value] of Object.entries({ ...workflow.env, ...workflow.jobs['copilot-e2e'].env, ...admissionStep.env })) {
    const secret = value.match?.(/^\$\{\{ secrets\.([A-Z0-9_]+) \}\}$/)?.[1];
    if (withPasswords && syntheticSecrets[secret]) env[name] = syntheticSecrets[secret];
  }
  env[command[2]] = directory;
  return spawnSync(process.execPath, [command[1], 'guard', directory], { env, encoding: 'utf8', windowsHide: true });
}
test('configured admission guard passes clean data with its named password env and refuses unmeasurable/secret data', () => {
  const directory = mkdtempSync(join(tmpdir(), 'g3-configured-guard-'));
  writeFileSync(join(directory, 'admission.json'), JSON.stringify({ kind: 'synthetic-clean-admission' }));
  const clean = configuredGuard(directory); assert.equal(clean.status, 0, clean.stderr);
  assert.equal(configuredGuard(directory, false).status, 3, 'absence of FLEET_PASS must still fail closed');
  for (const name of secretNames) {
    writeFileSync(join(directory, 'admission.json'), JSON.stringify({ unexpected: syntheticSecrets[name] }));
    const unsafe = configuredGuard(directory); assert.equal(unsafe.status, 1, `configured guard must inspect ${name}`); assert.equal(`${unsafe.stdout}${unsafe.stderr}`.includes(syntheticSecrets[name]), false);
  }
});

// Standard ZIP records with real DEFLATE entries; production extraction uses real unzip.
function compressedZip(entries) {
  const locals = [], central = []; let offset = 0;
  function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
  for (const [name, text] of Object.entries(entries)) {
    const filename = Buffer.from(name), raw = Buffer.from(text), compressed = deflateRawSync(raw), crc = crc32(raw);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 8); header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(raw.length, 22); header.writeUInt16LE(filename.length, 26);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(8, 10); record.writeUInt32LE(crc, 16); record.writeUInt32LE(compressed.length, 20); record.writeUInt32LE(raw.length, 24); record.writeUInt16LE(filename.length, 28); record.writeUInt32LE(offset, 42);
    locals.push(header, filename, compressed); central.push(record, filename); offset += header.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
function uploadedFiles(root) { return readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? uploadedFiles(join(root, entry.name)) : [join(root, entry.name)]); }
function outside(path, root) { const from = relative(resolve(root), resolve(path)); return from === '..' || from.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || /^[A-Za-z]:/.test(from); }
function workflowUploadRoots(runnerTemp) {
  return workflow.jobs['copilot-e2e'].steps.filter(step => step.uses?.startsWith('actions/upload-artifact@')).map(step => resolve(step.with.path.replace('${{ runner.temp }}', runnerTemp)));
}
async function archiveAttempt(mode) {
  // Windows local verification uses the real unzip bundled with installed Git.
  const oldPath = process.env.PATH;
  if (process.platform === 'win32') { const bin = join(process.env.ProgramFiles, 'Git', 'usr', 'bin'); assert.ok(existsSync(join(bin, 'unzip.exe'))); process.env.PATH = `${bin}${delimiter}${oldPath}`; }
  const runnerTemp = mkdtempSync(join(tmpdir(), 'g3-archive-runner-'));
  const uploadRoot = join(runnerTemp, 'copilot-e2e'), directory = join(uploadRoot, 'g3'), scratchRoot = mode === 'unsafe-scratch' ? join(uploadRoot, 'downloads') : join(runnerTemp, 'g3-downloads'); mkdirSync(directory, { recursive: true }); mkdirSync(scratchRoot);
  const bundle = { kind: 'g3-writer-receipts-v1', runId: prior.runId, runAttempt: prior.runAttempt, sourceSha: prior.sourceSha, buildSha: prior.sourceSha, workflow: current.workflow, repository: current.repository, admissionDigest: 'd'.repeat(64), journals: [receipt(3), receipt(8)] };
  if (mode === 'validation') bundle.journals[0].lockReleased = false;
  if (mode === 'identity') bundle.runId = '999';
  if (mode === 'extra-schema') bundle.private = syntheticSecrets.FLEET_PASS_SYSADMIN;
  const zip = compressedZip({ ...(mode === 'extraction' ? {} : { 'writer-receipts.json': mode === 'parse' ? '{broken-json' : JSON.stringify(bundle) }), 'private.txt': syntheticSecrets.FLEET_PASS_SYSADMIN });
  assert.equal(zip.includes(Buffer.from(syntheticSecrets.FLEET_PASS_SYSADMIN)), false, 'sensitive sibling entry is genuinely compressed');
  const counterexample = join(runnerTemp, 'counterexample'); mkdirSync(counterexample); writeFileSync(join(counterexample, 'prior.zip'), zip);
  assert.deepEqual(inspectCopilotE2EArtifactDirectory(counterexample, { env: syntheticSecrets }).findings, [], 'raw-byte inspector cannot certify compressed sibling entries');
  unlinkSync(join(counterexample, 'prior.zip')); rmdirSync(counterexample);
  let observedScratch = [];
  const fetch = async (url, init) => {
    if (url === 'https://signed.example.test/archive') { assert.equal(init.headers, undefined); return { ok: true, arrayBuffer: async () => { observedScratch = readdirSync(scratchRoot).map(name => join(scratchRoot, name)); if (mode === 'download') throw Error('synthetic download interrupted'); return zip; } }; }
    if (url === 'https://api.github.com/repos/owner/repo/actions/artifacts/55/zip') return { status: 302, headers: { get: () => 'https://signed.example.test/archive' } };
    return { ok: true, json: async () => url.includes('/artifacts?') ? { total_count: 1, artifacts: [{ name: 'copilot-g3-lifecycle-100-1', expired: false, archive_download_url: 'https://api.github.com/repos/owner/repo/actions/artifacts/55/zip' }] } : { total_count: 2, workflow_runs: [{ id: 101, run_number: 2, run_attempt: 1, status: 'in_progress' }, { id: 100, run_number: 1, run_attempt: 1, status: 'completed', conclusion: 'success', head_sha: prior.sourceSha }] } };
  };
  try {
    const operation = module.prepareG3Writer({ current, reviewedSourceSha: current.sourceSha, token: 'synthetic-github-token', directory, scratchRoot, uploadRoots: workflowUploadRoots(runnerTemp), fetch });
    if (mode === 'success') await operation; else await assert.rejects(operation);
    const files = uploadedFiles(uploadRoot);
    assert.deepEqual(files.map(file => relative(uploadRoot, file).replaceAll('\\', '/')), mode === 'success' ? ['g3/admission.json'] : [], 'only validated schema data may survive in any upload root');
    assert.deepEqual(readdirSync(scratchRoot), [], 'download scratch must be removed after every outcome');
    assert.equal(uploadedFiles(runnerTemp).some(path => path.endsWith('.zip')), false, 'no downloaded or fixture ZIP survives anywhere in the synthetic runner');
    assert.equal(observedScratch.length, mode === 'unsafe-scratch' ? 0 : 1, 'unsafe scratch is rejected before reading the archive; other downloads have one isolated directory');
    assert.ok(observedScratch.every(path => workflowUploadRoots(runnerTemp).every(root => outside(path, root))), 'scratch must never overlap an actual workflow upload path');
    assert.deepEqual(inspectCopilotE2EArtifactDirectory(uploadRoot, { env: syntheticSecrets }).findings, []);
    assert.equal(configuredGuard(uploadRoot).status, 0, 'actual configured guard can inspect the remaining upload tree');
  } finally { process.env.PATH = oldPath; }
}
for (const mode of ['success', 'download', 'extraction', 'parse', 'validation', 'identity', 'extra-schema', 'unsafe-scratch']) test(`predecessor DEFLATE archive is outside upload roots and destroyed after ${mode}`, () => archiveAttempt(mode));
