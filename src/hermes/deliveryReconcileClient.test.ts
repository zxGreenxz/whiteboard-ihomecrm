import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHermesReconcileClient, HermesReconcileError, type HermesReconcileSnapshot } from './deliveryReconcileClient';
vi.mock('@/integrations/supabase/client', () => ({ supabase: { auth: { getSession: vi.fn() } } }));
const USER = '11111111-1111-4111-8111-111111111111', ORG = '22222222-2222-4222-8222-222222222222';
const JOB = '33333333-3333-4333-8333-333333333333', REQUEST = '44444444-4444-4444-8444-444444444444', RECORD = '55555555-5555-4555-8555-555555555555';
const URL = 'https://abcdefghijklmnopqrst.supabase.co';
const snapshot = (): HermesReconcileSnapshot => ({ organizationId: ORG, userId: USER, canManage: true, recent: [],
  items: [{ kind: 'queue_job', id: JOB, origin: 'automation', scheduleId: null, conversationId: RECORD, conversationName: 'Nhóm sale',
    preview: 'Bản tin phòng', errorCode: 'UNKNOWN_EFFECT', createdAt: '2026-10-15T01:00:00.000Z', processedAt: '2026-10-15T01:01:00.000Z' }] });
const input = () => ({ requestId: REQUEST, kind: 'queue_job' as const, targetId: JOB, decision: 'not_sent' as const, note: 'Không thấy tin trong nhóm' });
const ack = () => ({ organizationId: ORG, userId: USER, reconciliation: { id: RECORD, kind: 'queue_job', targetId: JOB, decision: 'not_sent',
  note: 'Không thấy tin trong nhóm', via: 'crm_ui', createdAt: '2026-10-15T02:00:00.000Z' } });
const json = (value: unknown, status = 200) => Response.json(value, { status });
const denial = (code: string, status: number) => json({ code, message: 'PRIVATE', details: null, hint: null }, status);
function setup(timeoutMs = 30000) {
  const scope = { userId: USER, organizationId: ORG, generation: 0 };
  const fetch = vi.fn<typeof globalThis.fetch>(async () => json(snapshot()));
  const getSession = vi.fn(async () => ({ data: { session: { user: { id: USER }, access_token: 'fixture.browser.jwt' } }, error: null }));
  const client = createHermesReconcileClient({ userId: USER, organizationId: ORG, currentScope: () => scope, fetch, getSession, timeoutMs });
  return { client, scope, fetch, getSession };
}
beforeEach(() => { vi.stubEnv('VITE_SUPABASE_URL', URL); vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_fixture'); });
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Hermes delivery reconciliation client (human CRM JWT)', () => {
  it('reads with the caller bearer and records one attestation through the fixed RPCs', async () => {
    const s = setup();
    await expect(s.client.list()).resolves.toEqual(snapshot());
    s.fetch.mockResolvedValueOnce(json(ack()));
    await expect(s.client.resolve(input())).resolves.toEqual(ack().reconciliation);
    expect(s.fetch.mock.calls.map(([url]) => url)).toEqual([URL + '/rest/v1/rpc/hermes_delivery_reconcile_list_v1', URL + '/rest/v1/rpc/hermes_delivery_reconcile_resolve_v1']);
    expect(JSON.parse(s.fetch.mock.calls[0][1]!.body as string)).toEqual({ p_organization_id: ORG });
    expect(JSON.parse(s.fetch.mock.calls[1][1]!.body as string)).toEqual({ p: { organizationId: ORG, ...input() } });
    const headers = s.fetch.mock.calls[1][1]!.headers as Record<string, string>;
    expect([headers.authorization, headers.apikey, headers['x-organization-id']]).toEqual(['Bearer fixture.browser.jwt', 'sb_publishable_fixture', ORG]);
  });
  it('rejects invalid notes before any request and malformed or foreign responses after it', async () => {
    const s = setup();
    for (const note of ['', '   ', 'x'.repeat(501), 'bad\u0007note']) {
      await expect(s.client.resolve({ ...input(), note })).rejects.toMatchObject({ code: 'invalid_request', outcomeUnknown: false });
    }
    expect(s.fetch).not.toHaveBeenCalled();
    s.fetch.mockResolvedValueOnce(json({ ...snapshot(), userId: RECORD }));
    await expect(s.client.list()).rejects.toMatchObject({ code: 'invalid_response' });
    s.fetch.mockResolvedValueOnce(json({ ...snapshot(), items: [{ ...snapshot().items[0], kind: 'private_command' }] }));
    await expect(s.client.list()).rejects.toMatchObject({ code: 'invalid_response' });
    s.fetch.mockResolvedValueOnce(json({ ...ack(), reconciliation: { ...ack().reconciliation, decision: 'sent' } }));
    await expect(s.client.resolve(input())).rejects.toMatchObject({ code: 'reconcile_outcome_unknown', outcomeUnknown: true });
  });
  it('maps definite refusals as not applied and ambiguous write failures as unknown, never retrying', async () => {
    for (const [status, code, expected] of [[403, '42501', 'forbidden'], [409, 'PT409', 'conflict'], [400, '22023', 'invalid_request'], [404, 'PGRST202', 'backend_unavailable']] as const) {
      const s = setup(); s.fetch.mockResolvedValueOnce(denial(code, status));
      const error = await s.client.resolve(input()).catch(value => value);
      expect(error).toBeInstanceOf(HermesReconcileError);
      expect([error.code, error.outcomeUnknown]).toEqual([expected, false]);
      expect(s.fetch).toHaveBeenCalledTimes(1);
    }
    const s = setup(); s.fetch.mockResolvedValueOnce(json({ error: 'gateway' }, 502));
    await expect(s.client.resolve(input())).rejects.toMatchObject({ code: 'reconcile_outcome_unknown', outcomeUnknown: true });
    s.fetch.mockRejectedValueOnce(new TypeError('network'));
    await expect(s.client.resolve(input())).rejects.toMatchObject({ outcomeUnknown: true });
    s.fetch.mockRejectedValueOnce(new TypeError('network'));
    await expect(s.client.list()).rejects.toMatchObject({ code: 'backend_unavailable', outcomeUnknown: false });
    expect(s.fetch).toHaveBeenCalledTimes(3);
  });
  it('refuses a stale company/account scope and a foreign session', async () => {
    const s = setup(); s.scope.generation = 1;
    const client = createHermesReconcileClient({ userId: USER, organizationId: ORG, currentScope: () => ({ ...s.scope, generation: s.scope.generation++ }),
      fetch: s.fetch, getSession: s.getSession });
    await expect(client.list()).rejects.toMatchObject({ code: 'context_changed' });
    const other = setup(); other.getSession.mockResolvedValueOnce({ data: { session: { user: { id: RECORD }, access_token: 'fixture.browser.jwt' } }, error: null });
    await expect(other.client.list()).rejects.toMatchObject({ code: 'reauthentication_required' });
    expect(other.fetch).not.toHaveBeenCalled();
  });
});
