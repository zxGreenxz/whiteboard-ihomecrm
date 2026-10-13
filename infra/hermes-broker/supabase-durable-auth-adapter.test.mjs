import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createSupabaseDurableAuthAdapter } from './supabase-durable-auth-adapter.mjs';
import { createDurableAuthority } from './durable-authority.mjs';
import { createDurableConnectionStore } from './durable-connection-store.mjs';
import { createSessionCrypto } from './session-crypto.mjs';
import { BrokerError } from './broker.mjs';

const id = digit => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const USER = id('1'), ORG = id('2'), MEMBER = id('3'), SESSION = id('4'), BUILDING = id('5'), OTHER = id('6');
const NOW = 1800000000000, EXP = NOW + 3600000;
const jwt = (claims = {}) => `header.${Buffer.from(JSON.stringify({ sub: USER, role: 'authenticated', session_id: SESSION, exp: EXP / 1000, ...claims })).toString('base64url')}.signature`;
const code = (expected, status) => error => error instanceof BrokerError && error.code === expected && error.status === status && error.cause === undefined && error.message === expected;
const gates = { user: '/auth/v1/user', context: '/rest/v1/rpc/get_authorization_context_v1',
  directory: '/rest/v1/rpc/get_my_organizations', scope: '/rest/v1/rpc/copilot_org_scope_buildings_v1' };
function fixture(options = {}) {
  const controller = new AbortController(), calls = [];
  const state = { context: { organizationId: ORG, membershipId: MEMBER, authorizationVersion: 1, isPlatformAdmin: false,
    isOffboarded: false, permissions: { 'rooms.view': true },
    scopeSets: [{ orgWide: true, buildingIds: [OTHER], cashbookIds: [OTHER] }], scopes: { 'rooms.view': 0 } },
  directory: { user_id: USER, organizations: [{ id: ORG }] }, scope: [BUILDING] };
  const auth = createSupabaseDurableAuthAdapter({ url: 'https://fixture.supabase.co', publishableKey: 'sb_publishable_fixture',
    clock: options.clock ?? (() => NOW), timeoutMs: options.timeoutMs ?? 10000, maxResponseBytes: options.maxResponseBytes ?? 131072,
    fetch: async (url, init) => {
      const path = new URL(url).pathname, args = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ path, args, init });
      const custom = await options.response?.({ path, args, init, state });
      if (custom) return custom;
      const data = path === gates.user ? { id: USER } : path === gates.context ? state.context
        : path === gates.directory ? state.directory : path === gates.scope ? state.scope : undefined;
      assert.notEqual(data, undefined, 'fixed endpoint required'); return Response.json(data);
    } });
  return { auth, calls, state, controller, verify: () => auth.verifySession({ accessToken: jwt(), signal: controller.signal }),
    read: () => auth.readAuthorization({ accessToken: jwt(), userId: USER, organizationId: ORG, signal: controller.signal }) };
}

test('extended adapter reuses actual Auth validation and fixed P1 readers, returning source metadata and per-permission BUILDING IDs', async () => {
  const f = fixture(); assert.deepEqual(await f.verify(), { userId: USER, sessionId: SESSION, expiresAt: EXP });
  const result = await f.read();
  assert.equal(result.membership.membershipId, MEMBER); assert.equal(result.membership.authorizationVersion, 1);
  assert.deepEqual(result.permissions, { read: ['assistant.context.read', 'rooms.view'], action: [] });
  assert.deepEqual(result.scopesByPermission, { 'assistant.context.read': { buildingIds: [], cashbookIds: [] },
    'rooms.view': { buildingIds: [BUILDING], cashbookIds: [] } });
  assert(!JSON.stringify(result).includes(OTHER), 'frontend scopeSets/orgWide must not be used');
  for (const call of f.calls) {
    assert.equal(call.init.headers.authorization, `Bearer ${jwt()}`); assert.equal(call.init.headers.apikey, 'sb_publishable_fixture');
    assert.equal(call.init.redirect, 'error'); assert(call.init.signal instanceof AbortSignal);
  }
  assert.deepEqual(f.calls.filter(call => call.path === gates.scope).map(call => call.args), [{ p_permission_key: 'rooms.view', p_organization_id: ORG }]);
  assert.deepEqual(Object.keys(f.auth).sort(), ['readAuthorization', 'verifySession']);
  assert(!JSON.stringify(result).includes(jwt()));
});

test('Auth rejects forged identity/role/session/expiry and HTTP rejection before trusting JWT claims', async () => {
  for (const claims of [{ sub: OTHER }, { role: 'service_role' }, { session_id: null }, { exp: NOW / 1000 }]) {
    const f = fixture(); await assert.rejects(f.auth.verifySession({ accessToken: jwt(claims), signal: f.controller.signal }), code('unauthorized', 401));
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].path, gates.user);
  }
  const rejected = fixture({ response: () => Response.json({ message: 'PRIVATE_DETAIL' }, { status: 401 }) });
  await assert.rejects(rejected.verify(), code('unauthorized', 401));
});

