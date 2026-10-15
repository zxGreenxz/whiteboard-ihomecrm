import { StoreTransportError } from './store-transport.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDurableAuthority } from './durable-authority.mjs';
import { createDurableConnectionStore } from './durable-connection-store.mjs';
import { createSessionCrypto } from './session-crypto.mjs';
import { BrokerError, createBroker } from './broker.mjs';
import { advanceAuthorityRequest, runAuthorityRequest } from './authority-request-scope.mjs';

const id = n => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const ids = { connection: id('1'), assistant: id('2'), user: id('3'), org: id('4'), session: id('5'), credential: id('6'),
  membership: id('7'), assistantScope: id('8'), building: id('9'), cashbook: id('a'), other: id('b') };
const now = 1800000000000;
const token = `hc_${Buffer.alloc(32, 3).toString('base64url')}`;
const tokenDigest = createHash('sha256').update(token).digest('hex');
const binding = () => ({ assistantId: ids.assistant, userId: ids.user, organizationId: ids.org, sessionId: ids.session });
const material = () => ({ accessToken: 'PRIVATE_ACCESS_TOKEN', refreshToken: 'PRIVATE_REFRESH_TOKEN', expiresAt: now + 3600000 });
const grants = () => ({ read: ['assistant.context.read'], action: [] });
const authValue = () => ({ userId: ids.user, isSuperadmin: false, activeOrganizationIds: [ids.org], epoch: 'crm-1',
  membership: { organizationId: ids.org, status: 'ACTIVE', revokedAt: null, validFrom: null, validTo: null,
    membershipId: ids.membership, authorizationVersion: 1 }, permissions: grants(), companyCeilings: grants(),
  scopesByPermission: { 'assistant.context.read': { buildingIds: [], cashbookIds: [] } } });
const code = (expected, status) => error => error instanceof BrokerError && error.code === expected && error.status === status &&
  error.message === expected && error.cause === undefined;
function fixture(t, options = {}) {
  const crypto = createSessionCrypto({ activeKeyVersion: 'fixture', keys: new Map([['fixture', Buffer.alloc(32, 1)]]) });
  t.after(() => crypto.destroy());
  const reply = { status: 'active', connection: { id: ids.connection, assistantId: ids.assistant, organizationId: ids.org, userId: ids.user,
    state: 'active', epoch: 2, restrictions: grants(), scopeIds: [ids.assistantScope], tokenDigest,
    credentialRef: ids.credential, expiresAt: now + 600000 },
  session: { credentialRef: ids.credential, revision: 1, envelope: crypto.seal(material(), binding()), expiresAt: material().expiresAt, binding: binding() },
  membership: { membershipId: ids.membership, authorizationVersion: 1, isSuperadmin: false },
  policy: { version: 1, ...grants(), scopeIds: [ids.assistantScope] } };
  const calls = [], controller = new AbortController();
  const state = { reply, auth: authValue(), verified: { userId: ids.user, sessionId: ids.session, expiresAt: material().expiresAt },
    reads: 0, clock: now };
  const connectionStore = createDurableConnectionStore({ clock: () => state.clock, transport: { call: async (operation, payload, opts) => {
    calls.push({ operation, payload: structuredClone(payload), signal: opts.signal }); state.reads++;
    return options.read ? options.read(state, calls) : structuredClone(state.reply);
  } } });
  const auth = {
    verifySession: async input => { calls.push({ operation: 'verify', ...input }); return options.verify ? options.verify(state, input) : structuredClone(state.verified); },
    readAuthorization: async input => { calls.push({ operation: 'authorize', ...input }); return options.authorize ? options.authorize(state, input) : structuredClone(state.auth); },
  };
  const authority = createDurableAuthority({ connectionStore, crypto: options.crypto ?? crypto, auth,
    clock: () => state.clock, timeoutMs: options.timeoutMs ?? 10000 });
  return { authority, state, calls, crypto, controller, resolve: () => authority.resolve(token, { signal: controller.signal }) };
}

