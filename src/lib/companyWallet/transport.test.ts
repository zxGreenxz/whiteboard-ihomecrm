import { afterEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ session: vi.fn(), actor: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { auth: { getSession: state.session } } }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: state.actor }));
import { createCompanyWalletTransport } from './transport';
import { createCompanyWalletService } from './service';
const owner = '00000000-0000-4000-8000-000000000001', org = '00000000-0000-4000-8000-000000000002';
const other = '00000000-0000-4000-8000-000000000003';
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });
function setup() {
 vi.stubEnv('VITE_SUPABASE_URL', 'https://example.test'); vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'public-key');
 state.session.mockResolvedValue({ data: { session: { user: { id: owner }, access_token: 'pinned-jwt' } }, error: null });
 state.actor.mockResolvedValue({ id: owner });
 const scope = { ownerId: owner, organizationId: org };
 const transport = createCompanyWalletTransport(owner, org, () => scope);
 return { scope, transport };
}
describe('company wallet pinned identity transport', () => {
 it('pins the verified JWT in the one POST rather than the clients later session', async () => {
  const { transport } = setup(), fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })); vi.stubGlobal('fetch', fetch);
  await expect(transport.rpc('company_wallet_snapshot', { p_organization_id: org })).resolves.toEqual({ data: { ok: true }, error: null });
  expect(fetch).toHaveBeenCalledWith('https://example.test/rest/v1/rpc/company_wallet_snapshot', expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer pinned-jwt', apikey: 'public-key' }), body: JSON.stringify({ p_organization_id: org }) }));
 });
 it('blocks a company switch before sending and drops late responses after sending', async () => {
  const { scope, transport } = setup(), fetch = vi.fn(async () => { scope.organizationId = other; return new Response('{}'); }); vi.stubGlobal('fetch', fetch);
  scope.organizationId = other;
  await expect(transport.rpc('company_wallet_snapshot', { p_organization_id: org })).rejects.toMatchObject({ kind: 'permission', outcomeUnknown: false }); expect(fetch).not.toHaveBeenCalled();
  scope.organizationId = org;
  await expect(transport.rpc('company_wallet_mutate', { p_organization_id: org, p_request_key: other, p_payload: {} })).rejects.toMatchObject({ kind: 'permission', outcomeUnknown: true }); expect(fetch).toHaveBeenCalledTimes(1);
 });
 it('prevents stale actor sends and ignores a response after sign-in identity changed', async () => {
  const { transport } = setup(), fetch = vi.fn(async () => new Response('{}')); vi.stubGlobal('fetch', fetch);
  state.session.mockResolvedValueOnce({ data: { session: { user: { id: other }, access_token: 'wrong' } }, error: null });
  await expect(transport.rpc('company_wallet_snapshot', { p_organization_id: org })).rejects.toMatchObject({ kind: 'permission' }); expect(fetch).not.toHaveBeenCalled();
  state.actor.mockResolvedValueOnce({ id: other });
  await expect(transport.rpc('company_wallet_snapshot', { p_organization_id: org })).rejects.toMatchObject({ kind: 'permission' });
 });
 it('does not convert HTTP failures to an empty snapshot and retains raw response status', async () => {
  const { transport } = setup(); vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'XX000', message: 'Server error' }), { status: 503 })));
  await expect(transport.rpc('company_wallet_snapshot', { p_organization_id: org })).resolves.toMatchObject({ error: { code: 'XX000', status: 503 } });
  await expect(createCompanyWalletService(transport, owner, org).snapshot()).rejects.toMatchObject({ kind: 'internal' });
 });
});
