import assert from 'node:assert/strict';
import test from 'node:test';
import { createSupabaseAuthAdapter } from './supabase-adapter.mjs';

const USER = '10000000-0000-4000-8000-000000000001';
const ORG = '20000000-0000-4000-8000-000000000001';
const OTHER = '20000000-0000-4000-8000-000000000002';
const MEMBER = '30000000-0000-4000-8000-000000000001';
const BUILDING = '40000000-0000-4000-8000-000000000001';
const SESSION = '50000000-0000-4000-8000-000000000001';
const jwt = (claims = {}) => `header.${Buffer.from(JSON.stringify({ sub: USER, role: 'authenticated', session_id: SESSION, exp: 2000, ...claims })).toString('base64url')}.signature`;

function fixture({ response, directory = [ORG], scope = [BUILDING], superadmin = false } = {}) {
  const calls = [];
  const auth = createSupabaseAuthAdapter({ url: 'https://test.supabase.co', publishableKey: 'sb_publishable_fixture',
    clock: () => 1_000_000, fetch: async (url, init) => {
      const path = new URL(url).pathname, args = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ path, init, args });
      const custom = await response?.({ path, init, args });
      if (custom) return custom;
      const data = path === '/auth/v1/user' ? { id: USER }
        : path.endsWith('get_authorization_context_v1') ? {
          organizationId: ORG, membershipId: MEMBER, authorizationVersion: 1, isPlatformAdmin: superadmin,
          isOffboarded: false, permissions: { 'rooms.view': true },
        } : path.endsWith('get_my_organizations') ? { user_id: USER, organizations: directory.map((id) => ({ id })) }
          : path.endsWith('hermes_scope_buildings_v1') ? scope : undefined;
      assert.notEqual(data, undefined, 'unexpected endpoint');
      return Response.json(data);
    } });
  return { auth, calls, read: () => auth.readAuthorization({ accessToken: jwt(), userId: USER, organizationId: ORG }) };
}

test('adapter uses real-user bearer and only fixed read endpoints; verifies Auth before trusting claims', async () => {
  const f = fixture(); const accessToken = jwt();
  assert.equal((await f.auth.verifySession({ accessToken })).userId, USER);
  const authorization = await f.read();
  assert.deepEqual(authorization.permissions, { read: ['assistant.context.read', 'rooms.view'], action: [] });
  assert.deepEqual(authorization.activeOrganizationIds, [ORG]);
  for (const call of f.calls) {
    assert.equal(call.init.headers.authorization, `Bearer ${accessToken}`);
    assert.equal(call.init.headers.apikey, 'sb_publishable_fixture');
    assert.equal(call.init.redirect, 'error');
    if (call.path.startsWith('/rest/')) {
      assert.equal(call.init.headers['content-profile'], 'public');
      assert.equal(call.init.headers['accept-profile'], 'public');
    }
  }
  assert.deepEqual(f.calls.find((call) => call.path.endsWith('hermes_scope_buildings_v1')).args,
    { p_permission_key: 'rooms.view', p_organization_id: ORG });
});

test('forged user, role, expired session and Auth rejection are not accepted', async () => {
  for (const claims of [{ sub: OTHER }, { role: 'service_role' }, { exp: 999 }, { session_id: null }]) {
    await assert.rejects(fixture().auth.verifySession({ accessToken: jwt(claims) }), { code: 'unauthorized' });
  }
  const f = fixture({ response: ({ path }) => path === '/auth/v1/user' ? Response.json({ message: 'private' }, { status: 401 }) : null });
  await assert.rejects(f.auth.verifySession({ accessToken: jwt() }), { code: 'unauthorized' });
});

test('current strict scope failure denies even when legacy authorization context says membership active', async () => {
  const f = fixture({ response: ({ path }) => path.endsWith('hermes_scope_buildings_v1')
    ? Response.json({ code: '42501', message: 'revoked private member' }, { status: 403 }) : null });
  await assert.rejects(f.read(), { code: 'forbidden' });
});

test('empty authorized resource scope is valid self context and removes business read bit', async () => {
  const current = await fixture({ scope: [] }).read();
  assert.deepEqual(current.permissions.read, ['assistant.context.read']);
});

test('stale directory candidates are probed; active ambiguity remains visible for broker rejection', async () => {
  const stale = fixture({ directory: [ORG, OTHER], response: ({ path, args }) =>
    path.endsWith('hermes_scope_buildings_v1') && args.p_organization_id === OTHER
      ? Response.json({ code: '42501' }, { status: 403 }) : null });
  assert.deepEqual((await stale.read()).activeOrganizationIds, [ORG]);
  assert.deepEqual((await fixture({ directory: [ORG, OTHER] }).read()).activeOrganizationIds, [ORG, OTHER]);
});

test('server actor mismatch, offboarding and foreign context fail closed', async () => {
  for (const response of [
    ({ path }) => path.endsWith('get_my_organizations') ? Response.json({ user_id: OTHER, organizations: [] }) : null,
    ({ path }) => path.endsWith('get_authorization_context_v1') ? Response.json({ organizationId: OTHER }) : null,
  ]) await assert.rejects(fixture({ response }).read(), { code: 'forbidden' });
});

test('secret key, credentials in URL, non-TLS origin and legacy service role key are rejected', () => {
  for (const config of [
    { url: 'http://test.supabase.co' }, { url: 'https://user:password@test.supabase.co' },
    { publishableKey: 'sb_secret_private' }, { publishableKey: jwt({ role: 'service_role' }) },
  ]) assert.throws(() => createSupabaseAuthAdapter({ url: 'https://test.supabase.co', publishableKey: 'sb_publishable_fixture', ...config }));
});
