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
  activateFixtureConnection, verifyPolicyOptionsFixture, verifyLiveSchema, migrationSources } from '../test-hermes-private-flow.mjs';
import { createDurableConnectionStore } from '../../infra/hermes-broker/durable-connection-store.mjs';
import { validateCleanupEvidence } from '../test-hermes-broker-authz.mjs';
import { extractFunctionDefinitions } from '../network-center-function-bodies.mjs';

const path = fileURLToPath(new URL('../test-hermes-private-flow.mjs', import.meta.url));
const source = readFileSync(path, 'utf8');
const allowedArgs = ['--run', '--env', 'test', '--expected-project-ref', TEST_REF];
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
  assert.match(sql, /providerDisabled/); assert.equal(Object.hasOwn(plan, 'rolePassword'), false);
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
  const ctx = { lease, test: 'fixture-only', writeState: state, async assertLease(actual, db) { assert.equal(actual, lease); assert.equal(db, 'fixture-only'); calls.push('LEASE'); } };
  let release;
  const client = { async query(input) {
    const sql = typeof input === 'string' ? input : input.text; calls.push(sql);
    if (sql === 'ROLLBACK' && rollbackFails) throw new Error('rollback lost');
    if (sql === failAt || (failAt === 'FUNCTION' && sql.startsWith('SELECT app_private.'))) throw error;
    if (sql.startsWith('SELECT current_user')) return { rows: [who ?? { role: 'hermes_store_executor', session_role: 'postgres' }] };
    if (sql.startsWith('SELECT app_private.')) { assert.equal(input.values.length, 1); assert.equal(input.queryMode, 'extended'); return { rows: [{ result }] }; }
    return { rows: [] };
  }, release(value) { release = value; calls.push('RELEASE'); } };
  return { ctx, pool: { async connect() { calls.push('CONNECT'); return client; } }, calls, state, released: () => release };
}
test('executor probe checks lease, uses bound payload and exact fixed function, commits before return', async () => {
  const m = mockRole(); const value = await roleProbe(m.ctx, m.pool, 'claimPrivateCommand', { tokenDigest: 'a'.repeat(64), claimId: 'synthetic' });
  assert.deepEqual(value, { status: 'empty' });
  assert.deepEqual(m.calls, ['LEASE', 'CONNECT', 'BEGIN', 'SET LOCAL ROLE hermes_store_executor', 'SELECT current_user AS role,session_user AS session_role',
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
  assert.match(source, /dedicatedLogin: false, providerSend: false/);
  assert.match(source, /outcome: 'unknown', providerMessageId: null/);
  assert.doesNotMatch(source, /outcome: 'sent'/);
  assert(source.indexOf('const schemaEvidence = requireSchemaEvidence()') < source.indexOf('const connection = await context()'));
  assert(source.indexOf('await pool.end()') < source.indexOf('await withTestCleanup('));
});
