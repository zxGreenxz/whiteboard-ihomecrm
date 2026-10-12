import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArguments, targetMatches, captureSourceIdentity, finalizeReceipt, validateBackupManifest, verifyBackup, fixturePlan, fixtureSetupSql,
  privateCleanupSql, roleSetupSql, roleCleanupSql, countsSql, expectRejection, guardedQuery, safeError, loadFixtureCa,
  fixtureCleanupOutcome, rpcDiagnostic, captureRpcResponse, fixtureOrganizationScopeCountsSql,
  createGuardedStoreTransport, guardedConnectionCall, createLeaseReadFetch, createTrackedControlFetch,
  guardedControlConnect, assertBrokerContext, createSerializedLeaseAssertions } from '../test-hermes-durable-store.mjs';
import { validateCleanupEvidence } from '../test-hermes-broker-authz.mjs';
import { createDurableConnectionStore } from '../../infra/hermes-broker/durable-connection-store.mjs';

const REF = 'abcdefghijklmnopqrst';
const assigned = () => { const plan = fixturePlan(); plan.actors.forEach(actor => { actor.id = randomUUID(); }); return plan; };
const ctx = () => ({ test: 'fixture-test', lease: {}, writeState: { uncertain: false } });
const ready = async () => {};

test('CLI requires immutable TEST identity before credential or network access', () => {
  assert.deepEqual(parseArguments(['--env', 'test', '--expected-project-ref', REF, '--backup-manifest', 'fixture.json']),
    { environment: 'test', expectedProjectRef: REF, backupManifestPath: 'fixture.json' });
  for (const args of [[], ['--env', 'test'], ['--env', 'prod', '--expected-project-ref', REF],
    ['--env', 'test', '--expected-project-ref', 'tryymsxyyckgbrmmvozx'],
    ['--env', 'test', '--expected-project-ref', REF, '--sql', 'select 1']]) {
    assert.throws(() => parseArguments(args), /explicit_test_target_and_backup_required/);
  }
});
test('role provisioning requires a fresh full TEST dump with actual bytes/hash integrity', () => {
  const now = Date.now(), sha256 = 'a'.repeat(64);
  const manifest = { environment: 'test', projectRef: REF, kind: 'full', excludedTableData: [], tablesWithData: 500,
    createdAt: new Date(now - 1000).toISOString(), bytes: 500, sha256 };
  const evidence = validateBackupManifest(manifest, { expectedProjectRef: REF, now, bytes: 500, sha256 });
  assert(Object.isFrozen(evidence)); assert.equal(evidence.sha256, sha256);
  for (const change of [{ environment: 'prod' }, { projectRef: 'zzzzzzzzzzzzzzzzzzzz' }, { kind: 'schema' },
    { excludedTableData: ['private.sessions'] }, { tablesWithData: 1 }, { bytes: 501 }, { sha256: 'b'.repeat(64) },
    { createdAt: new Date(now - 60 * 60_000 - 1).toISOString() }, { createdAt: new Date(now + 1).toISOString() }]) {
    assert.throws(() => validateBackupManifest({ ...manifest, ...change }, { expectedProjectRef: REF, now, bytes: 500, sha256 }));
  }
});
test('backup target mismatch refuses before reading the dump and valid evidence records no file path', async () => {
  let reads = 0;
  const manifest = { environment: 'test', projectRef: REF, kind: 'full', excludedTableData: [], tablesWithData: 500,
    createdAt: new Date().toISOString(), bytes: 500, sha256: 'a'.repeat(64), file: 'private-backup.dump' };
  const dependencies = { readManifest: () => manifest, fileSize: () => { reads++; return 500; }, fileHash: async () => 'a'.repeat(64) };
  await assert.rejects(verifyBackup('fixture.json', 'zzzzzzzzzzzzzzzzzzzz', dependencies), /backup_target_mismatch/);
  assert.equal(reads, 0);
  const value = await verifyBackup('fixture.json', REF, dependencies);
  assert.equal(reads, 1); assert(!('file' in value));
});
test('a mixed project, postgres username or pooler port fails before fixture work', () => {
  const cred = { testRef: REF }, db = { ref: REF, user: `postgres.${REF}`, port: 5432 };
  assert.doesNotThrow(() => targetMatches(REF, cred, db));
  for (const changed of [{ ...db, ref: 'zzzzzzzzzzzzzzzzzzzz' }, { ...db, user: 'postgres' }, { ...db, port: 6543 }]) {
    assert.throws(() => targetMatches(REF, cred, changed), /test_target_mismatch/);
  }
  assert.throws(() => targetMatches(REF, { testRef: 'zzzzzzzzzzzzzzzzzzzz' }, db), /test_target_mismatch/);
});
test('source receipt hashes store/provider/guard dependencies and selected SQL without secrets', () => {
  const seen = [];
  const migrations = [{ path: 'supabase/migrations/fixture_hermes.sql' }];
  const identity = captureSourceIdentity({ migrations, readSource: path => { seen.push(path); return `fixture:${path}`; } });
  assert(seen.includes('infra/hermes-broker/store-pool.mjs'));
  assert(seen.includes('infra/hermes-broker/store-transport.mjs'));
  assert(seen.includes('infra/hermes-broker/supabase-refresh-provider.mjs'));
  for (const file of ['durable-connection-store', 'durable-authority', 'supabase-durable-auth-adapter', 'connection-control-plane']) {
    assert(seen.includes(`infra/hermes-broker/${file}.mjs`));
  }
  assert(seen.includes('scripts/test-env/lock.mjs'));
  assert(seen.includes('infra/hermes-broker/certs/supabase-ca-2021.crt'));
  assert(seen.includes('supabase/migrations/fixture_hermes.sql'));
  assert(seen.every(path => !/CLAUDE|\.env|secret|password|\.cache/.test(path)));
  assert(Object.values(identity).every(value => /^[0-9a-f]{64}$/.test(value)));
  const changed = captureSourceIdentity({ migrations, readSource: path => `changed:${path}` });
  assert.notDeepEqual(identity, changed);
});