test('resolver uses digest-only SQL, exact AAD, verified bearer and final joined read; returns no credential material', async t => {
  const f = fixture(t), result = await f.resolve();
  assert.deepEqual(f.calls.map(call => call.operation), ['readConnection', 'verify', 'authorize', 'readConnection']);
  for (const call of f.calls.filter(call => call.operation === 'readConnection')) assert.deepEqual(call.payload, { tokenDigest });
  const authCall = f.calls.find(call => call.operation === 'authorize');
  assert.equal(authCall.accessToken, material().accessToken); assert.equal(authCall.userId, ids.user); assert.equal(authCall.organizationId, ids.org);
  assert.deepEqual(result.effective, grants()); assert.deepEqual(result.assistantScopeIds, [ids.assistantScope]);
  assert.match(result.contextVersion, /^[a-f0-9]{64}$/); assert.match(result.policyEpoch, /^[a-f0-9]{64}$/);
  assert(Object.isFrozen(result)); assert(Object.isFrozen(result.row.restrictions.read));
  const serialized = JSON.stringify(result);
  for (const secret of [token, tokenDigest, material().accessToken, material().refreshToken, ids.credential,
    f.state.reply.session.envelope.ciphertext, 'credentialRef', 'envelope', 'sessionId']) assert(!serialized.includes(secret), secret);
  assert.deepEqual(Object.keys(f.authority).sort(), ['checkUnchanged', 'identifyConnection', 'resolve']);
});

test('malformed bearer and unavailable/expired joined sessions fail before Auth; no permissive fallback', async t => {
  const f = fixture(t);
  for (const bad of [undefined, '', 'raw-jwt', token + 'x']) await assert.rejects(f.authority.resolve(bad, { signal: f.controller.signal }), code('unauthorized', 401));
  assert.equal(f.calls.length, 0);
  f.state.reply = { status: 'unavailable' }; await assert.rejects(f.resolve(), code('unauthorized', 401));
  assert(!f.calls.some(call => call.operation === 'verify'));
  const expired = fixture(t); expired.state.reply.connection.expiresAt = now;
  await assert.rejects(expired.resolve(), code('unauthorized', 401));
});

test('neutral policy resolves current user permissions and version zero is bound into authority receipts', async t => {
  const f = fixture(t); f.state.reply.policy.version = 0;
  const neutral = await f.resolve(); assert.deepEqual(neutral.effective, grants());
  f.state.reply.policy.version = 1;
  const explicit = await f.resolve();
  assert.notEqual(neutral.contextVersion, explicit.contextVersion); assert.notEqual(neutral.policyEpoch, explicit.policyEpoch);
  await assert.rejects(f.authority.checkUnchanged(token, neutral, { signal: f.controller.signal }), code('context_changed', 409));
  f.state.reply.policy.version = -1;
  await assert.rejects(f.resolve(), code('backend_unavailable', 503));
});

test('real ciphertext with a different provider-session AAD cannot supply a bearer', async t => {
  const f = fixture(t); f.state.reply.session.binding.sessionId = ids.other;
  await assert.rejects(f.resolve(), code('backend_unavailable', 503));
  assert(!f.calls.some(call => call.operation === 'verify'));
});

test('actual Auth must match user, provider session and encrypted expiry; no JWT decoding substitutes verification', async t => {
  for (const changed of [{ userId: ids.other }, { sessionId: ids.other }, { expiresAt: now }, { expiresAt: now + 1 }]) {
    const f = fixture(t); Object.assign(f.state.verified, changed);
    await assert.rejects(f.resolve(), code('unauthorized', 401)); assert.equal(f.state.reads, 1);
  }
  // CRM authorization is read concurrently with Auth, but an Auth failure still
  // decides the outcome and no final read/admission follows it.
  const denied = fixture(t, { verify: () => { throw new BrokerError('unauthorized'); },
    authorize: () => { throw new BrokerError('forbidden'); } });
  await assert.rejects(denied.resolve(), code('unauthorized', 401)); assert.equal(denied.state.reads, 1);
  const deniedWithLiveCrm = fixture(t, { verify: () => { throw new BrokerError('unauthorized'); } });
  await assert.rejects(deniedWithLiveCrm.resolve(), code('unauthorized', 401)); assert.equal(deniedWithLiveCrm.state.reads, 1);
});

