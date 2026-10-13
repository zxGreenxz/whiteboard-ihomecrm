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
test('real service and ports use live identity twice and the fixed caller-JWT RPC', async () => {
  const f = fixture(); const service = createZaloBindingService(createZaloBindingPorts(f.configuration));
  assert.deepEqual((await service.invoke('list', { afterBindingId: null }, f.options)).bindings, []);
  assert.equal(f.calls.length, 1); const call = f.calls[0];
  assert.equal(call.url, 'https://fixture.supabase.co/rest/v1/rpc/hermes_zalo_binding_v1');
  assert.equal(call.options.headers.authorization, 'Bearer fixture.browser.jwt');
  assert.equal(call.options.redirect, 'error'); assert(call.options.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(call.options.body), { p: { operation: 'list', organizationId: ORG, afterBindingId: null } });
  await service.close();
});
for (const [name, mutate] of [
  ['another actor', f => f.context.userId = id('9')],
  ['another selected company', f => f.context.membership.organizationId = id('9')],
  ['revoked membership', f => f.context.membership.revokedAt = NOW - 1],
  ['expired membership', f => f.context.membership.validTo = NOW],
  ['future membership', f => f.context.membership.validFrom = NOW + 1],
  ['ordinary multi-company user', f => f.context.activeOrganizationIds.push(id('9'))],
  ['superadmin without membership', f => { f.context.isSuperadmin = true; f.context.activeOrganizationIds = [id('9')]; }],
  ['expired session', f => f.session.expiresAt = NOW],
]) test(`live Auth denies ${name} before SQL`, async () => {
  const f = fixture(); mutate(f);
  const service = createZaloBindingService(createZaloBindingPorts(f.configuration));
  await assert.rejects(service.invoke('list', { afterBindingId: null }, f.options), error => ['forbidden','reauthentication_required'].includes(error.code));
  assert.equal(f.calls.length, 0);
});
test('superadmin still pins an explicitly selected current membership', async () => {
  const f = fixture(); f.context.isSuperadmin = true; f.context.activeOrganizationIds.push(id('9'));
  const ports = createZaloBindingPorts(f.configuration);
  assert.equal((await ports.verifyCaller(f.options)).organizationId, ORG);
});
test('post-RPC membership change suppresses a read response', async () => {
  const f = fixture(), original = f.configuration.fetch;
  f.configuration.fetch = async (...args) => { const result = await original(...args); f.context.membership.authorizationVersion++; return result; };
  const service = createZaloBindingService(createZaloBindingPorts(f.configuration));
  await assert.rejects(service.invoke('list', { afterBindingId: null }, f.options), { code: 'context_changed' });
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
