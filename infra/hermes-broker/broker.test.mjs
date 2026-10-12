import assert from 'node:assert/strict';
import test from 'node:test';
import { BrokerError, createBroker } from './broker.mjs';
import { MemoryConnectionStore, MemorySessionStore } from './stores.mjs';

const USER_A = '10000000-0000-4000-8000-000000000001';
const USER_B = '10000000-0000-4000-8000-000000000002';
const ORG_A = '20000000-0000-4000-8000-000000000001';
const ORG_B = '20000000-0000-4000-8000-000000000002';
const rights = { read: ['assistant.context.read', 'rooms.view'], action: ['rooms.edit'] };
const clone = (value) => structuredClone(value);
const error = (code) => (value) => value.code === code && value.message === code;
const context = (result) => JSON.parse(result.content[0].text);

function fixture(options = {}) {
  let now = 1_000_000;
  let verifyCount = 0;
  const states = new Map([['jwt-a', {
    userId: USER_A, isSuperadmin: false, activeOrganizationIds: [ORG_A], epoch: '1',
    permissions: clone(rights), companyCeilings: clone(rights),
    membership: { organizationId: ORG_A, status: 'ACTIVE', revokedAt: null, validFrom: null, validTo: null },
  }], ['jwt-b', {
    userId: USER_B, isSuperadmin: false, activeOrganizationIds: [ORG_B], epoch: '1',
    permissions: clone(rights), companyCeilings: clone(rights),
    membership: { organizationId: ORG_B, status: 'ACTIVE', revokedAt: null, validFrom: null, validTo: null },
  }]]);
  const auth = {
    async verifySession({ accessToken, signal }) {
      verifyCount += 1;
      await options.beforeVerify?.({ accessToken, signal });
      const state = states.get(accessToken);
      if (!state) throw new Error(`sensitive upstream ${accessToken}`);
      return { userId: state.userId, sessionId: accessToken, expiresAt: 2_000_000 };
    },
    async readAuthorization(input) {
      await options.beforeRead?.(input);
      return clone(states.get(input.accessToken));
    },
  };
  const broker = createBroker({ auth, clock: () => now, ...options.broker });
  return { broker, auth, states, verifyCount: () => verifyCount, advance: (ms) => { now += ms; },
    issue: (accessToken = 'jwt-a', organizationId = ORG_A, restrictions = rights) =>
      broker.issueConnection({ accessToken, organizationId, restrictions }) };
}

test('A/B contexts bind identity, company and stable separate assistant; model args cannot override', async () => {
  const f = fixture();
  const a = await f.issue(), b = await f.issue('jwt-b', ORG_B), again = await f.issue();
  const selfA = context(await f.broker.callTool(a.token, 'crm_auth_context', {}));
  const selfB = context(await f.broker.callTool(b.token, 'crm_auth_context', {}));
  assert.equal(selfA.userId, USER_A); assert.equal(selfA.organizationId, ORG_A);
  assert.equal(selfB.userId, USER_B); assert.equal(selfB.organizationId, ORG_B);
  assert.notEqual(selfA.assistantId, selfB.assistantId);
  assert.equal(a.connection.assistantId, again.connection.assistantId);
  assert.notEqual(a.token, again.token);
  await assert.rejects(f.issue('jwt-a', ORG_B), error('forbidden'));
  for (const args of [{ organizationId: ORG_B }, { userId: USER_B }, { rpc: 'copilot_available_rooms_v1' }, [], null]) {
    await assert.rejects(f.broker.callTool(a.token, 'crm_auth_context', args), error('invalid_request'));
  }
  await assert.rejects(f.broker.callTool(a.token, 'execute_sql', {}), error('tool_not_available'));
});

test('token store contains only digest; session secrets never appear in result or audit', async () => {
  const rows = [];
  const connectionStore = new MemoryConnectionStore();
  const originalCreate = connectionStore.create.bind(connectionStore);
  connectionStore.create = async (row) => { rows.push(clone(row)); await originalCreate(row); };
  const f = fixture({ broker: { connectionStore } });
  const a = await f.issue();
  const reply = await f.broker.callTool(a.token, 'crm_auth_context', {});
  assert.match(rows[0].tokenDigest, /^[a-f0-9]{64}$/);
  const exposed = JSON.stringify([rows, a.connection, reply, f.broker.auditReceipts()]);
  assert.ok(!exposed.includes(a.token)); assert.ok(!exposed.includes('jwt-a'));
  assert.equal(f.broker.auditReceipts().at(-1).outcome, 'prepared');
});

