import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, TEST_REF, CANDIDATES, parseArguments, sha, validateSchemaEvidence, validateRecoveryBackup, fixturePlan,
  channelSetupSql, channelCleanupSql, channelCountsSql, roleProbe, expectSqlDenied, captureSourceIdentity, runHarness,
  executionMode, executionPlan, runChannelScope, accountSetupSql, verifyBindingManagementFixture, fixtureRpcDiagnostic, fixtureRequestHeaders,
  activateFixtureConnection, verifyPolicyOptionsFixture, verifyLiveSchema, migrationSources, verifyExecutorPrincipal, createExecutorRole } from '../test-hermes-private-flow.mjs';
import { createDurableConnectionStore } from '../../infra/hermes-broker/durable-connection-store.mjs';
import { validateCleanupEvidence } from '../test-hermes-broker-authz.mjs';
import { extractFunctionDefinitions } from '../network-center-function-bodies.mjs';

const path = fileURLToPath(new URL('../test-hermes-private-flow.mjs', import.meta.url));
const source = readFileSync(path, 'utf8');
const allowedArgs = ['--run', '--env', 'test', '--expected-project-ref', TEST_REF];

test('actual request uses public profile for every RPC and leaves Auth requests unchanged', () => {
  for (const name of ['hermes_set_org_policy_v1', 'hermes_zalo_binding_v1', 'hermes_zalo_ingress_v1', 'hermes_zalo_private_reply_v1']) {
    const headers = fixtureRequestHeaders(`/rest/v1/rpc/${name}`, 'fixture-key', 'fixture-token');
    assert.equal(headers['Content-Profile'], 'public');
    assert.equal(headers.Authorization, 'Bearer fixture-token');
    assert.deepEqual(Object.keys(headers).sort(), ['Authorization', 'Content-Profile', 'Content-Type', 'apikey']);
  }
  const auth = fixtureRequestHeaders('/auth/v1/token?grant_type=password', 'fixture-key', null);
  assert.deepEqual(auth, { apikey: 'fixture-key', 'Content-Type': 'application/json' });
  assert.throws(() => fixtureRequestHeaders('https://foreign.invalid/rest/v1/rpc/a', 'fixture-key', 'fixture-token'), { code: 'fixture_endpoint_refused' });
  assert.match(source, /headers: fixtureRequestHeaders\(path, key, token\)/);
});

test('RPC diagnostics retain only fixed endpoint, status and safe error code, never response secrets', () => {
  const data = { code: '42501', message: 'private-user-token', detail: 'private-payload', session: { access_token: 'private-token' } };
  assert.deepEqual(fixtureRpcDiagnostic('hermes_set_org_policy_v1', 403, data), { name: 'hermes_set_org_policy_v1', status: 403, code: '42501' });
  assert.equal(fixtureRpcDiagnostic('hermes_zalo_binding_v1', 404, { code: 'PGRST202' }).code, 'PGRST202');
  assert.equal(fixtureRpcDiagnostic('hermes_zalo_binding_v1', 0, { code: 'private-token' }).code, null);
  assert.equal(fixtureRpcDiagnostic('hermes_zalo_binding_v1', 0, {}).status, null);
});

test('RPC diagnostics reject arbitrary names and do not invoke response getters', () => {
  assert.throws(() => fixtureRpcDiagnostic('caller_secret', 400, {}), { code: 'fixture_rpc_refused' });
  assert.equal(fixtureRpcDiagnostic('hermes_zalo_binding_v1', 403, { get code() { throw Error('must not run'); } }).code, null);
});
test('preview never opts into live work; exact --run/env/ref is mandatory', () => {
  assert.deepEqual(parseArguments([]), { run: false });
  assert.deepEqual(parseArguments(['--plan']), { run: false });
  assert.equal(parseArguments(allowedArgs).run, true);
  for (const args of [allowedArgs.slice(1), ['--run'], [...allowedArgs, '--apply'], [...allowedArgs.slice(0, -1), 'tryymsxyyckgbrmmvozx'],
    ['--run', '--env', 'prod', '--expected-project-ref', TEST_REF], ['--run', '--expected-project-ref', TEST_REF, '--env', 'test']]) {
    assert.throws(() => parseArguments(args), { code: 'explicit_test_run_required' });
  }
});

test('invalid programmatic run fails before source/credential/network work', async () => {
  await assert.rejects(runHarness({ run: true, environment: 'prod', expectedProjectRef: TEST_REF }), { code: 'explicit_test_run_required' });
  await assert.rejects(runHarness({ run: false }), { code: 'explicit_test_run_required' });
});

test('offline executable preview with network poisoned is self-contained', () => {
  const code = `globalThis.fetch=()=>{throw new Error('network forbidden')};process.argv=[process.execPath,${JSON.stringify(path)},'--plan'];await import(${JSON.stringify(new URL('../test-hermes-private-flow.mjs', import.meta.url).href)})`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: ROOT, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout); assert.equal(value.mode, 'offline-plan'); assert.equal(value.liveExecuted, false);
});

const fixtureSource = { path: 'supabase/migrations/fixture.sql', bytes: Buffer.from('select 1;\n') };
const fixtureBlob = createHash('sha1').update(`blob ${fixtureSource.bytes.length}\0`).update(fixtureSource.bytes).digest('hex');
const validEvidence = () => ({ environment: 'test', projectRef: TEST_REF, evidenceComplete: true, file: fixtureSource.path,
  sha256: sha(fixtureSource.bytes), statementBytes: fixtureSource.bytes.length, reviewedBlob: fixtureBlob, appliedAt: '2026-10-01T00:00:00Z',
  catalog: { before: 'b'.repeat(64), after: 'c'.repeat(64) }, authorization: { loai: 'bien-nhan-backup', backupProjectRef: TEST_REF,
    backupEnvironment: 'test', backupSha256: 'd'.repeat(64), backupCreatedAt: '2026-10-01T00:00:00Z', backupTablesWithData: 627, backupFile: '/synthetic.dump' } });