test('missing membership metadata is unavailable, while absent/foreign/offboarded membership is forbidden', async () => {
  for (const mutate of [value => { delete value.membershipId; }, value => { delete value.authorizationVersion; },
    value => { value.authorizationVersion = 0; }, value => { value.membershipId = 'invalid'; }]) {
    const f = fixture(); mutate(f.state.context); await assert.rejects(f.read(), code('backend_unavailable', 503));
  }
  for (const mutate of [value => { value.organizationId = null; }, value => { value.organizationId = OTHER; },
    value => { value.isOffboarded = true; }]) {
    const f = fixture(); mutate(f.state.context); await assert.rejects(f.read(), code('forbidden', 403));
  }
});

test('strict scope denial cannot be replaced by frontend permission/orgWide flags; empty scope grants no rooms bit', async () => {
  const denied = fixture({ response: ({ path }) => path === gates.scope ? Response.json({ code: '42501' }, { status: 403 }) : null });
  await assert.rejects(denied.read(), code('forbidden', 403));
  const empty = fixture(); empty.state.scope = [];
  const result = await empty.read(); assert.deepEqual(result.permissions, { read: ['assistant.context.read'], action: [] });
  assert.deepEqual(result.scopesByPermission, { 'assistant.context.read': { buildingIds: [], cashbookIds: [] } });
});

test('other-company membership probes never overwrite selected-company scopes and do not swallow backend outage', async () => {
  const f = fixture({ response: ({ path, args }) => path === gates.scope && args.p_organization_id === OTHER ? Response.json([OTHER]) : null });
  f.state.directory.organizations.push({ id: OTHER });
  const result = await f.read();
  assert.deepEqual(result.activeOrganizationIds, [ORG, OTHER]);
  assert.deepEqual(result.scopesByPermission['rooms.view'], { buildingIds: [BUILDING], cashbookIds: [] });
  const stale = fixture({ response: ({ path, args }) => path === gates.scope && args.p_organization_id === OTHER
    ? Response.json({ code: '42501' }, { status: 403 }) : null });
  stale.state.directory.organizations.push({ id: OTHER }); assert.deepEqual((await stale.read()).activeOrganizationIds, [ORG]);
  const outage = fixture({ response: ({ path, args }) => path === gates.scope && args.p_organization_id === OTHER
    ? Response.json({ message: 'PRIVATE_DB' }, { status: 503 }) : null });
  outage.state.directory.organizations.push({ id: OTHER }); await assert.rejects(outage.read(), code('backend_unavailable', 503));
});

test('interleaved requests keep actor/org metadata and scopes request-local; caller mutation cannot poison the next result', async () => {
  const a = { user: USER, org: ORG, member: MEMBER, building: BUILDING }, b = { user: OTHER, org: id('7'), member: id('8'), building: id('9') };
  const pending = [], controller = new AbortController();
  const auth = createSupabaseDurableAuthAdapter({ url: 'https://fixture.supabase.co', publishableKey: 'sb_publishable_fixture', clock: () => NOW,
    fetch: async (url, init) => {
      const path = new URL(url).pathname, args = JSON.parse(init.body);
      const actor = init.headers.authorization === `Bearer ${jwt()}` ? a : b;
      if (path === gates.context) {
        await new Promise(resolve => { pending.push(resolve); if (pending.length === 2) pending.splice(0).reverse().forEach(done => done()); });
        return Response.json({ organizationId: actor.org, membershipId: actor.member, authorizationVersion: actor === a ? 1 : 2,
          isPlatformAdmin: false, isOffboarded: false, permissions: { 'rooms.view': true } });
      }
      if (path === gates.directory) return Response.json({ user_id: actor.user, organizations: [{ id: actor.org }] });
      assert.equal(path, gates.scope); assert.equal(args.p_organization_id, actor.org); return Response.json([actor.building]);
    } });
  const read = actor => auth.readAuthorization({ accessToken: jwt({ sub: actor.user }), userId: actor.user, organizationId: actor.org, signal: controller.signal });
  const [left, right] = await Promise.all([read(a), read(b)]);
  assert.equal(left.membership.membershipId, a.member); assert.equal(right.membership.membershipId, b.member);
  assert.deepEqual(left.scopesByPermission['rooms.view'].buildingIds, [a.building]); assert.deepEqual(right.scopesByPermission['rooms.view'].buildingIds, [b.building]);
  left.scopesByPermission['rooms.view'].buildingIds.push(OTHER);
  assert.deepEqual(right.scopesByPermission['rooms.view'].buildingIds, [b.building]);
});

test('metadata and scope changes alter epoch; ordering and duplicate scope IDs do not broaden it', async () => {
  const f = fixture(); f.state.scope = [OTHER, BUILDING, BUILDING];
  const initial = await f.read(); f.state.scope = [BUILDING, OTHER]; assert.equal((await f.read()).epoch, initial.epoch);
  f.state.context.authorizationVersion++; const changed = await f.read(); assert.notEqual(changed.epoch, initial.epoch);
  f.state.scope = [BUILDING]; assert.notEqual((await f.read()).epoch, changed.epoch);
});