test('read and action ceilings intersect independently and restriction cannot regrant', async () => {
  const f = fixture();
  f.states.get('jwt-a').companyCeilings.action = [];
  const a = await f.issue('jwt-a', ORG_A, { read: ['assistant.context.read'], action: ['rooms.edit'] });
  assert.deepEqual(context(await f.broker.callTool(a.token, 'crm_auth_context', {})).permissions,
    { read: ['assistant.context.read'], action: [] });
  await assert.rejects(f.broker.restrictConnection(a.connection.id, rights), error('forbidden'));
  await f.broker.restrictConnection(a.connection.id, { read: [], action: [] });
  assert.deepEqual(await f.broker.listTools(a.token), { tools: [] });
  await assert.rejects(f.broker.callTool(a.token, 'crm_auth_context', {}), error('tool_not_available'));
});

test('fresh permissions revoke access despite discovery and unchanged authorization epoch', async () => {
  const f = fixture(); const a = await f.issue();
  assert.equal((await f.broker.listTools(a.token)).tools.length, 1);
  f.states.get('jwt-a').permissions.read = [];
  await assert.rejects(f.broker.callTool(a.token, 'crm_auth_context', {}), error('tool_not_available'));
});

test('ordinary ambiguous companies and superadmin without selected membership are rejected', async () => {
  const f = fixture(); const state = f.states.get('jwt-a');
  state.activeOrganizationIds = [ORG_A, ORG_B];
  await assert.rejects(f.issue(), error('forbidden'));
  state.isSuperadmin = true;
  const a = await f.issue();
  await assert.rejects(f.issue('jwt-a', ORG_B), error('forbidden'));
  state.isSuperadmin = false;
  await assert.rejects(f.broker.callTool(a.token, 'crm_auth_context', {}), error('forbidden'));
});

test('membership revocation, future activation and expiry fail closed', async () => {
  for (const mutation of [
    (member) => { member.revokedAt = 999_999; },
    (member) => { member.status = 'SUSPENDED'; },
    (member) => { member.validFrom = 1_000_001; },
    (member) => { member.validTo = 1_000_000; },
  ]) {
    const f = fixture(); const a = await f.issue(); mutation(f.states.get('jwt-a').membership);
    await assert.rejects(f.broker.callTool(a.token, 'crm_auth_context', {}), error('forbidden'));
  }
});

test('revoke during the post-read auth call withholds the prepared response', async () => {
  let reads = 0; let issued;
  const f = fixture({ beforeRead: async () => {
    reads += 1;
    if (reads === 3) await f.broker.revokeConnection(issued.connection.id);
  } });
  issued = await f.issue();
  await assert.rejects(f.broker.callTool(issued.token, 'crm_auth_context', {}), error('unauthorized'));
  assert.equal(f.broker.auditReceipts().at(-1).outcome, 'denied');
});

test('mid-flight permission and epoch changes both withhold old context', async () => {
  for (const mutation of [(state) => { state.permissions.action = []; }, (state) => { state.epoch = '2'; }]) {
    let reads = 0;
    const f = fixture({ beforeRead: async () => { if (++reads === 3) mutation(f.states.get('jwt-a')); } });
    const a = await f.issue();
    await assert.rejects(f.broker.callTool(a.token, 'crm_auth_context', {}), error('context_changed'));
  }
});