const evidenceOptions = { reviewedBlob: fixtureBlob, reviewedBlobBytes: fixtureSource.bytes };
test('schema evidence binds target, raw bytes, reviewed blob, catalog and apply-time TEST backup attestation', () => {
  const result = validateSchemaEvidence(validEvidence(), fixtureSource, evidenceOptions);
  assert.equal(result.sha256, sha(fixtureSource.bytes)); assert.equal(result.backupSha256, 'd'.repeat(64));
  assert.equal(Object.hasOwn(result, 'backupFile'), false);
});
for (const [name, mutate, expected] of [
  ['wrong project', e => { e.projectRef = 'tryymsxyyckgbrmmvozx'; }, 'schema_evidence_target_invalid'],
  ['wrong environment', e => { e.environment = 'prod'; }, 'schema_evidence_target_invalid'],
  ['incomplete receipt', e => { e.evidenceComplete = false; }, 'schema_evidence_target_invalid'],
  ['changed byte digest', e => { e.sha256 = 'f'.repeat(64); }, 'schema_evidence_source_mismatch'],
  ['changed reviewed blob', e => { e.reviewedBlob = 'f'.repeat(40); }, 'schema_evidence_source_mismatch'],
  ['different statement length', e => { e.statementBytes += 1; }, 'schema_evidence_source_mismatch'],
  ['different file', e => { e.file = 'supabase/migrations/other.sql'; }, 'schema_evidence_source_mismatch'],
  ['missing catalog', e => { e.catalog.after = null; }, 'schema_evidence_incomplete'],
  ['future apply receipt', e => { e.appliedAt = '2099-01-01T00:00:00Z'; }, 'schema_evidence_incomplete'],
  ['production backup', e => { e.authorization.backupProjectRef = 'tryymsxyyckgbrmmvozx'; }, 'schema_backup_evidence_required'],
  ['backup bypass', e => { e.authorization.loai = 'token-nguoi'; }, 'schema_backup_evidence_required'],
  ['small backup', e => { e.authorization.backupTablesWithData = 1; }, 'schema_backup_evidence_required'],
  ['backup after apply', e => { e.authorization.backupCreatedAt = '2026-10-01T00:00:01Z'; }, 'schema_backup_evidence_required'],
  ['relative backup path', e => { e.authorization.backupFile = 'synthetic.dump'; }, 'schema_backup_evidence_required'],
]) test(`evidence rejects ${name}`, () => {
  const value = validEvidence(); mutate(value);
  assert.throws(() => validateSchemaEvidence(value, fixtureSource, evidenceOptions), { code: expected });
});

function recoveryFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'hermes-backup-retention-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const backupRoot = join(root, 'test', TEST_REF); mkdirSync(backupRoot, { recursive: true });
  const file = join(backupRoot, 'ihomecrm-full-2026-10-01T00-05-00-000Z.dump');
  const bytes = Buffer.alloc(2048, 42);
  const latest = validEvidence(); latest.appliedAt = '2026-10-01T00:06:01Z';
  Object.assign(latest.authorization, { backupFile: file, backupCreatedAt: '2026-10-01T00:06:00Z', backupSha256: sha(bytes) });
  const retired = validEvidence(); retired.file = 'supabase/migrations/retired.sql';
  retired.authorization.backupFile = join(backupRoot, 'ihomecrm-full-2026-09-30T23-59-00-000Z.dump');
  const manifest = { file, kind: 'full', projectRef: TEST_REF, environment: 'test', reason: `apply ${basename(latest.file)}`,
    createdAt: latest.authorization.backupCreatedAt, durationSeconds: 60, tablesWithData: 627, excludedTableData: [],
    bytes: bytes.length, sha256: sha(bytes) };
  const save = () => writeFileSync(`${file}.json`, JSON.stringify(manifest));
  writeFileSync(file, bytes); save();
  return { root, backupRoot, file, bytes, latest, retired, manifest, save, evidence: [latest, retired] };
}

test('recovery uses latest apply time, verifies real bytes and permits retired historical dumps', t => {
  const f = recoveryFixture(t);
  const result = validateRecoveryBackup(f.evidence, f);
  assert.equal(result.migration, f.latest.file); assert.equal(result.sha256, sha(f.bytes));
  assert.equal(result.backupNamedAt, '2026-10-01T00:05:00.000Z');
  assert.equal(result.manifestSha256, sha(readFileSync(`${f.file}.json`)));
  assert.equal(result.recovery, 'restore_pre_latest_apply_then_replay_reviewed_latest_migration');
  assert.equal(result.restoredByHarness, false);
});

for (const [name, mutate, code] of [
  ['missing latest dump with older dump available', f => { writeFileSync(f.retired.authorization.backupFile, f.bytes); rmSync(f.file); }, 'schema_recovery_file_unavailable'],
  ['missing latest manifest', f => rmSync(`${f.file}.json`), 'schema_recovery_file_unavailable'],
  ['malformed manifest', f => writeFileSync(`${f.file}.json`, '{'), 'schema_recovery_manifest_invalid'],
  ['tampered latest bytes', f => writeFileSync(f.file, Buffer.alloc(f.bytes.length, 43)), 'schema_recovery_dump_mismatch'],
  ['shortened latest bytes', f => writeFileSync(f.file, f.bytes.subarray(1)), 'schema_recovery_dump_mismatch'],
  ['wrong project', f => { f.manifest.projectRef = 'tryymsxyyckgbrmmvozx'; f.save(); }, 'schema_recovery_manifest_invalid'],
  ['wrong environment', f => { f.manifest.environment = 'prod'; f.save(); }, 'schema_recovery_manifest_invalid'],
  ['schema-only backup', f => { f.manifest.kind = 'schema'; f.save(); }, 'schema_recovery_manifest_invalid'],
  ['excluded data', f => { f.manifest.excludedTableData = ['private_table']; f.save(); }, 'schema_recovery_manifest_invalid'],
  ['wrong backup digest', f => { f.manifest.sha256 = 'e'.repeat(64); f.save(); }, 'schema_recovery_manifest_invalid'],
  ['wrong manifest path', f => { f.manifest.file = f.retired.authorization.backupFile; f.save(); }, 'schema_recovery_manifest_invalid'],
  ['wrong migration reason', f => { f.manifest.reason = 'apply another.sql'; f.save(); }, 'schema_recovery_manifest_invalid'],
  ['invalid size attestation', f => { f.manifest.bytes = 1; f.save(); }, 'schema_recovery_dump_mismatch'],
  ['invalid table count', f => { f.manifest.tablesWithData = 449; f.save(); }, 'schema_recovery_manifest_invalid'],
  ['snapshot starts before prior apply despite later completion', f => { f.retired.appliedAt = '2026-10-01T00:05:30Z'; }, 'schema_recovery_order_invalid'],
  ['backup completes after its apply', f => { f.latest.appliedAt = '2026-10-01T00:05:59Z'; }, 'schema_recovery_order_invalid'],
  ['ambiguous apply order', f => { f.retired.appliedAt = f.latest.appliedAt; }, 'schema_recovery_order_invalid'],
  ['missing duration', f => { delete f.manifest.durationSeconds; f.save(); }, 'schema_recovery_order_invalid'],
  ['impossible duration', f => { f.manifest.durationSeconds = 90; f.save(); }, 'schema_recovery_order_invalid'],
  ['foreign backup path', f => { f.latest.authorization.backupFile = join(f.root, basename(f.file)); }, 'schema_recovery_path_invalid'],
  ['symlinked backup directory', f => {
    const link = join(f.root, 'linked'); symlinkSync(f.backupRoot, link, process.platform === 'win32' ? 'junction' : 'dir');
    f.backupRoot = link; f.latest.authorization.backupFile = join(link, basename(f.file));
  }, 'schema_recovery_path_invalid'],
]) test(`recovery rejects ${name}`, t => {
  const f = recoveryFixture(t); mutate(f);
  assert.throws(() => validateRecoveryBackup(f.evidence, f), { code });
});
test('historical backup attestation survives retention without claiming a current recovery point', () => {
  let checkedFile = false;
  const result = validateSchemaEvidence(validEvidence(), fixtureSource, { ...evidenceOptions,
    fileExists: () => { checkedFile = true; return false; } });
  assert.equal(checkedFile, false);
  assert.equal(result.backupSha256, 'd'.repeat(64));
  assert.equal(Object.hasOwn(result, 'recoveryPoint'), false);
});

