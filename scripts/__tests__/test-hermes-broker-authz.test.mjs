import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { captureSourceIdentity, sourceIdentityUnchanged, parseArguments, readTestCredentials, fixturePlan, fixtureSetupSql, fixtureCleanupSql,
  testFetch, writeFixtureSql, validateCleanupEvidence, expectBrokerRejection } from '../test-hermes-broker-authz.mjs';

test('receipt hashes exact code inputs and detects a changed broker without reading secrets', () => {
  const accessed = [];
  const initial = captureSourceIdentity({ readSource: file => { accessed.push(file); return `original:${file}`; } });
  const same = captureSourceIdentity({ readSource: file => `original:${file}` });
  const changed = captureSourceIdentity({ readSource: file => file === 'infra/hermes-broker/broker.mjs' ? 'changed boundary' : `original:${file}` });
  assert.equal(sourceIdentityUnchanged(initial, same), true);
  assert.equal(sourceIdentityUnchanged(initial, changed), false);
  assert.equal(accessed.length, 8);
  assert(accessed.every(file => file.endsWith('.mjs') && !file.includes('CLAUDE.local')));
  assert(Object.values(initial).every(digest => /^[a-f0-9]{64}$/.test(digest)));
  assert('scripts/test-env/lock.mjs' in initial && 'scripts/lib/vault.mjs' in initial);
});

test('CLI never defaults a target and refuses production/extra arguments', () => {
  assert.deepEqual(parseArguments(['--env', 'test']), { environment: 'test' });
  for (const args of [[], ['--env', 'prod'], ['--env', 'test', '--force'], ['test']]) {
    assert.throws(() => parseArguments(args), /explicit_test_environment_required/);
  }
});

test('credential lookup reads only TEST values and never generates a password seed', () => {
  const names = [];
  const values = { TEST_SUPABASE_REF: 'abcdefghijklmnopqrst', TEST_SUPABASE_SECRET_KEY: 'fixture-admin-key',
    TEST_SUPABASE_PUBLISHABLE_KEY: 'fixture-publishable-key' };
  const cred = readTestCredentials({ env: {}, readVault: name => { names.push(name); return values[name]; } });
  assert.equal(cred.testRef, values.TEST_SUPABASE_REF);
  assert(names.every(name => name.startsWith('TEST_SUPABASE_')));
  assert(!names.some(name => /SEED|PASSWORD|^SUPABASE_/.test(name)));
  assert.throws(() => readTestCredentials({ env: { ...values, TEST_SUPABASE_REF: 'tryymsxyyckgbrmmvozx' }, readVault: () => null }), /test_target_required/);
});

test('fixture is independent: three synthetic identities and two wholly new tenant scopes', () => {
  const plan = fixturePlan();
  assert.equal(plan.actors.length, 3); assert.equal(plan.orgs.length, 2); assert.equal(plan.memberships.length, 4);
  assert.equal(new Set(plan.actors.map(actor => actor.email)).size, 3);
  assert(plan.actors.every(actor => actor.email.endsWith('@example.invalid')));
  plan.actors.forEach(actor => { actor.id = randomUUID(); });
  const setup = fixtureSetupSql(plan), cleanup = fixtureCleanupSql(plan);
  assert.match(setup, /public\.organization_roles/);
  assert.match(setup, /'rooms.view','ALLOW'/);
  assert.doesNotMatch(setup + cleanup, /session_replication_role|disable trigger|aaaa0000|dddd0000|truncate|\blike\b/i);
  for (const org of plan.orgs) { assert(setup.includes(org.id)); assert(cleanup.includes(org.id)); }
  assert(cleanup.indexOf('delete from public.role_binding_scopes') < cleanup.indexOf('delete from public.role_bindings'));
  assert(cleanup.indexOf('delete from public.authorization_scopes') < cleanup.indexOf('delete from public.buildings'));
  assert(cleanup.indexOf('delete from public.organization_memberships') < cleanup.indexOf('delete from public.organizations'));
});

test('cleanup refuses malformed scope identifiers instead of expanding the delete', () => {
  const plan = fixturePlan(); plan.orgs[0].id = "x'); delete from organizations;--";
  assert.throws(() => fixtureCleanupSql(plan), /fixture_uuid_required/);
});

