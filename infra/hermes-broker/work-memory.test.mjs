import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWorkMemoryService } from './work-memory-service.mjs';
import { createSupabaseWorkMemoryReads, createWorkMemoryAuthAdapter } from './work-memory-adapter.mjs';
import { workMemoryInput, workMemoryResult, WORK_MEMORY_TOOLS } from './work-memory-contract.mjs';
import { createWorkMemoryRetention } from './work-memory-retention.mjs';
const id = n => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const user = id('1'), org = id('2'), assistant = id('3'), connection = id('4'), session = id('5'), member = id('6');
const token = 'hc_' + 'A'.repeat(43), now = Date.parse('2026-10-14T00:00:00Z'), expiresAt = now + 900000;
const accessToken = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ role: 'authenticated', sub: user, session_id: session })).toString('base64url')}.signature`;
const identity = { row: { id: connection, assistantId: assistant, userId: user, organizationId: org, state: 'active', epoch: 1, expiresAt,
  restrictions: { read: ['assistant.memory.read'], action: ['assistant.memory.write'] } },
  effective: { read: ['assistant.memory.read'], action: ['assistant.memory.write'] }, policyEpoch: 'a'.repeat(64), contextVersion: 'b'.repeat(64),
  isSuperadmin: false, assistantScopeIds: [], scopesByPermission: { 'assistant.memory.read': { buildingIds: [], cashbookIds: [] }, 'assistant.memory.write': { buildingIds: [], cashbookIds: [] } } };
const binding = { connectionId: connection, tokenDigest: createHash('sha256').update(token).digest('hex'), expectedEpoch: 1,
  expectedPolicyVersion: 0, expectedMembershipId: member, expectedAuthorizationVersion: 1, expectedSessionRevision: 1 };
const status = { organizationId: org, ownerUserId: user, settings: { enabled: false, sharing: 'owner', retentionDays: 30, accessVersion: 0 }, personalMemory: 'outside_crm', remoteCopies: 'not_revocable' };
const options = () => ({ signal: new AbortController().signal });
function setup() {
  const calls = [], state = { identity: structuredClone(identity), result: structuredClone(status), unchanged: true, verifiedUser: user, current: now };
  const joined = { status: 'active', connection: { ...identity.row, tokenDigest: binding.tokenDigest, credentialRef: session },
    session: { credentialRef: session, revision: 1, expiresAt, binding: { assistantId: assistant, userId: user, organizationId: org, sessionId: session }, envelope: {} },
    membership: { membershipId: member, authorizationVersion: 1 }, policy: { version: 0 } };
  const authority = { async resolve() { calls.push('resolve'); return state.identity; }, async checkUnchanged() { calls.push('check'); if (!state.unchanged) throw new Error('revoked'); } };
  const service = createWorkMemoryService({ authority, connectionStore: { async readConnection() { calls.push('store'); return joined; } },
    crypto: { open() { return { accessToken, refreshToken: 'refresh-secret', expiresAt }; } },
    auth: { async verifySession() { calls.push('auth'); return { userId: state.verifiedUser, sessionId: session, expiresAt }; } },
    reads: { async execute(operation, input) { calls.push(['rpc', operation, input]); return state.result; } }, clock: () => state.current });
  return { service, state, calls, joined };
}
test('fixed work-memory schemas have no authority, filesystem or arbitrary RPC input', () => {
  assert.equal(WORK_MEMORY_TOOLS.length, 5);
  for (const operation of ['status', 'list']) for (const input of [{ organizationId: org }, { userId: user }, { accessToken }, { path: '/personal/history' }]) {
    assert.throws(() => workMemoryInput(operation, input), /invalid_request/);
  }
  assert.throws(() => workMemoryInput('list', { limit: 11 }), /invalid_request/);
  assert.throws(() => workMemoryInput('upsert', { key: 'x', content: token, sourceLabel: 'a', expectedId: null, expectedVersion: 0, expectedAccessVersion: 1 }), /invalid_request/);
});
test('receipt reveals no credentials and only finalization calls the fixed JWT RPC', async () => {
  const { service, calls } = setup();
  const receipt = await service.prepareMemory(token, 'status', {}, options());
  assert.deepEqual(receipt, {}); assert.ok(Object.isFrozen(receipt)); assert.equal(calls.some(Array.isArray), false);
  calls.push('audit');
  assert.deepEqual(await service.finalizeMemory(token, receipt, options()), status);
  assert.deepEqual(calls.filter(v => typeof v === 'string'), ['resolve', 'store', 'auth', 'audit', 'check']);
  assert.deepEqual(calls.at(-1), ['rpc', 'status', { accessToken, binding, input: {} }]);
  await assert.rejects(service.finalizeMemory(token, receipt, options()), /context_changed/);
});
test('revocation, wrong JWT owner, tampered receipt and expiry deny without RPC', async () => {
  for (const change of ['revoke', 'actor', 'expiry', 'receipt']) {
    const { service, state, calls } = setup();
    if (change === 'actor') state.verifiedUser = org;
    if (change === 'actor') { await assert.rejects(service.prepareMemory(token, 'status', {}, options()), /unauthorized/); }
    else {
      const receipt = await service.prepareMemory(token, 'status', {}, options());
      if (change === 'revoke') state.unchanged = false;
      if (change === 'expiry') state.current = expiresAt + 1;
      await assert.rejects(service.finalizeMemory(token, change === 'receipt' ? {} : receipt, options()));
    }
    assert.equal(calls.some(Array.isArray), false);
  }
});
test('write overlay is required and cross-owner result cannot be returned as self', async () => {
  const { service, state, calls } = setup();
  state.identity.effective.action = [];
  await assert.rejects(service.prepareMemory(token, 'configure', { enabled: true, sharing: 'owner', retentionDays: 30, expectedAccessVersion: 0 }, options()), /forbidden/);
  assert.equal(calls.some(Array.isArray), false);
  assert.throws(() => workMemoryResult('status', { ...status, ownerUserId: org }, identity, {}), /backend_unavailable/);
  assert.throws(() => workMemoryResult('status', { ...status, credential: 'secret' }, identity, {}), /backend_unavailable/);
});
test('fixed HTTPS adapter binds user JWT and never retries a dispatched write', async () => {
  let calls = 0, dispatched = 0, rejected = 0;
  const config = { url: 'https://example.supabase.co', publishableKey: 'sb_publishable_fixture', dependencyScope: { track: fn => fn() } };
  const reads = createSupabaseWorkMemoryReads({ ...config, fetch: async (url, request) => {
    calls++; assert.match(url, /\/rest\/v1\/rpc\/hermes_work_memory_configure_v1$/);
    assert.equal(request.headers.authorization, `Bearer ${accessToken}`);
    assert.equal(JSON.parse(request.body).p.connectionId, connection); throw new Error('lost ACK');
  } });
  const input = { accessToken, binding, input: { enabled: true, sharing: 'owner', retentionDays: 30, expectedAccessVersion: 0 } };
  await assert.rejects(reads.execute('configure', input, { ...options(), onDispatch: () => dispatched++, onRejected: () => rejected++ }), /lost ACK/);
  assert.equal(calls, 1); assert.equal(dispatched, 1); assert.equal(rejected, 0);
  const denied = createSupabaseWorkMemoryReads({ ...config, fetch: async () => new Response(JSON.stringify({ code: '42501', message: 'denied', details: null, hint: null }), { status: 403, headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(denied.execute('configure', input, { ...options(), onDispatch: () => dispatched++, onRejected: () => rejected++ }), /forbidden/);
  assert.equal(rejected, 1);
  await assert.rejects(reads.execute('arbitrary_rpc', input, options()), /invalid_request/);
});
test('memory auth extension preserves existing action/read capabilities and requires fresh membership metadata', async () => {
  const base = { userId: user, isSuperadmin: false, epoch: 'base', membership: { membershipId: member, authorizationVersion: 1 },
    permissions: { read: ['rooms.view'], action: ['chat_zalo.send'] }, companyCeilings: { read: ['rooms.view'], action: ['chat_zalo.send'] }, scopesByPermission: {} };
  const caps = { organizationId: org, userId: user, membershipId: member, authorizationVersion: 1, isSuperadmin: false, policyVersion: 0, readAllowed: true, writeAllowed: false };
  const auth = createWorkMemoryAuthAdapter({ baseAuth: { verifySession: async () => ({}), readAuthorization: async () => base }, reads: { capabilities: async () => caps } });
  const result = await auth.readAuthorization({ userId: user, organizationId: org, accessToken, ...options() });
  assert.deepEqual(result.permissions, { read: ['rooms.view', 'assistant.memory.read'], action: ['chat_zalo.send'] });
  caps.authorizationVersion = 2;
  await assert.rejects(auth.readAuthorization({ userId: user, organizationId: org, accessToken, ...options() }), /context_changed/);
});
test('host retention uses fixed bounded cleanup and close drains pending work', async () => {
  let resolve, callback, calls = 0, cleared = false;
  const retention = createWorkMemoryRetention({ transport: { call(operation, input) {
    assert.equal(operation, 'pruneWorkMemories'); assert.deepEqual(input, { limit: 500 }); calls++;
    return new Promise(done => { resolve = done; });
  } }, timers: { setTimeout(fn) { callback = fn; return 1; }, clearTimeout() { cleared = true; } } });
  retention.start(); retention.start(); await Promise.resolve();
  assert.equal(calls, 1); assert.equal(retention.status().state, 'running');
  let finished = false; const closing = retention.close().then(() => { finished = true; }); await Promise.resolve();
  assert.equal(finished, false); resolve({ pruned: 1 }); await closing;
  assert.equal(cleared, true); assert.equal(callback, undefined); assert.equal(retention.status().state, 'closed');
});