test('strict Auth metadata is mandatory; the old P1 shape, malformed scopes and sparse arrays are refused', async t => {
  for (const mutate of [
    value => { delete value.membership.membershipId; }, value => { delete value.membership.authorizationVersion; },
    value => { delete value.scopesByPermission; }, value => { value.scopesByPermission = {}; },
    value => { value.scopesByPermission['assistant.context.read'].buildingIds = ['*']; },
    value => { value.scopesByPermission['assistant.context.read'].cashbookIds = new Array(1); },
    value => { value.scopesByPermission['assistant.context.read'].scopeIds = []; },
    value => { value.permissions.read = new Array(1); }, value => { value.membership.authorizationVersion = 0; },
  ]) {
    const f = fixture(t); mutate(f.state.auth); await assert.rejects(f.resolve(), code('backend_unavailable', 503));
  }
});

test('ordinary ambiguous org, revoked/future/expired membership and foreign actor are denied; superadmin still requires selected membership', async t => {
  for (const mutate of [
    value => { value.userId = ids.other; }, value => { value.activeOrganizationIds.push(ids.other); },
    value => { value.membership.organizationId = ids.other; }, value => { value.membership.revokedAt = now - 1; },
    value => { value.membership.validFrom = now + 1; }, value => { value.membership.validTo = now; },
    value => { value.isSuperadmin = true; value.activeOrganizationIds = [ids.other]; },
  ]) {
    const f = fixture(t); mutate(f.state.auth); await assert.rejects(f.resolve(), code('forbidden', 403));
  }
  const superadmin = fixture(t); superadmin.state.auth.isSuperadmin = true; superadmin.state.reply.membership.isSuperadmin = true;
  superadmin.state.auth.activeOrganizationIds.push(ids.other);
  assert.equal((await superadmin.resolve()).isSuperadmin, true);
});

test('Auth membership id/version/admin must match the SQL attestation', async t => {
  for (const mutate of [value => { value.membership.membershipId = ids.other; },
    value => { value.membership.authorizationVersion++; }, value => { value.isSuperadmin = true; }]) {
    const f = fixture(t); mutate(f.state.auth); await assert.rejects(f.resolve(), code('context_changed', 409));
  }
});

test('effective permissions intersect all four sources with independent read/action; omitted grants add nothing', async t => {
  const f = fixture(t);
  const read = ['assistant.context.read', 'missing.crm', 'missing.ceiling', 'missing.policy', 'missing.connection'];
  const action = ['action.common', 'action.missing'];
  f.state.auth.permissions = { read: read.filter(key => key !== 'missing.crm'), action };
  f.state.auth.companyCeilings = { read: read.filter(key => key !== 'missing.ceiling'), action: ['action.common'] };
  f.state.reply.policy = { ...f.state.reply.policy, read: read.filter(key => key !== 'missing.policy'), action };
  f.state.reply.connection.restrictions = { read: read.filter(key => key !== 'missing.connection'), action };
  f.state.auth.scopesByPermission = Object.fromEntries([...f.state.auth.permissions.read, ...action].map(key => [key, { buildingIds: [], cashbookIds: [] }]));
  assert.deepEqual((await f.resolve()).effective, { read: ['assistant.context.read'], action: ['action.common'] });
  f.state.reply.connection.restrictions = { read: [], action: [] };
  assert.deepEqual((await f.resolve()).effective, { read: [], action: [] });
});

test('CRM per-permission resource scopes and SQL assistant-scope IDs remain separate, without unions or wildcard empty lists', async t => {
  const f = fixture(t);
  f.state.auth.permissions.read.push('rooms.view', 'cashbooks.view');
  f.state.auth.scopesByPermission['rooms.view'] = { buildingIds: [ids.building], cashbookIds: [] };
  f.state.auth.scopesByPermission['cashbooks.view'] = { buildingIds: [], cashbookIds: [ids.cashbook] };
  f.state.reply.connection.scopeIds.push(ids.building);
  const result = await f.resolve();
  assert.deepEqual(result.assistantScopeIds, [ids.assistantScope]);
  assert.deepEqual(result.scopesByPermission['rooms.view'], { buildingIds: [ids.building], cashbookIds: [] });
  assert.deepEqual(result.scopesByPermission['cashbooks.view'], { buildingIds: [], cashbookIds: [ids.cashbook] });
  f.state.reply.policy.scopeIds = [];
  assert.deepEqual((await f.resolve()).assistantScopeIds, []);
});