test('authority changed while async audit waits is rechecked before returning prepared data', async () => {
  for (const mutate of [
    (state) => { state.epoch = 'after-audit'; },
    (state) => { state.permissions.read = []; },
    (state) => { state.membership.revokedAt = 1_000_000; },
  ]) {
    let reachedAudit, finishAudit;
    const reached = new Promise((resolve) => { reachedAudit = resolve; });
    const pending = new Promise((resolve) => { finishAudit = resolve; });
    const events = [];
    const f = fixture({ broker: { audit: async (event) => {
      events.push(event);
      if (event.outcome !== 'denied') { reachedAudit(); await pending; }
    } } });
    const a = await f.issue();
    const call = f.broker.callTool(a.token, 'crm_auth_context', {});
    await reached; mutate(f.states.get('jwt-a')); finishAudit();
    await assert.rejects(call, (error) => ['context_changed', 'forbidden'].includes(error.code));
    assert.equal(events.at(-1).outcome, 'denied');
    assert.equal(events[0].requestId, events.at(-1).requestId);
  }
});

test('contextVersion changes when current authority changes without losing identity', async () => {
  const f = fixture(); const a = await f.issue();
  const first = context(await f.broker.callTool(a.token, 'crm_auth_context', {}));
  f.states.get('jwt-a').epoch = '2';
  const second = context(await f.broker.callTool(a.token, 'crm_auth_context', {}));
  assert.equal(first.assistantId, second.assistantId);
  assert.notEqual(first.contextVersion, second.contextVersion);
});

test('stale, foreign, revoked, and expired credentials are rejected', async () => {
  const f = fixture(); const a = await f.issue();
  await assert.rejects(f.broker.listTools('jwt-a'), error('unauthorized'));
  await assert.rejects(f.broker.listTools(`hc_${'x'.repeat(43)}`), error('unauthorized'));
  f.advance(900_001);
  await assert.rejects(f.broker.listTools(a.token), error('unauthorized'));
  const g = fixture(); const b = await g.issue();
  await g.broker.revokeConnection(b.connection.id);
  await assert.rejects(g.broker.listTools(b.token), error('unauthorized'));
});

test('rate limit and concurrent admission happen before any expensive auth call', async () => {
  const f = fixture({ broker: { limits: { maxRequestsPerMinute: 1 } } }); const a = await f.issue();
  await f.broker.listTools(a.token); const count = f.verifyCount();
  await assert.rejects(f.broker.listTools(a.token), error('rate_limited'));
  assert.equal(f.verifyCount(), count);
  let resolve; let entered; let block = false;
  const waiting = new Promise((done) => { entered = done; });
  const g = fixture({ broker: { limits: { maxConcurrentCalls: 1 } }, beforeVerify: async () => {
    if (block) { entered(); await new Promise((done) => { resolve = done; }); }
  } });
  const b = await g.issue(); block = true;
  const first = g.broker.listTools(b.token); await waiting;
  const before = g.verifyCount();
  await assert.rejects(g.broker.listTools(b.token), error('busy'));
  assert.equal(g.verifyCount(), before);
  block = false; resolve(); await first;
});

test('timeout aborts work, frees admission, and audit records timeout', async () => {
  let block = false;
  const f = fixture({ broker: { limits: { timeoutMs: 20, maxConcurrentCalls: 1 } }, beforeVerify: async ({ signal }) => {
    if (block) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
  } });
  const a = await f.issue(); block = true;
  await assert.rejects(f.broker.listTools(a.token), error('timeout'));
  block = false;
  assert.equal((await f.broker.listTools(a.token)).tools.length, 1);
  assert.ok(f.broker.auditReceipts().some((entry) => entry.outcome === 'timeout'));
});

test('upstream errors and failed audit never return successful data or secret error text', async () => {
  const f = fixture(); const a = await f.issue(); f.states.delete('jwt-a');
  await assert.rejects(f.broker.listTools(a.token), error('backend_unavailable'));
  assert.ok(!JSON.stringify(f.broker.auditReceipts()).includes('sensitive'));
  const g = fixture({ broker: { audit: async () => { throw new Error('private audit key'); } } });
  const b = await g.issue();
  await assert.rejects(g.broker.callTool(b.token, 'crm_auth_context', {}), error('backend_unavailable'));
});

test('result size and maximum token lifetime are bounded', async () => {
  const f = fixture({ broker: { limits: { maxResultBytes: 32 } } }); const a = await f.issue();
  await assert.rejects(f.broker.callTool(a.token, 'crm_auth_context', {}), error('response_too_large'));
  assert.throws(() => createBroker({ auth: f.auth, limits: { tokenLifetimeMs: 900_001 } }), /unsafe_limits/);
});