test('unreadable final source writes immutable FAIL and replaces stale latest PASS without exposing errors', t => {
  const directory = mkdtempSync(join(tmpdir(), 'hermes-durable-receipt-'));
  const runId = randomUUID(), latest = join(directory, 'receipt.json'), immutable = join(directory, `receipt.${runId}.json`);
  t.after(() => { for (const file of [latest, immutable]) { try { unlinkSync(file); } catch {} } rmdirSync(directory); });
  writeFileSync(latest, JSON.stringify({ passed: 99, failed: 0, fixture: { runId: 'previous-run' } }));
  const initial = captureSourceIdentity({ migrations: [], readSource: () => 'initial-source' });
  const report = { sourceIdentity: { initialSha256: initial }, fixture: { runId, cleanupVerified: true },
    cases: [{ name: 'fixture.cleanup_verified', status: 'PASS' }] };
  const result = finalizeReceipt(report, latest, { capture: () => captureSourceIdentity({ migrations: [],
    readSource: () => { throw new Error('PRIVATE_FILE_PATH_OR_SECRET'); } }) });
  assert.equal(result.sourceIdentity.finalSha256, null); assert.equal(result.sourceIdentity.inputsUnchanged, false);
  assert.equal(result.failed, 2);
  assert(result.cases.some(item => item.code === 'source_unreadable_after_run'));
  assert(result.cases.some(item => item.code === 'source_changed_during_run'));
  const bytes = readFileSync(immutable, 'utf8');
  assert.equal(readFileSync(latest, 'utf8'), bytes);
  assert.equal(JSON.parse(bytes).fixture.runId, runId);
  assert(!bytes.includes('PRIVATE_FILE_PATH_OR_SECRET'));
  assert.throws(() => finalizeReceipt({ ...report, cases: [], sourceIdentity: { initialSha256: initial } }, latest,
    { capture: () => initial }), /EEXIST/);
  assert.equal(readFileSync(immutable, 'utf8'), bytes); assert.equal(readFileSync(latest, 'utf8'), bytes);
});
test('fixture owns fresh users/orgs and a uniquely scoped disposable login', () => {
  const a = assigned(), b = assigned();
  assert.notEqual(a.run, b.run); assert.notEqual(a.role, b.role);
  assert.match(a.role, /^hermes_store_fixture_[0-9a-f]{32}$/);
  assert(a.actors.every(actor => actor.email.startsWith('hermes-p2-') && actor.email.endsWith('@example.invalid')));
  assert(a.orgs.every(org => org.slug.startsWith('hermes-p2-')));
  const create = roleSetupSql(a);
  assert.match(create, /LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/);
  assert.doesNotMatch(create, /IF NOT EXISTS|ALTER ROLE|service_role|postgres/);
  assert.equal(roleCleanupSql(a), `DROP ROLE IF EXISTS "${a.role}"`);
  for (const role of ['postgres', 'authenticated', 'hermes_store_executor', 'hermes_store_prod']) {
    assert.throws(() => roleCleanupSql({ ...a, role }), /fixture_role_invalid/);
  }
});
test('fixture rights are scoped to synthetic orgs and retain ordinary constraint triggers', () => {
  const plan = assigned(), sql = fixtureSetupSql(plan);
  assert.match(sql, /'users.edit','ALLOW'/); assert.match(sql, /scope_type='ORGANIZATION'/);
  assert.doesNotMatch(sql, /session_replication_role|disable trigger|truncate|aaaa0000|dddd0000/i);
  for (const org of plan.orgs) assert(sql.includes(org.id));
  assert.equal((sql.match(/\bBEGIN;/g) ?? []).length, 1);
  assert.equal((sql.match(/\bCOMMIT;/g) ?? []).length, 1);
});
test('fresh fixture organizations explicitly get their required ORGANIZATION scopes before policy role bindings', () => {
  const plan = assigned(), sql = fixtureSetupSql(plan), counts = fixtureOrganizationScopeCountsSql(plan);
  assert.equal((sql.match(/insert into public.authorization_scopes\(organization_id,scope_type\)/g) ?? []).length, plan.orgs.length);
  for (const org of plan.orgs) assert(sql.includes(`values ('${org.id}','ORGANIZATION')`));
  const insert = sql.indexOf('insert into public.authorization_scopes');
  assert(insert > sql.indexOf('insert into public.organizations'));
  assert(insert < sql.indexOf("and s.scope_type='ORGANIZATION'"));
  assert(sql.indexOf("'users.edit','ALLOW'") < sql.indexOf("and s.scope_type='ORGANIZATION'"));
  assert.match(counts, /s.organization_id=e.organization_id/);
  for (const org of plan.orgs) assert(counts.includes(org.id));
  for (const member of plan.memberships) assert(counts.includes(member.bindingId));
  assert.doesNotMatch(counts, /insert|update|delete|truncate|disable/i);
  assert.throws(() => fixtureOrganizationScopeCountsSql({ ...plan, memberships: [{ bindingId: "x');drop table x;--" }] }), /fixture_uuid_required/);
});
test('cleanup uses only exact run ids, deletes in FK order and leaves the capability registry intact', () => {
  const plan = assigned(), cleanup = privateCleanupSql(plan);
  assert(cleanup.indexOf('delete from app_private.hermes_connection_tokens') < cleanup.indexOf('delete from app_private.hermes_connections'));
  assert(cleanup.indexOf('delete from app_private.hermes_connections') < cleanup.indexOf('delete from app_private.hermes_sessions'));
  assert(cleanup.indexOf('delete from app_private.hermes_sessions') < cleanup.indexOf('delete from app_private.hermes_assistants'));
  assert.match(cleanup, /delete from public.authorization_audit_events where organization_id in/);
  assert.doesNotMatch(cleanup, /hermes_capabilities|DROP|TRUNCATE|LIKE|CASCADE/i);
  for (const org of plan.orgs) assert(cleanup.includes(org.id));
  assert.throws(() => privateCleanupSql({ ...plan, orgs: [{ id: "x'); drop table x;--" }] }), /fixture_uuid_required/);
  const counts = countsSql(plan);
  for (const name of ['auth.sessions', 'auth.users', 'public.profiles', 'pg_catalog.pg_roles', 'app_private.hermes_sessions', 'public.authorization_audit_events']) assert(counts.includes(name));
  assert(counts.includes(plan.role));
});
test('lease rejection dispatches no SQL and creates no uncertain-write claim', async () => {
  const context = ctx(); let calls = 0;
  await assert.rejects(guardedQuery(context, { query: async () => { calls++; } }, 'fixture', [], { write: true,
    assertLease: async () => { throw new Error('lease_lost'); } }), /lease_lost/);
  assert.equal(calls, 0); assert.equal(context.writeState.uncertain, false);
});
test('a single SQL statement uses extended parameters and no implicit transaction retry', async () => {
  const context = ctx(); const seen = [];
  const client = { query: async value => { seen.push(value); return { rows: [{ ok: true }] }; } };
  const result = await guardedQuery(context, client, 'select $1::text', ['synthetic'], { assertLease: ready });
  assert.deepEqual(result.rows, [{ ok: true }]);
  assert.deepEqual(seen, [{ text: 'select $1::text', values: ['synthetic'], queryMode: 'extended' }]);
});
test('known rejected autocommit writes remain settled, but network/completion uncertainty retains cleanup marker', async () => {
  for (const code of ['23503', '23505', '42501', '40001', '40P01', 'P0001', '57014']) {
    const context = ctx();
    await assert.rejects(guardedQuery(context, { query: async () => { throw { severity: 'ERROR', code }; } }, 'fixture', [], { write: true, assertLease: ready }));
    assert.equal(context.writeState.uncertain, false, code);
  }
  for (const error of [{ code: 'ETIMEDOUT' }, { severity: 'ERROR', code: '40003' }, { severity: 'FATAL', code: '42501' },
    { severity: 'ERROR', code: '57P01' }]) {
    const context = ctx();
    await assert.rejects(guardedQuery(context, { query: async () => { throw error; } }, 'fixture', [], { write: true, assertLease: ready }));
    assert.equal(context.writeState.uncertain, true);
    assert.throws(() => validateCleanupEvidence({ users: 0, sessions: 0 }, context.writeState), /fixture_write_outcome_uncertain/);
  }
});
test('denial checks fail on accidental success and unrelated database outage', async () => {
  await expectRejection(async () => { throw { code: 'store_denied' }; }, ['store_denied']);
  await assert.rejects(expectRejection(async () => {}, ['store_denied']), /expected_rejection_missing/);
  await assert.rejects(expectRejection(async () => { throw { code: 'store_unavailable' }; }, ['store_denied']), /expected_rejection_missing/);
  assert.equal(safeError({ message: 'secret password', code: '28P01' }), 'assertion_or_dependency_failed');
});

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function transportContext() {
  const lease = new AbortController();
  return { context: { ...ctx(), url: `https://${REF}.supabase.co`, lease: { signal: lease.signal }, signal: lease.signal }, lease };
}
test('store wrapper preserves caller and lease cancellation rather than replacing either signal', async () => {
  for (const cancel of ['caller', 'lease']) {
    const { context, lease } = transportContext(), caller = new AbortController(), started = deferred();
    const guarded = createGuardedStoreTransport(context, { call: async (_operation, _payload, { signal }) => {
      started.resolve(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } }, { assertLease: ready });
    const call = guarded.call('readConnection', {}, { signal: caller.signal });
    const rejected = assert.rejects(call, /fixture_abort/);
    await started.promise; (cancel === 'caller' ? caller : lease).abort(new Error('fixture_abort'));
    await rejected; await guarded.drain(); assert.equal(context.writeState.uncertain, false);
  }
});
test('store lease wait is tracked and cancellation after that wait prevents a late SQL dispatch', async () => {
  const { context } = transportContext(), caller = new AbortController(), leaseWait = deferred(), started = deferred(); let calls = 0;
  const guarded = createGuardedStoreTransport(context, { call: async () => { calls++; } }, {
    assertLease: async () => { started.resolve(); await leaseWait.promise; },
  });
  const operation = guarded.call('activate', {}, { signal: caller.signal });
  const rejected = assert.rejects(operation, /fixture_abort/);
  await started.promise; const drained = guarded.drain(); caller.abort(new Error('fixture_abort')); leaseWait.resolve();
  await rejected; await drained; assert.equal(calls, 0); assert.equal(context.writeState.uncertain, false);
  assert.throws(() => guarded.call('activate', {}), /fixture_transport_closing/);
});
test('malformed protocol ACK and unknown control outcomes retain the marker even after transport returned', async () => {
  const { context } = transportContext();
  const store = createDurableConnectionStore({ transport: { call: async () => ({ ok: 'unconfirmed' }) } });
  await assert.rejects(guardedConnectionCall(context, store, 'revokeConnection', { connectionId: randomUUID(), expectedEpoch: 1 }),
    { code: 'store_outcome_unknown' });
  assert.equal(context.writeState.uncertain, true);
  for (const code of ['sign_in_outcome_unknown', 'prepare_outcome_unknown', 'activation_outcome_unknown']) {
    const state = transportContext().context;
    await assert.rejects(guardedControlConnect(state, { connect: async () => { throw { code }; } }, {}));
    assert.equal(state.writeState.uncertain, true, code);
    assert.throws(() => validateCleanupEvidence({ users: 0 }, state.writeState), /fixture_write_outcome_uncertain/);
  }
  const known = transportContext().context;
  await assert.rejects(guardedControlConnect(known, { connect: async () => { throw { code: 'forbidden' }; } }, {}));
  assert.equal(known.writeState.uncertain, false);
  await assert.rejects(guardedConnectionCall(known, store, 'deleteEverything', {}), /fixture_store_operation_refused/);
});
test('Auth read bridge refuses writes and other hosts, and checks cancellation again after lease wait', async () => {
  const { context } = transportContext(), caller = new AbortController(), wait = deferred(), started = deferred(); let calls = 0;
  const options = { method: 'GET', redirect: 'error', signal: caller.signal };
  const read = createLeaseReadFetch(context, { assertLease: async () => { started.resolve(); await wait.promise; },
    request: async () => { calls++; return Response.json({}); } });
  for (const [url, patch] of [[`${context.url}/auth/v1/admin/users`, {}], ['https://other.invalid/auth/v1/user', {}],
    [`${context.url}/auth/v1/user`, { method: 'POST' }], [`${context.url}/auth/v1/user?extra=1`, {}]]) {
    await assert.rejects(read(url, { ...options, ...patch }), /fixture_read_endpoint_refused/);
  }
  const operation = read(`${context.url}/auth/v1/user`, options), rejected = assert.rejects(operation, /fixture_abort/);
  await started.promise; caller.abort(new Error('fixture_abort')); wait.resolve(); await rejected;
  assert.equal(calls, 0);
});
test('parallel authorization reads serialize their shared psql lease checks while HTTP stays parallel and drains', async () => {
  const { context } = transportContext(), firstLease = deferred(), releaseLease = deferred(), bothRequests = deferred();
  const replies = [deferred(), deferred()]; let activeChecks = 0, maxChecks = 0, checks = 0, requests = 0;
  context.assertLease = createSerializedLeaseAssertions(async () => {
    assert.equal(activeChecks, 0, 'one psql session cannot accept concurrent lease queries');
    activeChecks++; maxChecks = Math.max(maxChecks, activeChecks); checks++;
    try { if (checks === 1) { firstLease.resolve(); await releaseLease.promise; } }
    finally { activeChecks--; }
  });
  const read = createLeaseReadFetch(context, { request: async () => {
    const index = requests++; if (requests === 2) bothRequests.resolve(); return replies[index].promise;
  } });
  const options = { method: 'POST', redirect: 'error', signal: context.lease.signal };
  const calls = Promise.all(['/rest/v1/rpc/get_authorization_context_v1', '/rest/v1/rpc/get_my_organizations']
    .map(path => read(context.url + path, options)));
  await firstLease.promise; await new Promise(resolve => setImmediate(resolve));
  assert.equal(checks, 1); assert.equal(requests, 0);
  releaseLease.resolve(); await bothRequests.promise;
  let drained = false; const draining = read.drain().then(() => { drained = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false);
  replies[0].resolve(Response.json({ fixture: 'context' }));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false);
  replies[1].resolve(Response.json({ fixture: 'directory' }));
  const responses = await calls; await draining;
  assert.equal(responses.length, 2); assert.equal(checks, 2); assert.equal(maxChecks, 1);
  assert.equal(context.writeState.uncertain, false);
  await assert.rejects(read(`${context.url}/rest/v1/rpc/get_my_organizations`, options), /fixture_transport_closing/);
});
test('queued Auth read is tracked during lease wait and caller abort prevents its eventual HTTP dispatch', async () => {
  const { context } = transportContext(), firstLease = deferred(), releaseLease = deferred(), caller = new AbortController();
  let checks = 0, requests = 0;
  context.assertLease = createSerializedLeaseAssertions(async () => {
    if (++checks === 1) { firstLease.resolve(); await releaseLease.promise; }
  });
  const read = createLeaseReadFetch(context, { request: async () => { requests++; return Response.json({}); } });
  const options = { method: 'POST', redirect: 'error', signal: context.lease.signal };
  const first = read(`${context.url}/rest/v1/rpc/get_authorization_context_v1`, options);
  const second = read(`${context.url}/rest/v1/rpc/get_my_organizations`, { ...options, signal: caller.signal });
  const rejected = assert.rejects(second, /fixture_abort/);
  await firstLease.promise; const draining = read.drain(); caller.abort(new Error('fixture_abort')); releaseLease.resolve();
  await first; await rejected; await draining;
  assert.equal(checks, 2); assert.equal(requests, 1); assert.equal(context.writeState.uncertain, false);
});
test('all local transports share one lease queue and a failed assertion never admits a request', async () => {
  const { context } = transportContext(); let active = 0, peak = 0, count = 0;
  context.assertLease = createSerializedLeaseAssertions(async () => {
    assert.equal(active, 0); active++; peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve)); active--; count++;
  });
  const request = async () => Response.json({});
  const read = createLeaseReadFetch(context, { request });
  const control = createTrackedControlFetch(context, { request });
  const store = createGuardedStoreTransport(context, { call: async () => ({ status: 'unavailable' }) });
  await Promise.all([
    read(`${context.url}/auth/v1/user`, { method: 'GET', redirect: 'error', signal: context.lease.signal }),
    control.fetch(`${context.url}/auth/v1/token?grant_type=password`, { method: 'POST', redirect: 'error', signal: context.lease.signal }),
    store.call('readConnection', {}),
    guardedQuery(context, { query: async () => ({ rows: [] }) }, 'fixture'),
  ]);
  await Promise.all([read.drain(), control.drainWrites(), store.drain()]);
  assert.equal(count, 4); assert.equal(peak, 1);
  let dispatched = 0;
  context.assertLease = createSerializedLeaseAssertions(async () => { throw new Error('fixture_lease_lost'); });
  const blocked = createLeaseReadFetch(context, { request: async () => { dispatched++; return Response.json({}); } });
  const settled = await Promise.allSettled([1, 2].map(() => blocked(`${context.url}/auth/v1/user`,
    { method: 'GET', redirect: 'error', signal: context.lease.signal })));
  assert(settled.every(item => item.status === 'rejected' && item.reason.message === 'fixture_lease_lost'));
  await blocked.drain(); assert.equal(dispatched, 0);
});
test('control POST remains tracked after caller abort, has no transport AbortSignal and drains before cleanup', async () => {
  const { context } = transportContext(), caller = new AbortController(), reply = deferred(), started = deferred(); let sentSignal;
  const tracked = createTrackedControlFetch(context, { assertLease: ready, request: async (_url, options) => {
    sentSignal = options.signal; started.resolve(); return reply.promise;
  } });
  const operation = tracked.fetch(`${context.url}/auth/v1/token?grant_type=password`,
    { method: 'POST', redirect: 'error', signal: caller.signal, body: 'synthetic' });
  await started.promise; caller.abort(); let drained = false;
  const drain = tracked.drainWrites().then(() => { drained = true; });
  await Promise.resolve(); assert.equal(drained, false); assert.equal(sentSignal, undefined);
  reply.resolve(Response.json({ status: 'fixture' })); await operation; await drain;
  assert.equal(drained, true); assert.equal(context.writeState.uncertain, false);
});
test('control lease wait cannot dispatch a late POST after cancellation and unknown settlement remains marked', async () => {
  const { context } = transportContext(), caller = new AbortController(), wait = deferred(), started = deferred(); let calls = 0;
  const tracked = createTrackedControlFetch(context, { assertLease: async () => { started.resolve(); await wait.promise; },
    request: async () => { calls++; return Response.json({}); } });
  const options = { method: 'POST', redirect: 'error', signal: caller.signal };
  assert.throws(() => tracked.fetch(`${context.url}/auth/v1/token?grant_type=refresh_token`, options), /fixture_control_endpoint_refused/);
  const operation = tracked.fetch(`${context.url}/rest/v1/rpc/hermes_prepare_connection_v1`, options);
  const rejected = assert.rejects(operation, /fixture_abort/);
  await started.promise; const drain = tracked.drainWrites(); caller.abort(new Error('fixture_abort')); wait.resolve();
  await rejected; await drain; assert.equal(calls, 0);
  const second = transportContext(), late = deferred(), sent = deferred();
  const unknown = createTrackedControlFetch(second.context, { drainTimeoutMs: 5, assertLease: ready,
    request: async () => { sent.resolve(); return late.promise; } });
  const pending = unknown.fetch(`${second.context.url}/auth/v1/token?grant_type=password`,
    { ...options, signal: new AbortController().signal });
  await sent.promise; await assert.rejects(unknown.drainWrites(), { code: 'fixture_work_settlement_unknown' });
  assert.equal(second.context.writeState.uncertain, true);
  late.resolve(Response.json({})); await pending;
  assert.equal(second.context.writeState.uncertain, true, 'late settlement does not erase uncertainty');
});
test('broker context assertions reject secret fields, malformed responses and a different actor or organization', () => {
  const binding = { assistantId: randomUUID(), userId: randomUUID(), organizationId: randomUUID() };
  const context = { ...binding, permissions: { read: ['assistant.context.read'], action: [] }, contextVersion: 'a'.repeat(64) };
  const result = value => ({ isError: false, content: [{ type: 'text', text: JSON.stringify(value) }] });
  assert.deepEqual(assertBrokerContext(result(context), binding), context);
  for (const changed of [{ accessToken: 'PRIVATE' }, { userId: randomUUID() }, { organizationId: randomUUID() },
    { permissions: { read: ['rooms.view'], action: [] } }, { contextVersion: 'not-versioned' }]) {
    assert.throws(() => assertBrokerContext(result({ ...context, ...changed }), binding));
  }
  assert.throws(() => assertBrokerContext({ isError: true, content: [] }, binding), /broker_context_invalid/);
});
test('tracked public CA pins DER identity and current validity, accepts LF/CRLF, and retains strict TLS verification', () => {
  const pem = readFileSync(new URL('../../infra/hermes-broker/certs/supabase-ca-2021.crt', import.meta.url), 'utf8');
  const now = Date.parse('2026-10-12T00:00:00Z');
  const checked = loadFixtureCa({ clock: () => now });
  assert.equal(checked.rejectUnauthorized, true); assert(Object.isFrozen(checked));
  const certificate = new X509Certificate(checked.ca);
  assert.equal(certificate.fingerprint256.replaceAll(':', ''), '807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA');
  assert.equal(certificate.ca, true);
  for (const source of [pem.replace(/\r\n/g, '\n'), pem.replace(/\r?\n/g, '\r\n')]) {
    assert.deepEqual(loadFixtureCa({ read: () => source, clock: () => now }), checked);
  }
  for (const source of ['', 'not-a-certificate', pem + pem, pem.replace(/MI/, 'MJ')]) {
    assert.throws(() => loadFixtureCa({ read: () => source, clock: () => now }), /fixture_ca_invalid/);
  }
  for (const date of [NaN, Date.parse(certificate.validFrom) - 1, Date.parse(certificate.validTo)]) {
    assert.throws(() => loadFixtureCa({ clock: () => date }), /fixture_ca_expired_or_not_yet_valid/);
  }
  assert.throws(() => loadFixtureCa({ read: () => { throw new Error('PRIVATE_LOCAL_PATH'); } }), error =>
    error.code === 'fixture_ca_invalid' && !error.message.includes('PRIVATE_LOCAL_PATH'));
});
test('TLS diagnostics allow only known safe codes and pre-fixture failure never claims cleanup or a PASS', t => {
  assert.equal(safeError({ code: 'SELF_SIGNED_CERT_IN_CHAIN', message: 'PRIVATE_DB_HOST' }), 'SELF_SIGNED_CERT_IN_CHAIN');
  assert.equal(safeError({ code: 'ERR_TLS_CERT_ALTNAME_INVALID', message: 'PRIVATE_DB_HOST' }), 'ERR_TLS_CERT_ALTNAME_INVALID');
  assert.equal(safeError({ code: 'PRIVATE_UNKNOWN_SECRET' }), 'assertion_or_dependency_failed');
  assert.deepEqual(fixtureCleanupOutcome({ required: false, verified: false, uncertain: false }), {
    noFixturesCreated: true, cleanupRequired: false, cleanupVerified: false, cleanupStatus: 'not_required',
  });
  assert.deepEqual(fixtureCleanupOutcome({ required: true, verified: true, uncertain: true }), {
    noFixturesCreated: false, cleanupRequired: true, cleanupVerified: false, cleanupStatus: 'unverified',
  });
  const directory = mkdtempSync(join(tmpdir(), 'hermes-tls-receipt-'));
  const runId = randomUUID(), latest = join(directory, 'receipt.json'), immutable = join(directory, `receipt.${runId}.json`);
  t.after(() => { for (const file of [latest, immutable]) unlinkSync(file); rmdirSync(directory); });
  const report = finalizeReceipt({ sourceIdentity: { initialSha256: {} }, fixture: { runId,
    ...fixtureCleanupOutcome({ required: false, verified: false, uncertain: false }) },
  cases: [{ name: 'fixture_or_schema_setup', status: 'FAIL', code: 'SELF_SIGNED_CERT_IN_CHAIN' }] }, latest, { capture: () => ({}) });
  assert.equal(report.passed, 0); assert.equal(report.failed, 1); assert.equal(report.fixture.cleanupVerified, false);
  assert.equal(JSON.parse(readFileSync(latest, 'utf8')).fixture.cleanupStatus, 'not_required');
});
test('RPC diagnostics project fixed endpoint/status/error code/known Hermes marker/version without response data or credentials', () => {
  const body = { code: '42501', message: 'hermes_membership_required', version: 1, details: 'PRIVATE_DETAILS',
    hint: 'PRIVATE_HINT', accessToken: 'PRIVATE_ACCESS', intentSecret: 'PRIVATE_INTENT', organizationId: randomUUID(), read: ['PRIVATE_PERMISSION'] };
  assert.deepEqual(rpcDiagnostic('hermes_set_org_policy_v1', 403, body), {
    endpoint: '/rest/v1/rpc/hermes_set_org_policy_v1', httpStatus: 403, responseKind: 'json',
    errorCode: '42501', hermesMarker: 'hermes_membership_required', version: 1,
  });
  for (const changed of [{ code: 'PRIVATE_ERROR_WITH_TOKEN' }, { message: 'hermes_membership_required PRIVATE_ACCESS' }, { version: 'PRIVATE_ACCESS' }]) {
    const result = rpcDiagnostic('hermes_set_org_policy_v1', 400, { ...body, ...changed });
    assert(!JSON.stringify(result).includes('PRIVATE'));
  }
  assert.equal(rpcDiagnostic('hermes_set_org_policy_v1', 404, { code: 'PGRST202' }).errorCode, 'PGRST202');
  assert.equal(rpcDiagnostic('hermes_set_org_policy_v1', 500, { code: '42883' }).errorCode, '42883');
  assert.throws(() => rpcDiagnostic('private/path', 403, body), /fixture_rpc_refused/);
});
test('RPC failure evidence is captured before caller assertion or JSON parse failure, bounded and never converted into success', async () => {
  const diagnostics = [];
  const result = await captureRpcResponse('hermes_set_org_policy_v1', Response.json({ code: '42501', message: 'PRIVATE_SERVER_MESSAGE' }, { status: 403 }), diagnostics);
  assert.equal(result.status, 403); assert.equal(diagnostics[0].httpStatus, 403); assert.equal(diagnostics[0].hermesMarker, null);
  assert.equal(result.body.version, undefined); assert(!JSON.stringify(diagnostics).includes('PRIVATE_SERVER_MESSAGE'));
  await assert.rejects(captureRpcResponse('hermes_set_org_policy_v1', new Response('PRIVATE_NON_JSON', { status: 502 }), diagnostics), { code: 'fixture_rpc_invalid_json' });
  assert.deepEqual(diagnostics[1], { endpoint: '/rest/v1/rpc/hermes_set_org_policy_v1', httpStatus: 502,
    responseKind: 'invalid_json', errorCode: null, hermesMarker: null, version: null });
  assert.deepEqual(rpcDiagnostic('hermes_set_org_policy_v1', null, null, 'no_response'), {
    endpoint: '/rest/v1/rpc/hermes_set_org_policy_v1', httpStatus: null, responseKind: 'no_response', errorCode: null, hermesMarker: null, version: null,
  });
  const capped = Array(128).fill(null);
  await captureRpcResponse('hermes_set_org_policy_v1', Response.json({ version: 1 }), capped); assert.equal(capped.length, 128);
});
test('harness source keeps actual JWT, restricted transport, source hashes, immutable report and honest first-slice limits', () => {
  const source = readFileSync(new URL('../test-hermes-durable-store.mjs', import.meta.url), 'utf8');
  assert.match(source, /createStorePool\(\{ projectRef: ctx.db.ref/);
  assert.match(source, /createStoreTransport\(\{ pool: restricted, expectedRole: plan.role/);
  assert.match(source, /createDurableConnectionStore\(\{ transport: guardedTransport/);
  assert.match(source, /createSupabaseDurableAuthAdapter\(\{ url: ctx.url/);
  assert.match(source, /createDurableAuthority\(\{ connectionStore, crypto, auth: countedAuth/);
  assert.match(source, /createBroker\(\{ authority/);
  assert.match(source, /createConnectionControlPlane\(\{ auth/);
  assert.match(source, /createSupabaseAssistantSignIn\(\{ url: ctx.url/);
  assert.match(source, /createSupabaseConnectionPreparation\(\{ url: ctx.url/);
  assert.match(source, /assertLease: createSerializedLeaseAssertions\(\)/);
  assert.doesNotMatch(source, /await assertTestLease\(/, 'every harness assertion must use the shared local queue');
  assert.match(source, /trackedReads\?\.drain/);
  assert(source.indexOf('await drain()') < source.indexOf('if (restricted) await restricted.end()'));
  assert.match(source, /ssl: tls/); assert.match(source, /ca: tls.ca/);
  assert(source.indexOf('tls = loadFixtureCa()') < source.indexOf('markTestCleanupRequired(lease, ctx.test)'));
  assert.doesNotMatch(source, /rejectUnauthorized: false|credential\(\)|ketNoi\(\)/);
  assert.match(source, /provider.verifySession\(\{ accessToken: result.access_token/);
  assert.match(source, /markTestCleanupRequired\(lease, ctx.test\)/);
  assert.match(source, /withTestCleanup\(lease, ctx.test/);
  assert.match(source, /schemaAppliedByHarness: false/);
  assert.match(source, /ephemeralRoleChanges: roleCreationConfirmed, ephemeralRoleChangesAttempted: cleanupRequired/);
  assert.match(source, /providerRefresh: false, concurrentTransactions: false/);
  assert.match(source, /docManifestBackup/); assert.match(source, /SAN_BANG_CO_DU_LIEU/);
  assert(source.indexOf('verifiedBackups.has(backup)') < source.indexOf('await testContext(expectedProjectRef)'));
  assert.match(source, /flag: 'wx'/);
  const report = source.slice(source.indexOf('const report ='), source.indexOf('finalizeReceipt(report, reportPath);'));
  assert(report.length > 0);
  assert.doesNotMatch(report, /password|accessToken|refreshToken|sessionEnvelope|rolePassword|testSecretKey|testPublishableKey/);
});
