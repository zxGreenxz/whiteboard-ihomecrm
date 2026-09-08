import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../copilot-golden-browser-evidence.mjs';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  const receipts = { kind: 'g3-writer-receipts-v1', runId: prior.runId, runAttempt: prior.runAttempt, sourceSha: prior.sourceSha, workflow: current.workflow, repository: current.repository, journals: [receipt(3), receipt(8)] };
  const result = validate({ prior: { ...prior, conclusion: 'success' }, receipts }); assert.equal(result.evidenceDigest, digest(receipts)); module.validateG3AdmissionFile(result, current);
  for (const change of [r => { r.journals.pop(); }, r => { r.journals[0].lockReleased = false; }, r => { r.journals[0].operations[3].outcome = 'unknown'; }, r => { r.runAttempt = '2'; }, r => { r.journals[0].history.complete = false; }]) { const bad = structuredClone(receipts); change(bad); assert.throws(() => validate({ prior: { ...prior, conclusion: 'success' }, receipts: bad })); }
});
test('real admission transport reads all refs and durably records exact reviewed predecessor before writes', async () => {
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
