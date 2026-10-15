import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoreTransport } from './store-transport.mjs';

const principal = () => ({ role: 'hermes_store_test', session_role: 'hermes_store_test', scoped: true, privileged_member: false,
  rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false });
const code = expected => error => error.code === expected;
function setup({ actor = principal(), query, connect, ...options } = {}) {
  const calls = [], releases = [];
  const client = { query: async request => {
    calls.push(request);
    return calls.length === 1 ? { rows: [actor] } : query ? query(request) : { rows: [{ result: { status: 'ok' } }] };
  }, release: destroy => releases.push(destroy) };
  const transport = createStoreTransport({ pool: { connect: connect ?? (async () => client) },
    expectedRole: 'hermes_store_test', ...options });
  const controller = new AbortController();
  return { transport, client, calls, releases, controller, signal: controller.signal };
}

test('fixed private function and JSON parameter are the only database surface', async () => {
  const f = setup();
  assert.deepEqual(await f.transport.call('activate', { intentSecret: "'); DROP TABLE x; --" }, f), { status: 'ok' });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].text, 'SELECT app_private.hermes_store_activate_v1($1::jsonb) AS result');
  assert.equal(f.calls[1].queryMode, 'extended');
  assert.deepEqual(JSON.parse(f.calls[1].values[0]), { intentSecret: "'); DROP TABLE x; --" });
  assert.deepEqual(f.releases, [false]);
});

test('renewal is one fixed private write and a lost response cannot be reported as a read failure', async () => {
  const f = setup();
  await f.transport.call('renewConnection', { requestedTtlMs: 900_000 }, f);
  assert.equal(f.calls[1].text, 'SELECT app_private.hermes_store_renew_connection_v1($1::jsonb) AS result');
  assert.deepEqual(f.calls[1].values, ['{"requestedTtlMs":900000}']);
  const lost = setup({ query: async () => { throw new Error('private'); } });
  await assert.rejects(lost.transport.call('renewConnection', {}, lost), code('store_outcome_unknown'));
  assert.equal(lost.calls.length, 2); assert.deepEqual(lost.releases, [true]);
});

test('private command operations map only to fixed executor functions and every lost ACK is a write outcome unknown', async t => {
  for (const [operation, suffix] of [['claimPrivateCommand', 'claim_private_command'],
    ['dispatchPrivateCommand', 'dispatch_private_command'], ['finishPrivateCommand', 'finish_private_command'],
    ['failPrivateCommand', 'fail_private_command'], ['prunePrivateCommands', 'prune_private_commands']]) {
    await t.test(operation, async () => {
      const f = setup();
      await f.transport.call(operation, { text: "'); SELECT private_secret; --" }, { signal: f.signal });
      assert.equal(f.calls.length, 2);
      assert.equal(f.calls[1].text, `SELECT app_private.hermes_store_${suffix}_v1($1::jsonb) AS result`);
      assert.equal(f.calls[1].queryMode, 'extended');
      assert.deepEqual(JSON.parse(f.calls[1].values[0]), { text: "'); SELECT private_secret; --" });
      const lost = setup({ query: () => { throw new Error('private SQL detail'); } });
      await assert.rejects(lost.transport.call(operation, {}, { signal: lost.signal }), code('store_outcome_unknown'));
      assert.equal(lost.calls.length, 2); assert.deepEqual(lost.releases, [true]);
      for (const [sqlCode, expected] of [['42501', 'store_denied'], ['40001', 'store_conflict'], ['22023', 'store_rejected']]) {
        const denied = setup({ query: () => { throw Object.assign(new Error('private denial'), { code: sqlCode, severity: 'ERROR' }); } });
        await assert.rejects(denied.transport.call(operation, {}, { signal: denied.signal }), code(expected));
        assert.equal(denied.calls.length, 2);
      }
    });
  }
});

