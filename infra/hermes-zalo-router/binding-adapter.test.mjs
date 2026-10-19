import test from 'node:test';
import assert from 'node:assert/strict';
import { createZaloBindingPorts } from './binding-adapter.mjs';
import { createZaloBindingService, ZaloBindingRpcRejection } from './binding-service.mjs';

const id = n => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const USER = id('1'), ORG = id('2'), NOW = 1800000000000;
function fixture() {
  const calls = [];
  const context = { userId: USER, isSuperadmin: false, activeOrganizationIds: [ORG], membership: {
    organizationId: ORG, status: 'ACTIVE', revokedAt: null, validFrom: null, validTo: null, membershipId: id('3'), authorizationVersion: 1 } };
  const session = { userId: USER, sessionId: id('4'), expiresAt: NOW + 100000 };
  const configuration = { url: 'https://fixture.supabase.co', publishableKey: 'sb_publishable_fixture', clock: () => NOW,
    auth: { verifySession: async () => structuredClone(session), readAuthorization: async () => structuredClone(context) },
    fetch: async (url, options) => { calls.push({ url, options }); return Response.json({ status: 'listed', userId: USER, organizationId: ORG, bindings: [], nextCursor: null }); } };
  const options = { accessToken: 'fixture.browser.jwt', organizationId: ORG, signal: new AbortController().signal };
  return { calls, context, session, configuration, options };
}
test('real service and ports verify Auth once and the fixed caller-JWT RPC', async () => {
  const f = fixture(); const service = createZaloBindingService(createZaloBindingPorts(f.configuration));
  assert.deepEqual((await service.invoke('list', { afterBindingId: null }, f.options)).bindings, []);
  assert.equal(f.calls.length, 1); const call = f.calls[0];
  assert.equal(call.url, 'https://fixture.supabase.co/rest/v1/rpc/hermes_zalo_binding_v1');
  assert.equal(call.options.headers.authorization, 'Bearer fixture.browser.jwt');
  assert.equal(call.options.redirect, 'error'); assert(call.options.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(call.options.body), { p: { operation: 'list', organizationId: ORG, afterBindingId: null } });
  await service.close();
});
test('expired or invalid Auth sessions deny before the caller-JWT SQL call', async () => {
  for (const mutate of [f => f.session.expiresAt = NOW, f => f.session.userId = 'invalid', f => f.session.sessionId = 'invalid']) {
    const f = fixture(); mutate(f);
    const service = createZaloBindingService(createZaloBindingPorts(f.configuration));
    await assert.rejects(service.invoke('list', { afterBindingId: null }, f.options), { code: 'reauthentication_required' });
    assert.equal(f.calls.length, 0);
  }
});
test('membership/cross-company authorization belongs to SQL; the adapter never resolves full CRM capabilities', async () => {
  const f = fixture(); let authCalls = 0;
  f.configuration.auth.verifySession = async () => { authCalls++; return structuredClone(f.session); };
  f.configuration.auth.readAuthorization = async () => { throw Error('full CRM capability read must not run'); };
  const service = createZaloBindingService(createZaloBindingPorts(f.configuration));
  await service.invoke('list', { afterBindingId: null }, f.options);
  assert.equal(authCalls, 1); assert.equal(f.calls.length, 1);
});
for (const [status, code, expected, known] of [[403,'42501','forbidden',true],[409,'PT409','context_changed',true],
  [409,'40001','backend_unavailable',false],[503,'42501','backend_unavailable',false],[400,'22023','invalid_request',true]]) {
  test(`HTTP ${status}/${code} is classified without exposing raw diagnostics`, async () => {
    const f = fixture(); f.configuration.fetch = async () => Response.json({ code, message: 'PRIVATE' }, { status });
    const ports = createZaloBindingPorts(f.configuration);
    await assert.rejects(ports.rpc({ accessToken: f.options.accessToken, functionName: 'hermes_zalo_binding_v1',
      args: { p: { operation: 'list', organizationId: ORG, afterBindingId: null } }, signal: f.options.signal }), error =>
      error.code === expected && (error instanceof ZaloBindingRpcRejection) === known && !String(error).includes('PRIVATE'));
  });
}
test('redirects, oversized/untyped/invalid JSON and arbitrary function dispatch are denied', async () => {
  for (const reply of [() => new Response('not json'), () => new Response('{', { headers: { 'content-type': 'application/json' } }),
    () => new Response('x'.repeat(65537), { headers: { 'content-type': 'application/json' } }),
    () => { const response = Response.json({}); Object.defineProperty(response, 'redirected', { value: true }); return response; }]) {
    const f = fixture(); f.configuration.fetch = async () => reply(); const ports = createZaloBindingPorts(f.configuration);
    const request = { accessToken: f.options.accessToken, functionName: 'hermes_zalo_binding_v1', args: { p: { operation: 'list' } }, signal: f.options.signal };
    await assert.rejects(ports.rpc(request), { code: 'backend_unavailable' });
    await assert.rejects(ports.rpc({ ...request, functionName: 'admin' }), { code: 'invalid_request' });
  }
});
test('unrelated database conflicts do not claim that a sender is already linked', async () => {
  for (const [operation, status, code, message, expected] of [
    ['confirm', 409, '23505', 'duplicate key value violates unique constraint "hermes_zalo_one_user_bot"', 'context_changed'],
    ['confirm', 409, '23505', 'PRIVATE', 'context_changed'],
    ['confirm', 409, 'PT409', 'duplicate key value violates unique constraint "hermes_zalo_one_sender"', 'context_changed'],
    ['list', 409, '23505', 'duplicate key value violates unique constraint "hermes_zalo_one_sender"', 'context_changed'],
    ['confirm', 503, '23505', 'duplicate key value violates unique constraint "hermes_zalo_one_sender"', 'backend_unavailable'],
  ]) {
    const f = fixture(); f.configuration.fetch = async () => Response.json({ code, message }, { status });
    const ports = createZaloBindingPorts(f.configuration);
    await assert.rejects(ports.rpc({ accessToken: f.options.accessToken, functionName: 'hermes_zalo_binding_v1',
      args: { p: { operation } }, signal: f.options.signal }), { code: expected });
  }
});