test('late storage completion after timeout cleans credentials and connection', async () => {
  const connections = new MemoryConnectionStore(); const sessions = new MemorySessionStore();
  let stored; let credential; let release;
  const original = connections.create.bind(connections), put = sessions.put.bind(sessions);
  sessions.put = async (value) => { credential = await put(value); return credential; };
  connections.create = async (row) => { stored = row; await new Promise((done) => { release = done; }); await original(row); };
  const f = fixture({ broker: { connectionStore: connections, sessionStore: sessions, limits: { timeoutMs: 20 } } });
  await assert.rejects(f.issue(), error('timeout'));
  release(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await connections.get(stored.id), null);
  assert.equal(await sessions.get(credential), null);
});

function authorityFixture(options = {}) {
  const now = 1_000_000, calls = [], branded = new WeakSet();
  const connectionId = '30000000-0000-4000-8000-000000000001';
  const state = {
    row: { id: connectionId, assistantId: '40000000-0000-4000-8000-000000000001', userId: USER_A,
      organizationId: ORG_A, state: 'active', epoch: 2, expiresAt: now + 60_000, restrictions: clone(rights) },
    effective: clone(rights), policyEpoch: '1'.repeat(64), isSuperadmin: false, assistantScopeIds: [],
    scopesByPermission: Object.fromEntries([...rights.read, ...rights.action].map(key => [key, { buildingIds: [], cashbookIds: [] }])),
    contextVersion: '2'.repeat(64),
  };
  const authority = {
    async identifyConnection(value, { signal }) {
      calls.push({ operation: 'identify', value, signal });
      return options.identify ? options.identify(state, signal) : { connectionId };
    },
    async resolve(value, { signal }) {
      calls.push({ operation: 'resolve', value, signal }); await options.beforeResolve?.(state, signal);
      const result = clone(state); options.mutate?.(result); branded.add(result); return result;
    },
    async checkUnchanged(value, before, { signal }) {
      calls.push({ operation: 'check', value, signal });
      if (!branded.has(before) || before.contextVersion !== state.contextVersion) throw new BrokerError('context_changed');
      return options.check?.(before);
    },
  };
  const broker = createBroker({ authority, clock: () => now, ...options.broker });
  return { state, calls, authority, broker, token: `hc_${'a'.repeat(43)}`, connectionId };
}

test('injected authority reuses dispatcher and forwards branded receipt; P1 stores and controls are unused', async () => {
  const unreachable = new Proxy({}, { get() { throw new Error('legacy dependency must not run'); } });
  const f = authorityFixture({ broker: { auth: unreachable, sessionStore: unreachable, connectionStore: unreachable, assistantStore: unreachable } });
  const result = context(await f.broker.callTool(f.token, 'crm_auth_context', {}));
  assert.equal(result.contextVersion, f.state.contextVersion);
  assert.deepEqual(result.permissions, rights);
  assert.deepEqual(f.calls.map(call => call.operation), ['identify', 'resolve', 'check']);
  assert(f.calls.every(call => call.value === f.token && call.signal instanceof AbortSignal));
  assert.deepEqual(Object.keys(result).sort(), ['assistantId', 'contextVersion', 'organizationId', 'permissions', 'userId']);
  assert.equal((await f.broker.authenticate(f.token)).id, f.connectionId);
  assert.equal((await f.broker.listTools(f.token)).tools[0].name, 'crm_auth_context');
  for (const call of [() => f.broker.issueConnection({}), () => f.broker.revokeConnection(f.connectionId),
    () => f.broker.restrictConnection(f.connectionId, {})]) await assert.rejects(call(), error('forbidden'));
  await assert.rejects(f.broker.callTool(f.token, 'copilot_available_rooms_v1', {}), error('tool_not_available'));
  for (const bad of [null, {}, { resolve() {}, checkUnchanged() {} }]) {
    assert.throws(() => createBroker({ authority: bad }), /trusted_authority_adapter_required/);
  }
});