test('revoke during Auth prevents admission on the final read', async t => {
  const f = fixture(t, { authorize: state => { state.reply = { status: 'unavailable' }; return authValue(); } });
  await assert.rejects(f.resolve(), code('unauthorized', 401)); assert.equal(f.state.reads, 2);
});

test('every durable identity/version/limits component is compared after awaited Auth, including unchanged-version drift', async t => {
  for (const mutate of [
    row => { row.connection.epoch++; }, row => { row.connection.id = ids.other; },
    row => { row.connection.restrictions.read = []; }, row => { row.connection.scopeIds = []; },
    row => { row.connection.expiresAt++; }, row => { row.session.revision++; }, row => { row.session.binding.sessionId = ids.other; },
    row => { row.session.expiresAt++; }, row => { row.session.envelope.keyVersion = 'changed'; },
    row => { row.membership.authorizationVersion++; }, row => { row.membership.membershipId = ids.other; },
    row => { row.membership.isSuperadmin = true; }, row => { row.policy.version++; }, row => { row.policy.read = []; },
    row => { row.policy.scopeIds = []; },
  ]) {
    const f = fixture(t, { authorize: state => { mutate(state.reply); return structuredClone(state.auth); } });
    await assert.rejects(f.resolve(), code('context_changed', 409));
  }
});

test('comparison receipts are immutable and not authority: postcheck rereads SQL/Auth and detects CRM scope-only changes', async t => {
  const f = fixture(t), before = await f.resolve();
  await f.authority.checkUnchanged(token, before, { signal: f.controller.signal }); assert.equal(f.state.reads, 4);
  await assert.rejects(f.authority.checkUnchanged(token, structuredClone(before), { signal: f.controller.signal }), code('context_changed', 409));
  f.state.auth.scopesByPermission['assistant.context.read'].buildingIds.push(ids.building);
  await assert.rejects(f.authority.checkUnchanged(token, before, { signal: f.controller.signal }), code('context_changed', 409));
  f.state.auth.scopesByPermission['assistant.context.read'].buildingIds = []; f.state.auth.epoch = 'crm-2';
  await assert.rejects(f.authority.checkUnchanged(token, before, { signal: f.controller.signal }), code('context_changed', 409));
});

test('time advancing during the final read cannot admit an expired membership or session', async t => {
  const f = fixture(t, { read: state => { if (state.reads === 2) state.clock = now + 10; return structuredClone(state.reply); } });
  f.state.auth.membership.validTo = now + 5;
  await assert.rejects(f.resolve(), code('forbidden', 403));
  const expired = fixture(t, { read: state => { if (state.reads === 2) state.clock = now + 3600001; return structuredClone(state.reply); } });
  await assert.rejects(expired.resolve(), code('unauthorized', 401));
});

test('dependency errors and bad clock remain sanitized 503; no retry and no plaintext fallback', async t => {
  const f = fixture(t, { authorize: () => { throw new Error(material().accessToken); } });
  await assert.rejects(f.resolve(), code('backend_unavailable', 503)); assert.equal(f.state.reads, 1);
  const invalid = fixture(t); invalid.state.clock = NaN;
  await assert.rejects(invalid.resolve(), code('backend_unavailable', 503));
  const oversized = fixture(t); oversized.state.auth.epoch = 'x'.repeat(131073);
  await assert.rejects(oversized.resolve(), code('backend_unavailable', 503));
});

test('abort before dispatch and abort while Auth awaits stop all later reads, including an uncancellable late result', async t => {
  let settle;
  const f = fixture(t, { verify: () => new Promise(resolve => { settle = resolve; }) });
  const result = f.resolve();
  while (!settle) await new Promise(resolve => setImmediate(resolve));
  const rejected = assert.rejects(result, code('backend_unavailable', 503)); f.controller.abort(); await rejected;
  settle(f.state.verified); await new Promise(resolve => setImmediate(resolve));
  // The concurrent CRM read shares the aborted signal; nothing reads storage again.
  assert.equal(f.state.reads, 1); assert.equal(f.calls.filter(call => call.operation === 'authorize').length, 1);
  assert(f.calls.every(call => call.signal.aborted));
  const prior = fixture(t); prior.controller.abort(); await assert.rejects(prior.resolve(), code('backend_unavailable', 503));
  assert.equal(prior.calls.length, 0);
});