test('private command writes retain the dedicated role fence and fixed function names cannot be called directly', async () => {
  for (const role of ['postgres', 'service_role', 'hermes_store_executor']) {
    const f = setup({ actor: { ...principal(), role, session_role: role } });
    await assert.rejects(f.transport.call('claimPrivateCommand', {}, { signal: f.signal }), code('store_principal_refused'));
    assert.equal(f.calls.length, 1);
  }
  const f = setup();
  for (const operation of ['app_private.hermes_store_claim_private_command_v1', 'hermes_store_claim_private_command_v1',
    'claimPrivateCommand; SELECT private_secret', 'toString']) {
    await assert.rejects(f.transport.call(operation, {}, { signal: f.signal }), code('invalid_store_request'));
  }
  assert.equal(f.calls.length, 0);
});

test('arbitrary SQL/function, missing signal and oversized body dispatch nothing', async () => {
  const f = setup({ maxRequestBytes: 20 });
  for (const name of ['rpc', 'constructor', '__proto__', 'public.rooms']) {
    await assert.rejects(f.transport.call(name, {}, f), code('invalid_store_request'));
  }
  await assert.rejects(f.transport.call('readConnection', {}), code('invalid_store_request'));
  await assert.rejects(f.transport.call('readConnection', { text: 'x'.repeat(40) }, f), code('store_request_too_large'));
  assert.equal(f.calls.length, 0);
});

test('dedicated role is required and privilege flags fail closed before any mutation', async () => {
  for (const delta of [{ role: 'postgres' }, { session_role: 'postgres' }, { session_role: 'other_login' },
    { session_role: undefined }, { scoped: false }, { privileged_member: true },
    { rolsuper: true }, { rolbypassrls: true }, { rolcreaterole: true }, { rolcreatedb: true }, { rolreplication: true }]) {
    const f = setup({ actor: { ...principal(), ...delta } });
    await assert.rejects(f.transport.call('activate', {}, f), code('store_principal_refused'));
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.releases, [true]);
  }
});

test('principal is verified once per physical client; new or destroyed clients are verified again', async () => {
  const statements = [], idle = [];
  let actor = principal(), opened = 0;
  const make = () => {
    const self = { query: async request => {
      statements.push(request.text);
      if (/pg_catalog\.pg_roles/.test(request.text)) return { rows: [actor] };
      if (request.values[0] === '{"fail":true}') throw new Error('private connection loss');
      return { rows: [{ result: { status: 'ok' } }] };
    }, release: destroy => { if (!destroy) idle.push(self); } };
    return self;
  };
  const transport = createStoreTransport({ pool: { connect: async () => idle.pop() ?? (opened++, make()) }, expectedRole: 'hermes_store_test' });
  const signal = new AbortController().signal;
  const principalChecks = () => statements.filter(text => /pg_roles/.test(text)).length;
  await transport.call('readConnection', {}, { signal });
  await transport.call('readConnection', {}, { signal });
  assert.equal(opened, 1); assert.equal(principalChecks(), 1); assert.equal(statements.length, 3);
  // A failed read destroys the client; the replacement is a new session.
  await assert.rejects(transport.call('readConnection', { fail: true }, { signal }), code('store_unavailable'));
  actor = { ...principal(), rolbypassrls: true };
  await assert.rejects(transport.call('activate', {}, { signal }), code('store_principal_refused'));
  assert.equal(opened, 2); assert.equal(principalChecks(), 2);
  assert(!statements.slice(-1)[0].includes('hermes_store_activate'), 'no private function after a refused principal');
  actor = principal();
  await transport.call('activate', {}, { signal });
  assert.equal(opened, 3); assert.equal(principalChecks(), 3);
  // Even a pool that wrongly hands back a destroyed client gets a fresh check.
  const reused = setup({ query: request => /pg_roles/.test(request.text) ? { rows: [principal()] }
    : request.values[0] === '{"fail":true}' ? Promise.reject(new Error('private')) : { rows: [{ result: { status: 'ok' } }] } });
  await reused.transport.call('readConnection', {}, reused);
  await assert.rejects(reused.transport.call('readConnection', { fail: true }, reused), code('store_unavailable'));
  await reused.transport.call('readConnection', {}, reused);
  assert.deepEqual(reused.calls.map(request => /pg_roles/.test(request.text) ? 'principal' : 'call'),
    ['principal', 'call', 'call', 'principal', 'call']);
  assert.deepEqual(reused.releases, [false, true, false]);
});