test('injected identity shape and scopes are checked before any handler prepares data', async () => {
  for (const mutate of [
    value => { value.accessToken = 'PRIVATE'; }, value => { value.row.credentialRef = USER_B; },
    value => { value.row.userId = 'wrong'; }, value => { value.row.epoch = NaN; },
    value => { value.row.state = 'revoked'; }, value => { value.contextVersion = 'not-an-attestation'; },
    value => { value.effective.read = new Array(1); }, value => { value.effective.read.push('rooms.view'); },
    value => { value.effective.action.push('outside.restrictions'); }, value => { value.effective.extra = []; },
    value => { delete value.policyEpoch; }, value => { value.isSuperadmin = 'true'; },
    value => { value.assistantScopeIds = ['*']; }, value => { value.scopesByPermission = {}; },
    value => { value.scopesByPermission['rooms.view'].buildingIds = new Array(1); },
    value => { value.scopesByPermission['rooms.view'].scopeIds = []; },
  ]) {
    const f = authorityFixture({ mutate });
    await assert.rejects(f.broker.callTool(f.token, 'crm_auth_context', {}), error('backend_unavailable'));
    assert.deepEqual(f.calls.map(call => call.operation), ['identify', 'resolve']);
    assert(!f.broker.auditReceipts().some(receipt => receipt.outcome === 'prepared'));
  }
  const expired = authorityFixture({ mutate: value => { value.row.expiresAt = 1_000_000; } });
  await assert.rejects(expired.broker.authenticate(expired.token), error('unauthorized'));
  for (const identified of [null, {}, { connectionId: 'wrong' }, { connectionId: USER_A, accessToken: 'PRIVATE' }]) {
    const f = authorityFixture({ identify: () => identified });
    await assert.rejects(f.broker.listTools(f.token), error('backend_unavailable'));
    assert.deepEqual(f.calls.map(call => call.operation), ['identify']);
  }
});

test('resolved connection cannot switch away from the id whose quota was reserved', async () => {
  const f = authorityFixture({ mutate: value => { value.row.id = USER_B; }, broker: { limits: { maxRequestsPerMinute: 1 } } });
  await assert.rejects(f.broker.callTool(f.token, 'crm_auth_context', {}), error('context_changed'));
  assert(!f.broker.auditReceipts().some(receipt => receipt.outcome === 'prepared'));
  await assert.rejects(f.broker.listTools(f.token), error('rate_limited'));
  assert.equal(f.calls.filter(call => call.operation === 'resolve').length, 1);
});

test('injected quota reservation blocks expensive resolve before rate and concurrent overrun', async () => {
  const f = authorityFixture({ broker: { limits: { maxRequestsPerMinute: 1 } } });
  await f.broker.listTools(f.token);
  await assert.rejects(f.broker.listTools(f.token), error('rate_limited'));
  assert.equal(f.calls.filter(call => call.operation === 'resolve').length, 1);
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const g = authorityFixture({ broker: { limits: { maxConcurrentCalls: 1 } }, beforeResolve: async () => { entered(); await blocked; } });
  const first = g.broker.listTools(g.token); await ready;
  await assert.rejects(g.broker.listTools(g.token), error('busy'));
  assert.equal(g.calls.filter(call => call.operation === 'resolve').length, 1);
  release(); await first;
});

test('injected timeout aborts resolve, prevents late audit, and releases admission', async () => {
  let settle, slow = true;
  const f = authorityFixture({ broker: { limits: { timeoutMs: 20, maxConcurrentCalls: 1 } },
    beforeResolve: async () => { if (slow) await new Promise(resolve => { settle = resolve; }); } });
  await assert.rejects(f.broker.listTools(f.token), error('timeout'));
  assert(f.calls.every(call => call.signal.aborted));
  slow = false; settle(); await new Promise(resolve => setImmediate(resolve));
  assert(!f.broker.auditReceipts().some(receipt => receipt.outcome === 'prepared'));
  assert.equal((await f.broker.listTools(f.token)).tools.length, 1);
});

test('injected postcheck cannot signal denial as a successful false result', async () => {
  const f = authorityFixture({ check: () => false });
  await assert.rejects(f.broker.callTool(f.token, 'crm_auth_context', {}), error('backend_unavailable'));
  assert.equal(f.broker.auditReceipts().at(-1).outcome, 'denied');
});