test('resolver bounds an unresponsive Auth dependency without retry and requires explicit AbortSignal', async t => {
  const f = fixture(t, { timeoutMs: 5, verify: () => new Promise(() => {}) });
  await assert.rejects(f.resolve(), code('backend_unavailable', 503)); assert.equal(f.state.reads, 1);
  assert(f.calls.every(call => call.signal.aborted));
  const invalid = fixture(t);
  await assert.rejects(invalid.authority.resolve(token), code('backend_unavailable', 503)); assert.equal(invalid.calls.length, 0);
});

test('quota identification is token-bound joined storage only, not an Auth or crypto operation', async t => {
  const f = fixture(t, { crypto: { open() { throw new Error('must not decrypt for admission'); } } });
  const result = await f.authority.identifyConnection(token, { signal: f.controller.signal });
  assert.deepEqual(result, { connectionId: ids.connection }); assert(Object.isFrozen(result));
  assert.deepEqual(f.calls.map(call => call.operation), ['readConnection']);
  assert.deepEqual(f.calls[0].payload, { tokenDigest });
  f.state.reply.connection.tokenDigest = '0'.repeat(64);
  await assert.rejects(f.authority.identifyConnection(token, { signal: f.controller.signal }), code('backend_unavailable', 503));
  f.state.reply = { status: 'unavailable' };
  await assert.rejects(f.authority.identifyConnection(token, { signal: f.controller.signal }), code('unauthorized', 401));
  const invalid = fixture(t);
  await assert.rejects(invalid.authority.identifyConnection('raw-jwt', { signal: invalid.controller.signal }), code('unauthorized', 401));
  await assert.rejects(invalid.authority.identifyConnection(token), code('backend_unavailable', 503));
  assert.equal(invalid.calls.length, 0);
});

test('broker consumes durable context version including scope-only drift without cloning the branded receipt', async t => {
  const f = fixture(t), broker = createBroker({ authority: f.authority, clock: () => f.state.clock });
  const expected = await f.resolve(); f.calls.length = 0;
  const first = JSON.parse((await broker.callTool(token, 'crm_auth_context', {})).content[0].text);
  assert.equal(first.contextVersion, expected.contextVersion);
  // Admission identify read opens the first resolve; the post-audit check is fully fresh.
  assert.deepEqual(f.calls.map(call => call.operation), ['readConnection', 'verify', 'authorize', 'readConnection',
    'readConnection', 'verify', 'authorize', 'readConnection']);
  f.state.auth.scopesByPermission['assistant.context.read'].buildingIds.push(ids.building);
  const second = JSON.parse((await broker.callTool(token, 'crm_auth_context', {})).content[0].text);
  assert.notEqual(second.contextVersion, first.contextVersion);
  assert.equal(second.assistantId, first.assistantId); assert.deepEqual(second.permissions, first.permissions);
  for (const secret of [material().accessToken, material().refreshToken, tokenDigest, ids.credential]) {
    assert(!JSON.stringify([first, second, broker.auditReceipts()]).includes(secret));
  }
});

test('comparison receipts cannot cross authority instances, including broker adapter miswiring', async t => {
  const a = fixture(t), b = fixture(t), before = await a.resolve();
  await assert.rejects(b.authority.checkUnchanged(token, before, { signal: b.controller.signal }), code('context_changed', 409));
  assert.equal(b.calls.length, 0);
  const broker = createBroker({ clock: () => now, authority: { identifyConnection: a.authority.identifyConnection,
    resolve: a.authority.resolve, checkUnchanged: b.authority.checkUnchanged } });
  await assert.rejects(broker.callTool(token, 'crm_auth_context', {}), code('context_changed', 409));
  assert.equal(broker.auditReceipts().at(-1).outcome, 'denied'); assert.equal(b.calls.length, 0);
});