test('lost write response is unknown, releases the connection and never retries', async () => {
  const f = setup({ query: async () => { throw new Error('secret credential detail'); } });
  await assert.rejects(f.transport.call('publishRefresh', {}, f), error => error.code === 'store_outcome_unknown' && !error.message.includes('secret'));
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.releases, [true]);
});

test('read failure is unavailable and does not expose database details', async () => {
  const f = setup({ query: async () => { throw new Error('private query material'); } });
  await assert.rejects(f.transport.call('readConnection', {}, f), code('store_unavailable'));
  assert.deepEqual(f.releases, [true]);
});

test('definite SQL denials/conflicts are safe final errors and never become replay signals', async () => {
  for (const [sqlCode, expected] of [['42501', 'store_denied'], ['40001', 'store_conflict'],
    ['40P01', 'store_conflict'], ['22023', 'store_rejected'], ['23505', 'store_rejected'],
    ['P0001', 'store_rejected'], ['57014', 'store_rejected']]) {
    const f = setup({ query: async () => { throw Object.assign(new Error('secret SQL payload'), { code: sqlCode, severity: 'ERROR' }); } });
    await assert.rejects(f.transport.call('publishRefresh', {}, f), error => error.code === expected && error.message === expected);
    assert.equal(f.calls.length, 2);
    assert.deepEqual(f.releases, [true]);
  }
});

test('fatal, completion-unknown and untyped errors remain ambiguous for a dispatched write', async () => {
  for (const delta of [{ code: '42501' }, { code: '42501', severity: 'FATAL' },
    { code: '40001', severity: 'PANIC' }, { code: '40003', severity: 'ERROR' },
    { code: '08007', severity: 'ERROR' }, { code: 'ECONNRESET' }]) {
    const f = setup({ query: async () => { throw Object.assign(new Error('private detail'), delta); } });
    await assert.rejects(f.transport.call('publishRefresh', {}, f), code('store_outcome_unknown'));
    assert.equal(f.calls.length, 2);
  }
});

test('timeout while a write executes is unknown and late completion cannot be released as success', async () => {
  let finish;
  const f = setup({ timeoutMs: 5, query: () => new Promise(resolve => { finish = resolve; }) });
  await assert.rejects(f.transport.call('stageRefresh', {}, f), code('store_outcome_unknown'));
  assert.deepEqual(f.releases, [true]);
  finish({ rows: [{ result: { status: 'ok' } }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.releases, [true]);
  assert.equal(f.calls.length, 2);
});

test('cancelled or late pool acquisition never dispatches SQL', async () => {
  const pre = setup(); pre.controller.abort();
  await assert.rejects(pre.transport.call('activate', {}, pre), code('store_cancelled'));
  assert.equal(pre.calls.length, 0);
  let connect;
  const f = setup({ timeoutMs: 5, connect: () => new Promise(resolve => { connect = resolve; }) });
  await assert.rejects(f.transport.call('activate', {}, f), code('store_timeout'));
  connect(f.client);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.releases, [true]);
});

test('caller abort destroys the active client without consuming a second statement', async () => {
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const f = setup({ query: () => { entered(); return new Promise(() => {}); } });
  const pending = f.transport.call('revokeConnection', {}, f);
  await ready;
  f.controller.abort();
  await assert.rejects(pending, code('store_outcome_unknown'));
  assert.deepEqual(f.releases, [true]);
});

test('malformed or oversized acknowledgements are not treated as successful writes', async () => {
  for (const rows of [[], [{ result: [] }], [{ result: { text: 'x'.repeat(50) } }]]) {
    const f = setup({ maxResponseBytes: 20, query: async () => ({ rows }) });
    await assert.rejects(f.transport.call('activate', {}, f), code('store_outcome_unknown'));
  }
});

test('dangerous principals and unbounded deadlines are rejected at configuration', () => {
  for (const expectedRole of ['postgres', 'service_role', 'hermes_store_executor', 'hermes_store_x;drop']) {
    assert.throws(() => setup({ expectedRole }));
  }
  assert.throws(() => setup({ timeoutMs: Infinity }));
});