test('oversized or malformed JSON, redirects, wildcard IDs and contradictory error bodies are sanitized failures', async () => {
  for (const response of [() => new Response('x'.repeat(500), { headers: { 'content-type': 'application/json' } }),
    () => new Response('{', { headers: { 'content-type': 'application/json' } }),
    () => Response.json({ id: USER, error: 'PRIVATE' }),
    () => { const value = Response.json({ id: USER }); Object.defineProperty(value, 'redirected', { value: true }); return value; }]) {
    const f = fixture({ maxResponseBytes: 256, response }); await assert.rejects(f.verify(), code('backend_unavailable', 503));
  }
  const wildcard = fixture(); wildcard.state.scope = ['*']; await assert.rejects(wildcard.read(), code('backend_unavailable', 503));
  const invalid = fixture({ clock: () => NaN }); await assert.rejects(invalid.verify(), code('backend_unavailable', 503));
});

test('abort and deadline stop authorization even if injected fetch ignores cancellation, without retries or late follow-up probes', async () => {
  let settle;
  const f = fixture({ response: () => new Promise(resolve => { settle = resolve; }) });
  const pending = f.verify(); while (!settle) await new Promise(resolve => setImmediate(resolve));
  const failure = assert.rejects(pending, code('backend_unavailable', 503)); f.controller.abort(); await failure;
  settle(Response.json({ id: USER })); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.length, 1);
  assert(f.calls[0].init.signal.aborted);
  const timeout = fixture({ timeoutMs: 5, response: () => new Promise(() => {}) });
  await assert.rejects(timeout.verify(), code('backend_unavailable', 503)); assert.equal(timeout.calls.length, 1);
  const prior = fixture(); prior.controller.abort(); await assert.rejects(prior.read(), code('backend_unavailable', 503)); assert.equal(prior.calls.length, 0);
});

test('configuration disallows credentials/non-TLS/secret keys; method inputs cannot supply endpoint, key, or raw bearer in output', async () => {
  for (const changed of [{ url: 'http://fixture.supabase.co' }, { url: 'https://user:secret@fixture.supabase.co' },
    { url: 'https://fixture.supabase.co/path' }, { publishableKey: 'sb_secret_key' }, { timeoutMs: 30001 }, { maxResponseBytes: 131073 }]) {
    assert.throws(() => createSupabaseDurableAuthAdapter({ url: 'https://fixture.supabase.co', publishableKey: 'sb_publishable_fixture', ...changed }), /invalid_durable_auth_config/);
  }
  const f = fixture(); await assert.rejects(f.auth.verifySession({ accessToken: 'secret\nheader', signal: f.controller.signal }), code('unauthorized', 401));
  await assert.rejects(f.auth.readAuthorization({ accessToken: jwt(), userId: USER, organizationId: 'invalid', signal: f.controller.signal }), code('forbidden', 403));
  await assert.rejects(f.auth.verifySession({ accessToken: jwt() }), code('backend_unavailable', 503)); assert.equal(f.calls.length, 0);
});

test('new Auth adapter integrates with durable resolver, real crypto and connection adapter while SQL scope namespace remains separate', async t => {
  const f = fixture(), crypto = createSessionCrypto({ activeKeyVersion: 'fixture', keys: new Map([['fixture', Buffer.alloc(32, 1)]]) });
  t.after(() => crypto.destroy());
  const opaque = `hc_${Buffer.alloc(32, 2).toString('base64url')}`, digest = createHash('sha256').update(opaque).digest('hex');
  const binding = { assistantId: id('7'), userId: USER, organizationId: ORG, sessionId: SESSION }, assistantScope = id('8');
  const envelope = crypto.seal({ accessToken: jwt(), refreshToken: 'PRIVATE_REFRESH', expiresAt: EXP }, binding);
  const store = createDurableConnectionStore({ clock: () => NOW, transport: { call: async () => ({ status: 'active',
    connection: { id: id('9'), assistantId: binding.assistantId, userId: USER, organizationId: ORG, state: 'active', epoch: 1,
      restrictions: { read: ['assistant.context.read'], action: [] }, scopeIds: [assistantScope], tokenDigest: digest, credentialRef: id('a'), expiresAt: NOW + 600000 },
    session: { credentialRef: id('a'), revision: 1, envelope, expiresAt: EXP, binding },
    membership: { membershipId: MEMBER, authorizationVersion: 1, isSuperadmin: false },
    policy: { version: 1, read: ['assistant.context.read'], action: [], scopeIds: [assistantScope] } }) } });
  const authority = createDurableAuthority({ connectionStore: store, crypto, auth: f.auth, clock: () => NOW });
  const resolved = await authority.resolve(opaque, { signal: f.controller.signal });
  assert.deepEqual(resolved.effective, { read: ['assistant.context.read'], action: [] });
  assert.deepEqual(resolved.assistantScopeIds, [assistantScope]);
  assert.deepEqual(resolved.scopesByPermission['rooms.view'], { buildingIds: [BUILDING], cashbookIds: [] });
  await authority.checkUnchanged(opaque, resolved, { signal: f.controller.signal });
  f.state.context.authorizationVersion++;
  await assert.rejects(authority.resolve(opaque, { signal: f.controller.signal }), code('context_changed', 409));
});