test('real durable postcheck withholds context revoked or changed during awaited audit', async t => {
  for (const mutate of [state => { state.reply = { status: 'unavailable' }; },
    state => { state.reply.policy.version++; },
    state => { state.auth.scopesByPermission['assistant.context.read'].buildingIds.push(ids.building); }]) {
    const f = fixture(t), events = [];
    let reached, finish;
    const ready = new Promise(resolve => { reached = resolve; });
    const blocked = new Promise(resolve => { finish = resolve; });
    const broker = createBroker({ authority: f.authority, clock: () => now, audit: async event => {
      events.push(event); if (event.outcome === 'prepared') { reached(); await blocked; }
    } });
    const response = broker.callTool(token, 'crm_auth_context', {});
    await ready; mutate(f.state); finish();
    await assert.rejects(response, error => ['unauthorized', 'context_changed'].includes(error.code));
    assert.equal(events.at(-1).outcome, 'denied'); assert.equal(events[0].requestId, events.at(-1).requestId);
  }
});

test('a storage id switch between quota identification and resolve never releases another connection context', async t => {
  const f = fixture(t, { read: state => {
    if (state.reads >= 2) state.reply.connection.id = ids.other;
    return structuredClone(state.reply);
  } });
  const broker = createBroker({ authority: f.authority, clock: () => now });
  await assert.rejects(broker.callTool(token, 'crm_auth_context', {}), code('context_changed', 409));
  // The identify snapshot is the opening read; the closing read sees the switch.
  assert.equal(f.state.reads, 2);
  assert(!broker.auditReceipts().some(receipt => receipt.outcome === 'prepared'));
});

test('request window hands one result to exactly one following resolve of the same checkpoint only', async t => {
  const f = fixture(t), other = fixture(t), signal = f.controller.signal;
  const fresh = () => f.calls.filter(call => call.operation === 'verify').length;
  await runAuthorityRequest(async () => {
    const identified = await f.authority.identifyConnection(token, { signal });
    assert.equal(identified.connectionId, ids.connection);
    const first = await f.authority.resolve(token, { signal });
    assert.equal(f.state.reads, 2, 'identify snapshot opens the first resolve'); assert.equal(fresh(), 1);
    const handed = await f.authority.resolve(token, { signal });
    assert.equal(handed, first); assert.equal(fresh(), 1); assert.equal(f.state.reads, 2);
    await f.authority.resolve(token, { signal });
    assert.equal(fresh(), 2, 'a second consumer reads Auth/SQL again'); assert.equal(f.state.reads, 4);
    // Another authority instance never sees this instance's hand-over.
    await other.authority.resolve(token, { signal: other.controller.signal });
    assert.equal(other.calls.filter(call => call.operation === 'verify').length, 1);
    await f.authority.resolve(token, { signal });
    advanceAuthorityRequest();
    f.state.reply = { status: 'unavailable' };
    await assert.rejects(f.authority.resolve(token, { signal }), code('unauthorized', 401));
    await assert.rejects(f.authority.checkUnchanged(token, first, { signal }), code('unauthorized', 401));
  });
  // Outside a broker invocation every resolve is fresh.
  const g = fixture(t);
  await g.resolve(); await g.resolve();
  assert.equal(g.calls.filter(call => call.operation === 'verify').length, 2); assert.equal(g.state.reads, 4);
  const aborted = fixture(t);
  await runAuthorityRequest(async () => {
    await aborted.resolve(); aborted.controller.abort();
    await assert.rejects(aborted.resolve(), code('backend_unavailable', 503));
  });
});

 test('known SQL membership denial maps to forbidden on initial and final reads; outages and lookalike errors remain unavailable', async t => {
  for (const at of [1, 2]) {
    const f = fixture(t, { read: state => { if(state.reads === at) throw new StoreTransportError('store_denied'); return structuredClone(state.reply); } });
    await assert.rejects(f.resolve(), code('forbidden', 403));
  }
  for (const error of [new StoreTransportError('store_unavailable'), new StoreTransportError('store_outcome_unknown'),
    new StoreTransportError('store_conflict'), { code: 'store_denied' }]) {
    const f=fixture(t,{read:()=>{throw error;}});
    await assert.rejects(f.resolve(),code('backend_unavailable',503));
  }
 });