test('pinned historical reviewed Git blob accepts only the actual legacy CRLF clean projection', () => {
  const migration = migrationSources().find(item => item.name === '20261012165809_hermes_public_conflict_http_v1.sql');
  const reviewedBlob = '7a42c3c73b224ab31a26575883c455c9a0fd8f15';
  const bytes = Buffer.from(migration.bytes.toString('utf8').replaceAll('\r\n', '\n'));
  assert.equal(bytes.length, 12673);
  assert.equal(sha(migration.bytes), 'b2f087aa089334446dfef3606a6c81ea6ae5b7cf4ec122da0630e30ba4a79e50');
  const evidence = { ...validEvidence(), file: migration.path, sha256: sha(migration.bytes), statementBytes: migration.bytes.length, reviewedBlob };
  const options = { reviewedBlob: '4264c3269ca1eee9c1a2990c08629b6df885acc8', reviewedBlobBytes: bytes };
  const result = validateSchemaEvidence(evidence, migration, options);
  assert.equal(result.reviewedBlob, reviewedBlob); assert.equal(result.reviewedProjection, 'pinned_legacy_crlf_to_lf');
  for (const [changedEvidence, changedSource, changedOptions] of [
    [evidence, migration, { ...options, reviewedBlobBytes: Buffer.from('select 1;\n') }],
    [{ ...evidence, reviewedBlob: fixtureBlob }, migration, { ...options, reviewedBlobBytes: fixtureSource.bytes }],
    [evidence, { ...migration, bytes: Buffer.from(migration.bytes.toString().replace('BEGIN', 'BEGIN ')) }, options],
    [{ ...evidence, file: 'supabase/migrations/other.sql' }, { ...migration, path: 'supabase/migrations/other.sql' }, options],
    [evidence, migration, { ...options, reviewedBlob: fixtureBlob }],
  ]) assert.throws(() => validateSchemaEvidence(changedEvidence, changedSource, changedOptions), { code: 'schema_evidence_source_mismatch' });
});

test('ordinary evidence rejects missing or substituted Git blob bytes', () => {
  for (const reviewedBlobBytes of [undefined, Buffer.from('select 2;\n')]) {
    assert.throws(() => validateSchemaEvidence(validEvidence(), fixtureSource, { ...evidenceOptions, reviewedBlobBytes }),
      { code: 'schema_evidence_source_mismatch' });
  }
});

test('fixture worker lease inserts only when absent and never takes over; channels have no login/send instruction', () => {
  const plan = fixturePlan(); plan.actors.forEach((actor, index) => { actor.id = `10000000-0000-4000-8000-00000000000${index}`; });
  const sql = channelSetupSql(plan);
  assert.match(sql, /INSERT INTO public\.zalo_worker_lease/); assert.doesNotMatch(sql, /ON CONFLICT|UPDATE public\.zalo_worker_lease|DELETE|login_requested_at|zalo_outbound_queue/i);
  assert(sql.indexOf('zalo_worker_lease') < sql.indexOf('zalo_accounts'));
  for (const channel of plan.channels) { assert(sql.includes(channel.accountId)); assert.match(channel.ownUid, /^[1-9][0-9]+$/); assert.notEqual(channel.ownUid, channel.senderUid); }
  assert.match(sql, /providerDisabled/); assert.match(plan.rolePassword, /^[A-Za-z0-9_-]{40,64}$/); assert(!sql.includes(plan.rolePassword));
});
test('cleanup and zero counts are scoped to exact fixture IDs, never other account or worker owner', () => {
  const plan = fixturePlan(); const cleanup = channelCleanupSql(plan); const counts = channelCountsSql(plan);
  assert.match(cleanup, new RegExp(`DELETE FROM public.zalo_worker_lease WHERE id='singleton' AND instance_id='${plan.instanceId}'`));
  assert.match(cleanup, /meta->>'hermesFixtureRun'/);
  for (const channel of plan.channels) { assert(cleanup.includes(channel.accountId)); assert(counts.includes(channel.accountId)); }
  assert.doesNotMatch(cleanup, /TRUNCATE|DROP |CASCADE|LIKE|heartbeat_at/i);
  for (const statement of cleanup.split(';').filter(line => /DELETE FROM/.test(line))) assert.match(statement, / WHERE /);
  assert.match(counts, /private_commands/); assert.match(counts, /zalo_messages/); assert.match(counts, /zalo_worker_lease/);
});