test('a write settles without abort propagation and records uncertain HTTP outcomes', async () => {
  const controller = new AbortController();
  const ctx = { signal: controller.signal, writeState: { uncertain: false } };
  await testFetch(ctx, 'https://fixture.invalid', { method: 'POST' }, { write: true, fetchImpl: async (_url, opts) => {
    assert.equal(opts.signal, undefined); return { status: 503 };
  } });
  assert.equal(ctx.writeState.uncertain, true);
  const untouched = { signal: controller.signal, writeState: { uncertain: false } };
  await assert.rejects(testFetch(untouched, 'https://fixture.invalid', {}, { write: true, fetchImpl: async () => { throw new Error('network'); } }), /network/);
  assert.equal(untouched.writeState.uncertain, true);
});

test('aborted lease starts no new HTTP operation; reads carry the cancellation signal', async () => {
  const controller = new AbortController(); let calls = 0;
  const ctx = { signal: controller.signal, writeState: { uncertain: false } };
  await testFetch(ctx, 'https://fixture.invalid', {}, { fetchImpl: async (_url, opts) => {
    calls += 1; assert.equal(opts.signal, controller.signal); return { status: 200 };
  } });
  controller.abort(new Error('lease lost'));
  await assert.rejects(testFetch(ctx, 'https://fixture.invalid', {}, { write: true, fetchImpl: async () => { calls += 1; } }), /lease lost/);
  assert.equal(calls, 1); assert.equal(ctx.writeState.uncertain, false);
});

test('SQL timeout is an uncertain write and zero-row cleanup cannot release its marker', async () => {
  const ctx = { test: 'synthetic-test', writeState: { uncertain: false } };
  await assert.rejects(writeFixtureSql(ctx, 'synthetic write', { lease: {}, assertLease: async () => {},
    execute: () => { throw Object.assign(new Error('private driver detail'), { code: 'ETIMEDOUT' }); },
  }), /fixture_sql_failed/);
  assert.equal(ctx.writeState.uncertain, true);
  assert.throws(() => validateCleanupEvidence({ actors: 0, rooms: 0 }, ctx.writeState), /fixture_write_outcome_uncertain/);
});

test('SQL lease rejection starts no write, while a completed write can clean up', async () => {
  const ctx = { test: 'synthetic-test', writeState: { uncertain: false } }; let calls = 0;
  const execute = async () => { calls += 1; };
  await assert.rejects(writeFixtureSql(ctx, '', { assertLease: async () => { throw new Error('lost lease'); }, execute }), /lost lease/);
  assert.equal(calls, 0); assert.equal(ctx.writeState.uncertain, false);
  await writeFixtureSql(ctx, '', { assertLease: async () => {}, execute });
  assert.equal(calls, 1); assert.doesNotThrow(() => validateCleanupEvidence({ actors: 0, rooms: 0 }, ctx.writeState));
  assert.throws(() => validateCleanupEvidence({ actors: 1 }, ctx.writeState), /fixture_cleanup_incomplete/);
});

test('expected-denial assertion rejects accidental success and unrelated backend failure', async () => {
  await expectBrokerRejection(async () => { throw { code: 'forbidden' }; }, ['forbidden']);
  await assert.rejects(expectBrokerRejection(async () => {}, ['forbidden']), /broker_expected_rejection_missing/);
  await assert.rejects(expectBrokerRejection(async () => { throw { code: 'backend_unavailable' }; }, ['forbidden']), /broker_expected_rejection_missing/);
});

test('real harness keeps shared lease/cleanup and authenticated control instead of privileged evidence', () => {
  const source = readFileSync(new URL('../test-hermes-broker-authz.mjs', import.meta.url), 'utf8');
  assert.match(source, /markTestCleanupRequired\(lease, ctx\.test\)/);
  assert.match(source, /withTestCleanup\(lease, ctx\.test/);
  assert.match(source, /await assertLease\(lease, ctx\.test\)/);
  assert.match(source, /fixture_write_outcome_uncertain/);
  assert.match(source, /rpcIsBrokerTool: false/);
  const rpc = source.slice(source.indexOf('async function rpc('), source.indexOf('const parseContext'));
  assert.match(rpc, /testPublishableKey/); assert.match(rpc, /Bearer \$\{accessToken\}/);
  assert.doesNotMatch(rpc, /testSecretKey/);
});