function mockRole({ result = { status: 'empty' }, failAt, error = { code: '42501', severity: 'ERROR' }, rollbackFails = false, who } = {}) {
  const calls = []; const state = { uncertain: false }; const lease = {};
  const ctx = { lease, test: 'fixture-only', expectedRole: 'hermes_store_fixture_' + 'a'.repeat(32), writeState: state, async assertLease(actual, db) { assert.equal(actual, lease); assert.equal(db, 'fixture-only'); calls.push('LEASE'); } };
  let release;
  const client = { async query(input) {
    const sql = typeof input === 'string' ? input : input.text; calls.push(sql);
    if (sql === 'ROLLBACK' && rollbackFails) throw new Error('rollback lost');
    if (sql === failAt || (failAt === 'FUNCTION' && sql.startsWith('SELECT app_private.'))) throw error;
    if (sql.startsWith('SELECT current_user')) return { rows: [who ?? principal()] };
    if (sql.startsWith('SELECT app_private.')) { assert.equal(input.values.length, 1); assert.equal(input.queryMode, 'extended'); return { rows: [{ result }] }; }
    return { rows: [] };
  }, release(value) { release = value; calls.push('RELEASE'); } };
  return { ctx, pool: { async connect() { calls.push('CONNECT'); return client; } }, calls, state, released: () => release };
}
test('executor probe checks lease, uses bound payload and exact fixed function, commits before return', async () => {
  const m = mockRole(); const value = await roleProbe(m.ctx, m.pool, 'claimPrivateCommand', { tokenDigest: 'a'.repeat(64), claimId: 'synthetic' });
  assert.deepEqual(value, { status: 'empty' });
  assert.deepEqual(m.calls, ['LEASE', 'CONNECT', 'BEGIN', m.calls[3],
    'SELECT app_private.hermes_store_claim_private_command_v1($1::jsonb) AS result', 'COMMIT', 'RELEASE']);
  assert.equal(m.state.uncertain, false); assert.equal(m.released(), false);
});
test('executor probe rejects arbitrary SQL operation before connecting', async () => {
  const m = mockRole(); await assert.rejects(roleProbe(m.ctx, m.pool, 'DROP TABLE', {}), { code: 'store_operation_invalid' }); assert.deepEqual(m.calls, []);
});
test('definite statement rejection and acknowledged rollback do not invent uncertain commit', async () => {
  const m = mockRole({ failAt: 'FUNCTION' });
  await assert.rejects(roleProbe(m.ctx, m.pool, 'claimPrivateCommand', {}), { code: '42501' });
  assert(m.calls.includes('ROLLBACK')); assert(!m.calls.includes('COMMIT')); assert.equal(m.state.uncertain, false);
});
test('unknown statement result retains TEST marker, no automatic retry', async () => {
  const m = mockRole({ failAt: 'FUNCTION', error: new Error('socket closed') });
  await assert.rejects(roleProbe(m.ctx, m.pool, 'claimPrivateCommand', {}));
  assert.equal(m.state.uncertain, true); assert.equal(m.calls.filter(sql => sql.startsWith('SELECT app_private.')).length, 1);
});
test('unknown commit stays uncertain even with rollback ACK', async () => {
  const m = mockRole({ failAt: 'COMMIT', error: new Error('lost commit acknowledgement') });
  await assert.rejects(roleProbe(m.ctx, m.pool, 'dispatchPrivateCommand', {})); assert.equal(m.state.uncertain, true); assert(m.calls.includes('ROLLBACK'));
});
test('rollback failure destroys client and retains TEST marker', async () => {
  const m = mockRole({ failAt: 'FUNCTION', rollbackFails: true });
  await assert.rejects(roleProbe(m.ctx, m.pool, 'dispatchPrivateCommand', {})); assert.equal(m.state.uncertain, true); assert.equal(m.released(), true);
});
test('wrong executor role fails closed before function dispatch', async () => {
  const m = mockRole({ who: { role: 'postgres', session_role: 'postgres' } });
  await assert.rejects(roleProbe(m.ctx, m.pool, 'claimPrivateCommand', {}), { code: 'executor_role_probe_invalid' });
  assert(!m.calls.some(sql => sql.startsWith('SELECT app_private.'))); assert(m.calls.includes('ROLLBACK'));
});
function activationFixture() {
  const connection = { id: '11111111-1111-4111-8111-111111111111', assistantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', organizationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    state: 'active', epoch: 2, restrictions: { read: ['assistant.context.read'], action: [] }, scopeIds: [] };
  const credentialRef = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  return { input: { prepared: { ...connection, state: 'pending', epoch: 1, intentSecret: 'b'.repeat(64), intentExpiresAt: 1_800_000_300_000 },
    operationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', credentialRef,
    binding: { assistantId: connection.assistantId, userId: connection.userId, organizationId: connection.organizationId,
      sessionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }, tokenDigest: 'a'.repeat(64), tokenExpiresAt: 1_800_000_900_000,
    sessionExpiresAt: 1_800_003_600_000, sessionEnvelope: { v: 1, algorithm: 'A256GCM', keyVersion: 'fixture',
      nonce: Buffer.alloc(12, 1).toString('base64url'), tag: Buffer.alloc(16, 2).toString('base64url'),
      ciphertext: Buffer.from('synthetic-encrypted-fixture').toString('base64url') } },
  reply: { ok: true, status: 'activated', connection, credentialRef } };
}
function activationStore(m, { afterTransport } = {}) {
  return createDurableConnectionStore({ transport: { async call(operation, payload) {
    const result = await roleProbe(m.ctx, m.pool, operation, payload); afterTransport?.(); return result;
  } } });
}
test('malformed activation ACK after COMMIT retains TEST marker and never retries', async () => {
  const m = mockRole({ result: { ok: true, status: 'activated' } }); const { input } = activationFixture();
  await assert.rejects(activateFixtureConnection(m.ctx, activationStore(m), input, { signal: new AbortController().signal }), { code: 'store_outcome_unknown' });
  assert(m.calls.includes('COMMIT')); assert.equal(m.calls.filter(sql => sql.startsWith('SELECT app_private.')).length, 1);
  assert.equal(m.state.uncertain, true);
  assert.throws(() => validateCleanupEvidence({ fixture: 0 }, m.state), { code: 'fixture_write_outcome_uncertain' });
});
test('abort after committed activation ACK cannot clear cleanup marker', async () => {
  const { input, reply } = activationFixture(); const controller = new AbortController(); const m = mockRole({ result: reply });
  await assert.rejects(activateFixtureConnection(m.ctx, activationStore(m, { afterTransport: () => controller.abort() }), input,
    { signal: controller.signal }), { code: 'store_outcome_unknown' });
  assert(m.calls.includes('COMMIT')); assert.equal(m.state.uncertain, true);
  assert.throws(() => validateCleanupEvidence({ fixture: 0 }, m.state), { code: 'fixture_write_outcome_uncertain' });
});
test('acknowledged activation succeeds once and keeps known cleanup state', async () => {
  const { input, reply } = activationFixture(); const m = mockRole({ result: reply });
  assert.deepEqual(await activateFixtureConnection(m.ctx, activationStore(m), input, { signal: new AbortController().signal }), reply);
  assert.equal(m.state.uncertain, false); validateCleanupEvidence({ fixture: 0 }, m.state);
  assert.equal(m.calls.filter(sql => sql.startsWith('SELECT app_private.')).length, 1);
});
test('activation validation failure and pre-dispatch cancellation do not invent unknown writes', async () => {
  const { input } = activationFixture(); const m = mockRole(); const controller = new AbortController();
  await assert.rejects(activateFixtureConnection(m.ctx, activationStore(m), { ...input, tokenDigest: 'invalid' },
    { signal: controller.signal }), { code: 'connection_store_request_invalid' });
  controller.abort();
  await assert.rejects(activateFixtureConnection(m.ctx, activationStore(m), input, { signal: controller.signal }), { code: 'connection_store_cancelled' });
  assert.deepEqual(m.calls, []); assert.equal(m.state.uncertain, false);
});
test('known rejected activation with acknowledged rollback stays known despite adapter error translation', async () => {
  const { input } = activationFixture(); const m = mockRole({ failAt: 'FUNCTION' });
  await assert.rejects(activateFixtureConnection(m.ctx, activationStore(m), input, { signal: new AbortController().signal }), { code: 'connection_store_unavailable' });
  assert(m.calls.includes('ROLLBACK')); assert(!m.calls.includes('COMMIT')); assert.equal(m.state.uncertain, false);
});

function policyFixture({ wrongOwner = false, denyMissingPermission = true, onWrite } = {}) {
  const plan = fixturePlan(); plan.actors.forEach((actor, index) => { actor.id = `10000000-0000-4000-8000-00000000000${index}`; });
  const calls = []; let usersEdit = true;
  return { plan, calls, adapter: {
    async okRpc(actor, name, input) {
      assert.equal(name, 'hermes_org_policy_options_v1'); calls.push({ kind: 'read', actor: actor.id, org: input.p_org });
      const policy = { organizationId: input.p_org, version: 1, enabled: true, read: ['assistant.context.read'], action: [] };
      return { userId: wrongOwner ? plan.actors[2].id : actor.id, organizationId: input.p_org, policy, choices: { action: [] } };
    },
    async deniedRpc(actor, name, input) {
      assert.equal(name, 'hermes_org_policy_options_v1'); calls.push({ kind: 'denied', actor: actor.id, org: input.p_org });
      if (input.p_org === plan.orgs[plan.actors.indexOf(actor)].id) {
        assert.equal(usersEdit, false);
        if (!denyMissingPermission) throw Object.assign(new Error('expected_rpc_denial_missing'), { code: 'expected_rpc_denial_missing' });
      }
    },
    async write(sql) {
      calls.push({ kind: 'write', sql }); assert(sql.includes(plan.orgs[0].id)); assert(sql.includes(plan.orgs[0].roleId));
      assert(!sql.includes(plan.orgs[1].id)); assert.match(sql, /'users.edit'/);
      onWrite?.(sql); usersEdit = !sql.includes('DELETE');
    },
  } };
}
test('policy JWT fixture probes self, both foreign orgs, selected superadmin orgs and scoped permission denial', async () => {
  const m = policyFixture(); await verifyPolicyOptionsFixture(m.plan, m.adapter);
  assert.deepEqual(m.calls.map(item => item.kind), ['read', 'denied', 'read', 'denied', 'read', 'read', 'write', 'denied', 'write']);
  const reads = m.calls.filter(item => item.kind === 'read');
  assert.deepEqual(reads.map(item => [item.actor, item.org]), [[m.plan.actors[0].id, m.plan.orgs[0].id],
    [m.plan.actors[1].id, m.plan.orgs[1].id], [m.plan.actors[2].id, m.plan.orgs[0].id], [m.plan.actors[2].id, m.plan.orgs[1].id]]);
});
test('policy fixture rejects wrong actor projection before later probes', async () => {
  const m = policyFixture({ wrongOwner: true });
  await assert.rejects(verifyPolicyOptionsFixture(m.plan, m.adapter), { code: 'jwt_policy_options_owner_mismatch' });
  assert.equal(m.calls.length, 1);
});
test('policy fixture fails if users.edit removal does not deny, without restoring and continuing', async () => {
  const m = policyFixture({ denyMissingPermission: false });
  await assert.rejects(verifyPolicyOptionsFixture(m.plan, m.adapter), { code: 'expected_rpc_denial_missing' });
  assert.equal(m.calls.filter(item => item.kind === 'write').length, 1);
});
test('policy fixture does not retry or continue after permission mutation failure', async () => {
  const m = policyFixture({ onWrite() { throw Object.assign(new Error('fixture_sql_failed'), { code: 'fixture_sql_failed' }); } });
  await assert.rejects(verifyPolicyOptionsFixture(m.plan, m.adapter), { code: 'fixture_sql_failed' });
  assert.equal(m.calls.filter(item => item.kind === 'write').length, 1); assert.equal(m.calls.at(-1).kind, 'write');
});

function mockSchema({ foreignPolicyGrant = false } = {}) {
  const sources = migrationSources(); const bodies = new Map(sources.flatMap(item => [...item.bytes.toString('utf8').replace(/\r\n?/g, '\n')
    .matchAll(/(\$(?:[a-zA-Z_][a-zA-Z_0-9]*)?\$)([\s\S]*?)\1/g)].map(match => [sha(match[2]), match[2]])));
  const definitions = new Map(sources.flatMap(item => extractFunctionDefinitions(item.bytes.toString('utf8'), item.path))
    .filter(item => /^(?:public|app_private)\.hermes_/.test(item.qualifiedName)).map(item => [item.qualifiedName, item]));
  const calls = [];
  return { calls, async query(sql, parameters = []) {
    calls.push({ sql, parameters });
    if (sql.includes('FROM pg_proc')) return { rows: [...definitions.values()].map(item => ({ name: item.qualifiedName,
      prosrc: bodies.get(item.bodyDigest), prosecdef: true, owner: 'postgres', proconfig: ['search_path=pg_catalog,public,app_private'] })) };
    if (sql.includes('has_function_privilege')) {
      const [signature, roles] = parameters;
      const allowed = signature.startsWith('app_private.') ? 'hermes_store_executor'
        : /hermes_zalo_(?:ingress|private_command|private_reply)_/.test(signature) ? 'service_role' : 'authenticated';
      return { rows: roles.map(role => ({ role, allowed: role === allowed
        || (foreignPolicyGrant && signature === 'public.hermes_org_policy_options_v1(uuid)' && role === 'hermes_store_executor') })) };
    }
    if (sql.includes('has_table_privilege')) return { rows: Array.from({ length: 80 }, () => ({ allowed: false })) };
    if (sql.includes('SELECT relrowsecurity')) return { rows: Array.from({ length: 5 }, () => ({ relrowsecurity: true })) };
    if (sql.includes('FROM pg_trigger')) return { rows: parameters[0].map(tgname => ({ tgname, tgenabled: 'O' })) };
    throw new Error('unexpected schema query');
  } };
}
test('schema preflight includes new policy getter body and authenticated-only ACL', async () => {
  const m = mockSchema(); await verifyLiveSchema(m);
  assert(m.calls.find(item => item.sql.includes('FROM pg_proc')).parameters[0].includes('public.hermes_org_policy_options_v1'));
  assert(m.calls.some(item => item.parameters[0] === 'public.hermes_org_policy_options_v1(uuid)'));
});
test('schema preflight rejects a policy getter grant to the store executor before fixture work', async () => {
  await assert.rejects(verifyLiveSchema(mockSchema({ foreignPolicyGrant: true })), { code: 'live_rpc_acl_mismatch' });
});

test('SQL denial assertion cannot pass on success or unrelated failure', async () => {
  await expectSqlDenied(async () => { throw { code: '42501' }; });
  await assert.rejects(expectSqlDenied(async () => {}), { code: 'expected_sql_denial_missing' });
  await assert.rejects(expectSqlDenied(async () => { throw { code: 'XX000' }; }), { code: 'expected_sql_denial_missing' });
});
test('source identity covers current candidate SQL, runner/tests and transitive authorization/vault/lease helpers', () => {
  const identity = captureSourceIdentity();
  for (const file of ['scripts/lib/vault.mjs', 'scripts/test-env/lock.mjs', 'infra/hermes-broker/supabase-adapter.mjs',
    'infra/hermes-broker/session-crypto.mjs', 'scripts/test-hermes-private-flow.mjs',
    'scripts/__tests__/hermes-private-flow.test.mjs']) assert.match(identity[file], /^[a-f0-9]{64}$/);
  for (const [name, expected] of Object.entries(CANDIDATES)) assert.equal(identity[`supabase/migrations/${name}`], expected);
});
test('draft keeps real JWT evidence separate from role probe and no outbound/forged-claims route exists', () => {
  assert.doesNotMatch(source, /set_config\(\s*['"]request\.jwt|SET\s+(?:LOCAL\s+)?["']?request\.jwt|zalo_send_message|sendMessage\s*\(|\/auth\/v1\/admin\/generate_link/i);
  assert.match(source, /dedicatedLogin: principalVerified/);
  assert.doesNotMatch(source, /SET LOCAL ROLE|GRANT hermes_store_executor TO postgres/);
  assert.match(source, /outcome: 'unknown', providerMessageId: null/);
  assert.doesNotMatch(source, /outcome: 'sent'/);
  assert(source.indexOf('const schemaEvidence = requireSchemaEvidence()') < source.indexOf('const connection = await context()'));
  assert(source.indexOf('await pool.end()') < source.indexOf('await withTestCleanup('));
});

test('JWT management mode requires explicit exact selector and retains default full mode', () => {
  assert.equal(executionMode(parseArguments(allowedArgs)), 'full');
  assert.equal(executionMode(parseArguments([...allowedArgs, '--mode', 'jwt-management'])), 'jwt-management');
  assert.deepEqual(parseArguments(['--plan', '--mode', 'jwt-management']), { run: false, mode: 'jwt-management' });
  assert.throws(() => parseArguments([...allowedArgs, '--mode', 'skip-worker']), { code: 'fixture_mode_invalid' });
  assert.throws(() => parseArguments([...allowedArgs, '--mode', 'jwt-management', '--mode', 'jwt-management']), { code: 'explicit_test_run_required' });
  assert.throws(() => executionMode({ mode: false }), { code: 'fixture_mode_invalid' });
});

test('JWT management mode rejects invalid programmatic selector before credential access', async () => {
  await assert.rejects(runHarness({ run: true, environment: 'test', expectedProjectRef: TEST_REF, mode: 'skip-worker' }), { code: 'fixture_mode_invalid' });
});

test('JWT management offline plan labels omitted private flow and never requires an empty lease', () => {
  const plan = executionPlan({ mode: 'jwt-management' });
  assert.equal(plan.scope, 'jwt-management'); assert.equal(plan.fullPrivateFlowExecuted, false);
  assert.equal(plan.liveExecuted, false); assert(!plan.requires.includes('empty worker lease'));
  assert(plan.excluded.includes('private intake/dispatch/reply'));
  assert(executionPlan().requires.includes('empty worker lease'));
});

test('JWT management branch never invokes the full worker path, including a failed management call', async () => {
  let managed = 0, full = 0;
  const handlers = { management: async () => { managed += 1; return 'management'; }, full: async () => { full += 1; return 'full'; } };
  assert.equal(await runChannelScope('jwt-management', handlers), 'management');
  assert.equal(managed, 1); assert.equal(full, 0);
  await assert.rejects(runChannelScope('jwt-management', { ...handlers, management: async () => { throw new Error('unknown'); } }), /unknown/);
  assert.equal(full, 0);
  assert.equal(await runChannelScope('full', handlers), 'full'); assert.equal(full, 1);
  await assert.rejects(runChannelScope('skip-worker', handlers), { code: 'fixture_mode_invalid' });
  assert.equal(managed, 1); assert.equal(full, 1);
});

test('JWT management setup and cleanup have no worker lease write or provider instruction', () => {
  const plan = fixturePlan(); plan.actors.forEach((a, i) => { a.id = `10000000-0000-4000-8000-00000000000${i}`; });
  const setup = accountSetupSql(plan), cleanup = channelCleanupSql(plan, { mode: 'jwt-management' });
  assert.doesNotMatch(setup + cleanup, /zalo_worker_lease|login_requested_at|zalo_outbound_queue/i);
  assert.match(setup, /INSERT INTO public\.zalo_accounts/);
  for (const channel of plan.channels) { assert(setup.includes(channel.accountId)); assert(cleanup.includes(channel.accountId)); }
  assert.match(channelCleanupSql(plan), /DELETE FROM public\.zalo_worker_lease/);
  assert.match(channelSetupSql(plan), /INSERT INTO public\.zalo_worker_lease/);
});

function managementFixture({ mutateReply, rejectWrite = false, rejectDenial = false } = {}) {
  const plan = fixturePlan(); plan.actors.forEach((a, i) => { a.id = `10000000-0000-4000-8000-00000000000${i}`; });
  const subjects = plan.orgs.map((_, i) => ({ connection: { id: `20000000-0000-4000-8000-00000000000${i}`, epoch: 1 } }));
  const calls = []; let permission = true;
  const adapter = {
    async okRpc(actor, name, { p }) {
      assert.equal(name, 'hermes_zalo_binding_v1'); assert(actor !== 'worker');
      const i = plan.actors.indexOf(actor), channel = plan.channels[i];
      assert.equal(p.organizationId, plan.orgs[i].id); calls.push({ kind: 'ok', actor: i, p });
      const common = { accountId: channel.accountId, connectionId: subjects[i].connection.id,
        challengeId: `30000000-0000-4000-8000-00000000000${i}` };
      let reply;
      if (p.operation === 'setBot') reply = { status: 'configured', accountId: channel.accountId, version: p.expectedVersion + 1, enabled: p.enabled };
      else if (p.operation === 'manageBots') reply = { status: 'listed', nextCursor: null, bots: [{ accountId: channel.accountId, enabled: true, version: 1 }] };
      else if (p.operation === 'begin') reply = { ...common, status: 'waiting', challenge: `hz_${'a'.repeat(64)}` };
      else if (p.operation === 'status') reply = { ...common, status: 'waiting', candidateVersion: 0, senderUid: null };
      else throw new Error('unexpected operation');
      mutateReply?.(reply, p.operation); return reply;
    },
    async deniedRpc(actor, name, { p }, statuses = [403], codes = ['42501']) {
      calls.push({ kind: 'denied', actor: plan.actors.indexOf(actor), p, statuses, codes });
      assert.equal(name, 'hermes_zalo_binding_v1');
      if (rejectDenial) throw Object.assign(new Error('expected_rpc_denial_missing'), { code: 'expected_rpc_denial_missing' });
      if (p.operation === 'manageBots') assert.equal(permission, false);
    },
    async write(sql) {
      calls.push({ kind: 'write', sql }); assert.match(sql, /'chat_zalo.manage_automation'/);
      assert(plan.orgs.some(org => sql.includes(org.id) && sql.includes(org.roleId)));
      if (rejectWrite) throw Object.assign(new Error('fixture_sql_failed'), { code: 'fixture_sql_failed' });
      permission = !sql.includes('DELETE');
    },
  };
  return { plan, subjects, calls, adapter };
}

test('JWT management covers actual subjects, ownership, stale versions, missing permission and revocation', async () => {
  const m = managementFixture(); await verifyBindingManagementFixture(m.plan, m.subjects, m.adapter);
  for (const i of [0, 1]) {
    const start = m.calls.find(c => c.kind === 'ok' && c.actor === i && c.p.operation === 'begin');
    assert.equal(start.p.connectionId, m.subjects[i].connection.id);
    const statusDenials = m.calls.filter(c => c.kind === 'denied' && c.p.operation === 'status' && c.p.organizationId === m.plan.orgs[i].id);
    assert.deepEqual(statusDenials.map(c => c.actor), [2, 1 - i, i]);
    assert.deepEqual(statusDenials.at(-1).statuses, [409]); assert.deepEqual(statusDenials.at(-1).codes, ['PT409']);
    const missing = m.calls.find(c => c.kind === 'denied' && c.actor === i && c.p.operation === 'manageBots');
    assert(missing);
  }
  assert.equal(m.calls.filter(c => c.kind === 'write').length, 4);
  assert(!m.calls.some(c => c.p && ['register', 'observe', 'confirm', 'acceptPrivateCommand', 'dispatch', 'ack'].includes(c.p.operation)));
});

for (const [label, operation, mutation, code] of [
  ['foreign bot', 'setBot', r => { r.accountId = '40000000-0000-4000-8000-000000000001'; }, 'jwt_bot_configuration_invalid'],
  ['extra bot', 'manageBots', r => { r.bots.push({ ...r.bots[0] }); }, 'jwt_bot_listing_invalid'],
  ['foreign challenge connection', 'begin', r => { r.connectionId = '40000000-0000-4000-8000-000000000001'; }, 'jwt_unobserved_challenge_invalid'],
  ['observed status', 'status', r => { r.status = 'observed'; }, 'jwt_unobserved_status_invalid'],
  ['invented sender', 'status', r => { r.senderUid = '123'; }, 'jwt_unobserved_status_invalid'],
]) test(`JWT management rejects ${label}`, async () => {
  const m = managementFixture({ mutateReply(r, op) { if (op === operation) mutation(r); } });
  await assert.rejects(verifyBindingManagementFixture(m.plan, m.subjects, m.adapter), { code });
});

test('JWT management never retries or compensates an unknown permission write', async () => {
  const m = managementFixture({ rejectWrite: true });
  await assert.rejects(verifyBindingManagementFixture(m.plan, m.subjects, m.adapter), { code: 'fixture_sql_failed' });
  assert.equal(m.calls.filter(c => c.kind === 'write').length, 1); assert.equal(m.calls.at(-1).kind, 'write');
});

test('JWT management cannot pass if a required ownership denial is missing', async () => {
  const m = managementFixture({ rejectDenial: true });
  await assert.rejects(verifyBindingManagementFixture(m.plan, m.subjects, m.adapter), { code: 'expected_rpc_denial_missing' });
  assert.equal(m.calls.at(-1).kind, 'denied'); assert.equal(m.calls.filter(c => c.kind === 'write').length, 0);
});

test('JWT management production orchestration retains full blockers and restricts worker/store path', () => {
  assert.match(source, /if \(mode === 'full'\) demand\([\s\S]{0,180}worker_lease_must_be_absent/);
  assert.match(source, /mode === 'full' \|\| actor !== 'worker'/);
  assert.match(source, /mode === 'full' \|\| operation === 'activate' \|\| operation === 'readConnection'/);
  assert.match(source, /channelCleanupSql\(plan, \{ mode \}\)/);
  assert.match(source, /await runChannelScope\(mode, \{ management: async \(\) =>/);
  assert.match(source, /fullPrivateFlowStatus: mode === 'jwt-management' \? 'not_executed_scope'/);
  assert.match(source, /await write\(baseSetup\(plan\)\)/);
  assert.match(source, /const subjects = \[await issue\(0, 0\), await issue\(1, 1\)\]/);
  assert.match(source, /markTestCleanupRequired\(lease, ctx.test\)/);
  assert.match(source, /validateCleanupEvidence\(\{ \.\.\.baseCounts, \.\.\.channelCounts \}, ctx.writeState\)/);
});

function principal(delta = {}) {
  return { role: 'hermes_store_fixture_' + 'a'.repeat(32), session_role: 'hermes_store_fixture_' + 'a'.repeat(32),
    rolcanlogin: true, rolinherit: true, rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false,
    rolreplication: false, scoped: true, privileged_member: false, ...delta };
}
for (const [label, delta] of [
  ['admin session', { session_role: 'postgres' }], ['wrong dedicated identity', { role: 'hermes_store_fixture_' + 'b'.repeat(32) }],
  ['role switch', { role: 'hermes_store_executor' }], ['superuser', { rolsuper: true }], ['bypass RLS', { rolbypassrls: true }],
  ['create role', { rolcreaterole: true }], ['create database', { rolcreatedb: true }], ['replication', { rolreplication: true }],
  ['no login', { rolcanlogin: false }], ['no inheritance', { rolinherit: false }], ['ineffective membership', { scoped: false }],
  ['privileged membership', { privileged_member: true }],
]) test(`dedicated executor refuses ${label} before dispatch`, async () => {
  const m = mockRole({ who: principal(delta) });
  await assert.rejects(roleProbe(m.ctx, m.pool, 'activate', {}), { code: 'executor_role_probe_invalid' });
  assert(!m.calls.some(sql => sql.startsWith('SELECT app_private.'))); assert.equal(m.state.uncertain, false);
});

function executorPreflight({ who = principal(), membership, schema, functionMutation, tableAllowed = false, probe = { status: 'unavailable' }, rollbackFails = false } = {}) {
  const m = mockRole(); const calls = m.calls;
  const client = { async query(input) {
    const sql = typeof input === 'string' ? input : input.text; calls.push(sql);
    if (sql === 'ROLLBACK' && rollbackFails) throw new Error('unknown read transaction settlement');
    if (sql.startsWith('SELECT current_user')) return { rows: [who] };
    if (sql.includes('pg_auth_members')) return { rows: membership ?? [{ role: 'hermes_store_executor', admin_option: false, inherit_option: true }] };
    if (sql.includes('has_schema_privilege')) return { rows: schema ?? [{ allowed: true, can_create: false }] };
    if (sql.includes('has_function_privilege')) {
      const rows = input.values[0].map(signature => ({ signature, allowed: signature.startsWith('app_private.') })); functionMutation?.(rows); return { rows };
    }
    if (sql.includes('has_table_privilege')) return { rows: input.values[0].flatMap(() => input.values[1].map(() => ({ allowed: tableAllowed }))) };
    if (sql.startsWith('SELECT app_private.')) {
      assert.equal(input.text, 'SELECT app_private.hermes_store_read_connection_v1($1::jsonb) AS result');
      assert.deepEqual(JSON.parse(input.values[0]), { tokenDigest: '0'.repeat(64) }); return { rows: [{ result: probe }] };
    }
    return { rows: [] };
  }, release(broken) { calls.push(broken ? 'DESTROY' : 'RELEASE'); } };
  return { ...m, pool: { async connect() { calls.push('CONNECT'); return client; } } };
}
test('dedicated executor preflight is read-only, proves effective identity and narrow ACL before any Auth writes', async () => {
  const m = executorPreflight(); await verifyExecutorPrincipal(m.ctx, m.pool);
  assert.equal(m.calls[2], 'BEGIN READ ONLY'); assert.equal(m.calls.at(-2), 'COMMIT');
  assert(m.calls.some(sql => sql.includes('pg_auth_members'))); assert(m.calls.some(sql => sql.includes('has_table_privilege')));
  assert(!m.calls.some(sql => /SET ROLE|SET LOCAL ROLE|CREATE ROLE|GRANT|INSERT|UPDATE|DELETE/.test(sql)));
  assert.equal(m.state.uncertain, false);
});
for (const [name, options, code] of [
  ['admin', { who: principal({ session_role: 'postgres' }) }, 'executor_role_probe_invalid'],
  ['extra membership', { membership: [{ role: 'hermes_store_executor', admin_option: false, inherit_option: true }, { role: 'authenticated' }] }, 'executor_membership_invalid'],
  ['admin option', { membership: [{ role: 'hermes_store_executor', admin_option: true, inherit_option: true }] }, 'executor_membership_invalid'],
  ['noninherited membership', { membership: [{ role: 'hermes_store_executor', admin_option: false, inherit_option: false }] }, 'executor_membership_invalid'],
  ['missing schema usage', { schema: [{ allowed: false, can_create: false }] }, 'executor_schema_acl_invalid'],
  ['schema CREATE', { schema: [{ allowed: true, can_create: true }] }, 'executor_schema_acl_invalid'],
  ['API role function', { functionMutation: rows => { rows.find(r => r.signature.startsWith('public.')).allowed = true; } }, 'executor_function_acl_invalid'],
  ['missing store function', { functionMutation: rows => { rows[0].allowed = false; } }, 'executor_function_acl_invalid'],
  ['direct table access', { tableAllowed: true }, 'executor_table_acl_invalid'],
  ['unexpected real token', { probe: { status: 'active' } }, 'executor_read_probe_invalid'],
]) test(`dedicated executor preflight refuses ${name}`, async () => {
  const m = executorPreflight(options); await assert.rejects(verifyExecutorPrincipal(m.ctx, m.pool), { code });
  assert(m.calls.includes('ROLLBACK')); assert(!m.calls.includes('COMMIT')); assert.equal(m.state.uncertain, false);
});
test('unsettled restricted read preflight destroys client and retains cleanup marker', async () => {
  const m = executorPreflight({ who: principal({ session_role: 'postgres' }), rollbackFails: true });
  await assert.rejects(verifyExecutorPrincipal(m.ctx, m.pool), { code: 'executor_role_probe_invalid' });
  assert.equal(m.calls.at(-1), 'DESTROY'); assert.equal(m.state.uncertain, true);
});
test('P4 reuses ephemeral P2 role lifecycle without password output or changing existing memberships', () => {
  const plan = fixturePlan(); assert.match(plan.role, /^hermes_store_fixture_[0-9a-f]{32}$/); assert.match(plan.rolePassword, /^[A-Za-z0-9_-]{40,64}$/);
  assert(source.includes('roleSetupSql, roleCleanupSql, guardedQuery'));
  assert.match(source, /const sql = roleSetupSql\(plan\)/); assert.match(source, /guardedQuery\(ctx, pool, sql, \[\], \{ write: true \}\)/);
  assert.doesNotMatch(source, /write\(roleSetupSql|SET LOCAL ROLE|GRANT[^\n]+(?:postgres|authenticated|service_role)/);
  const roleAbsent = source.indexOf("'fixture_role_already_exists'"), marked = source.indexOf('markTestCleanupRequired(lease, ctx.test); cleanupRequired = true');
  const roleCreate = source.indexOf('await createExecutorRole(ctx, pool, plan, executorRole)'), preflight = source.indexOf('await verifyExecutorPrincipal(ctx, restricted)'), auth = source.indexOf("const created = await request('/auth/v1/admin/users'");
  assert(roleAbsent < marked && marked < roleCreate && roleCreate < preflight && preflight < auth);
  assert(source.indexOf('await restricted.end()') < source.indexOf('await withTestCleanup('));
  assert(source.indexOf('await write(roleCleanupSql(plan), cleanupLease)') < source.indexOf('validateCleanupEvidence({ ...baseCounts'));
  assert.match(source, /if \(executorRole.cleanupRequired\) await write\(roleCleanupSql\(plan\), cleanupLease\)/);
  assert.match(source, /roleProbe\(ctx, restricted, operation, payload\)/);
});

function executorSetup({ failAt, error = { code: '42501', severity: 'ERROR' } } = {}) {
  const plan = fixturePlan(), m = mockRole(), state = { attempted: false, confirmed: false, cleanupRequired: false }, writes = [];
  const pool = { async query(input) {
    assert.equal(input.queryMode, 'extended'); assert.deepEqual(input.values, []); writes.push(input.text);
    if (input.text.startsWith(failAt ?? 'never')) throw error; return { rows: [] };
  } };
  return { ...m, pool, plan, state, writes };
}
test('executor setup grants only its newly created role and cannot be retried', async () => {
  const m = executorSetup(); await createExecutorRole(m.ctx, m.pool, m.plan, m.state);
  assert.deepEqual(m.state, { attempted: true, confirmed: true, cleanupRequired: true });
  assert.equal(m.writes.length, 2); assert.equal(m.writes[1], `GRANT hermes_store_executor TO "${m.plan.role}"`);
  assert.match(m.writes[0], /LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/);
  await assert.rejects(createExecutorRole(m.ctx, m.pool, m.plan, m.state), { code: 'executor_setup_reused' }); assert.equal(m.writes.length, 2);
});
for (const code of ['42501', '42710']) test(`known CREATE rejection ${code} never grants or authorizes dropping a possibly foreign role`, async () => {
  const m = executorSetup({ failAt: 'CREATE ROLE', error: { code, severity: 'ERROR' } });
  await assert.rejects(createExecutorRole(m.ctx, m.pool, m.plan, m.state), { code });
  assert.deepEqual(m.state, { attempted: true, confirmed: false, cleanupRequired: false }); assert.equal(m.writes.length, 1); assert.equal(m.ctx.writeState.uncertain, false);
});
test('unknown CREATE ACK keeps cleanup ownership and the uncertain TEST marker without retry', async () => {
  const m = executorSetup({ failAt: 'CREATE ROLE', error: new Error('lost acknowledgement') });
  await assert.rejects(createExecutorRole(m.ctx, m.pool, m.plan, m.state));
  assert.deepEqual(m.state, { attempted: true, confirmed: false, cleanupRequired: true }); assert.equal(m.writes.length, 1); assert.equal(m.ctx.writeState.uncertain, true);
  assert.throws(() => validateCleanupEvidence({ fixture_role: 0 }, m.ctx.writeState), { code: 'fixture_write_outcome_uncertain' });
});
for (const unknown of [false, true]) test(`GRANT ${unknown ? 'unknown ACK' : 'known rejection'} preserves owned role cleanup`, async () => {
  const m = executorSetup({ failAt: 'GRANT', error: unknown ? new Error('lost acknowledgement') : { code: '42501', severity: 'ERROR' } });
  await assert.rejects(createExecutorRole(m.ctx, m.pool, m.plan, m.state));
  assert.deepEqual(m.state, { attempted: true, confirmed: true, cleanupRequired: true }); assert.equal(m.writes.length, 2); assert.equal(m.ctx.writeState.uncertain, unknown);
});
