import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHermesWorkAssistantClient } from './workAssistantClient';
vi.mock('@/integrations/supabase/client', () => ({ supabase: { auth: { getSession: vi.fn() } } }));
const USER = '11111111-1111-4111-8111-111111111111', ORG = '22222222-2222-4222-8222-222222222222', OTHER = '55555555-5555-4555-8555-555555555555';
const ITEM = '66666666-6666-4666-8666-666666666666', URL = 'https://abcdefghijklmnopqrst.supabase.co';
const NOW = '2026-10-15T10:00:00+00:00';
const settings = (accessVersion = 3) => ({ enabled: true, sharing: 'owner' as const, retentionDays: 30, accessVersion });
const memoryPage = () => ({ organizationId: ORG, ownerUserId: USER, settings: settings(), personalMemory: 'outside_crm', remoteCopies: 'not_revocable',
  items: [{ id: ITEM, key: 'khach_vip', content: 'Khách thích phòng tầng cao', version: 2, assistantId: 'hermes-1', connectionId: 'conn-1',
    source: { channel: 'external_mcp', label: 'Hermes của tôi' }, createdAt: NOW, updatedAt: NOW, expiresAt: '2026-11-15T10:00:00+00:00' }],
  offset: 0, nextOffset: null, total: 1 });
const followsPage = () => ({ organizationId: ORG, userId: USER, role: 'assigned_by_me', state: 'active', items: [], offset: 0, nextOffset: null });
const session = () => ({ data: { session: { user: { id: USER }, access_token: 'fixture.browser.jwt' } }, error: null });
const json = (value: unknown, status = 200) => Response.json(value, { status });
const denial = (code: string, status: number) => json({ code, message: 'PRIVATE', details: null, hint: null }, status);
function setup(timeoutMs = 30000) {
  const scope = { userId: USER, organizationId: ORG, generation: 0 };
  const fetch = vi.fn<typeof globalThis.fetch>(async () => json(memoryPage()));
  const getSession = vi.fn(async () => session());
  const client = createHermesWorkAssistantClient({ userId: USER, organizationId: ORG, currentScope: () => scope, fetch, getSession, timeoutMs });
  return { client, scope, fetch, getSession };
}
const body = (fetch: ReturnType<typeof setup>['fetch'], index = 0) => JSON.parse(fetch.mock.calls[index][1]!.body as string) as unknown;
beforeEach(() => { vi.stubEnv('VITE_SUPABASE_URL', URL); vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_fixture'); });
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('human Hermes work assistant client', () => {
  it('reads work memory with the browser JWT, explicit organization and a validated page', async () => {
    const s = setup();
    await expect(s.client.memory(0)).resolves.toEqual(memoryPage());
    expect(s.fetch.mock.calls[0][0]).toBe(URL + '/rest/v1/rpc/hermes_my_work_memory_v1');
    expect(s.fetch.mock.calls[0][1]).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error', headers: {
      authorization: 'Bearer fixture.browser.jwt', apikey: 'sb_publishable_fixture', 'accept-profile': 'public', 'content-profile': 'public', 'x-organization-id': ORG } });
    expect(body(s.fetch)).toEqual({ p_org: ORG, p_offset: 0 });
  });
  it('sends configure, edit, forget and stop with exact contract bodies and checks the acknowledgement', async () => {
    const s = setup();
    const configure = { enabled: false, sharing: 'managers' as const, retentionDays: 90, expectedAccessVersion: 3 };
    s.fetch.mockResolvedValueOnce(json({ organizationId: ORG, ownerUserId: USER, settings: { enabled: false, sharing: 'managers', retentionDays: 90, accessVersion: 4 },
      personalMemory: 'outside_crm', remoteCopies: 'not_revocable' }));
    await expect(s.client.configureMemory(configure)).resolves.toMatchObject({ settings: { accessVersion: 4 } });
    expect(body(s.fetch, 0)).toEqual({ p_org: ORG, p_input: configure });
    s.fetch.mockResolvedValueOnce(json({ organizationId: ORG, ownerUserId: USER, id: ITEM, key: 'khach_vip', version: 3, expiresAt: NOW }));
    await expect(s.client.editMemory({ id: ITEM, expectedVersion: 2, content: 'Nội dung mới' })).resolves.toMatchObject({ version: 3 });
    expect(body(s.fetch, 1)).toEqual({ p_org: ORG, p_input: { id: ITEM, expectedVersion: 2, content: 'Nội dung mới' } });
    s.fetch.mockResolvedValueOnce(json({ organizationId: ORG, ownerUserId: USER, id: ITEM, forgotten: true, auditRetained: true, remoteCopies: 'not_revocable' }));
    await expect(s.client.forgetMemory({ id: ITEM, expectedVersion: 3 })).resolves.toMatchObject({ forgotten: true });
    s.fetch.mockResolvedValueOnce(json({ organizationId: ORG, userId: USER, id: ITEM, version: 2, state: 'cancelled', closeReason: 'stopped' }));
    await expect(s.client.stopFollow({ followId: ITEM, expectedVersion: 1 })).resolves.toMatchObject({ state: 'cancelled' });
    expect(body(s.fetch, 3)).toEqual({ p_org: ORG, p_input: { followId: ITEM, expectedVersion: 1 } });
    s.fetch.mockResolvedValueOnce(json(followsPage()));
    await expect(s.client.follows({ role: 'assigned_by_me', state: 'active', offset: 0 })).resolves.toEqual(followsPage());
    expect(body(s.fetch, 4)).toEqual({ p_org: ORG, p_input: { role: 'assigned_by_me', state: 'active', offset: 0 } });
  });
  it('maps PostgREST failures to distinct codes without unknown outcome when the server refused definitively', async () => {
    const cases: Array<[string, number, string]> = [['42501', 403, 'forbidden'], ['PT409', 409, 'context_changed'], ['22023', 400, 'invalid_request'],
      ['PGRST202', 404, 'not_supported'], ['PGRST301', 401, 'reauthentication_required']];
    for (const [code, status, expected] of cases) {
      const s = setup(); s.fetch.mockResolvedValueOnce(denial(code, status));
      await expect(s.client.editMemory({ id: ITEM, expectedVersion: 2, content: 'x' })).rejects.toMatchObject({ code: expected, outcomeUnknown: false });
    }
    const s = setup(); s.fetch.mockResolvedValueOnce(denial('XX000', 500));
    await expect(s.client.memory(0)).rejects.toMatchObject({ code: 'backend_unavailable', outcomeUnknown: false });
    s.fetch.mockResolvedValueOnce(denial('XX000', 500));
    await expect(s.client.forgetMemory({ id: ITEM, expectedVersion: 2 })).rejects.toMatchObject({ code: 'backend_unavailable', outcomeUnknown: true });
  });
  it('rejects a response for another company or user and an acknowledgement that does not match the request', async () => {
    const s = setup();
    s.fetch.mockResolvedValueOnce(json({ ...memoryPage(), organizationId: OTHER }));
    await expect(s.client.memory(0)).rejects.toMatchObject({ code: 'invalid_response' });
    s.fetch.mockResolvedValueOnce(json({ ...memoryPage(), ownerUserId: OTHER }));
    await expect(s.client.memory(0)).rejects.toMatchObject({ code: 'invalid_response' });
    s.fetch.mockResolvedValueOnce(json({ ...memoryPage(), extra: true }));
    await expect(s.client.memory(0)).rejects.toMatchObject({ code: 'invalid_response' });
    s.fetch.mockResolvedValueOnce(json({ organizationId: ORG, ownerUserId: USER, id: ITEM, key: 'khach_vip', version: 9, expiresAt: NOW }));
    await expect(s.client.editMemory({ id: ITEM, expectedVersion: 2, content: 'x' })).rejects.toMatchObject({ code: 'invalid_response', outcomeUnknown: true });
    s.fetch.mockResolvedValueOnce(json({ ...followsPage(), role: 'assigned_to_me' }));
    await expect(s.client.follows({ role: 'assigned_by_me', state: 'active', offset: 0 })).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('refuses invalid input before any network call', async () => {
    const s = setup();
    await expect(s.client.memory(201)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(s.client.editMemory({ id: ITEM, expectedVersion: 2, content: 'dòng 1\ndòng 2' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(s.client.editMemory({ id: ITEM, expectedVersion: 2, content: 'x'.repeat(1001) })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(s.client.configureMemory({ enabled: true, sharing: 'owner', retentionDays: 366, expectedAccessVersion: 0 })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(s.client.configureMemory({ enabled: true, sharing: 'everyone', retentionDays: 30, expectedAccessVersion: 0 } as never)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(s.fetch).not.toHaveBeenCalled();
  });
  it('reports an unknown outcome when a write is aborted after it was sent, and never retries it', async () => {
    const s = setup(); const controller = new AbortController();
    s.fetch.mockImplementationOnce((_url, init) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const pending = s.client.forgetMemory({ id: ITEM, expectedVersion: 2 }, { signal: controller.signal });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'cancelled', outcomeUnknown: true });
    await vi.waitFor(() => expect(s.fetch).toHaveBeenCalledTimes(1));
    controller.abort(); await assertion;
    expect(s.fetch).toHaveBeenCalledTimes(1);
  });
  it('times out a sent write as unknown but a read as a plain timeout', async () => {
    const hang = (_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
    const w = setup(20); w.fetch.mockImplementationOnce(hang);
    await expect(w.client.stopFollow({ followId: ITEM, expectedVersion: 1 })).rejects.toMatchObject({ code: 'timeout', outcomeUnknown: true });
    const r = setup(20); r.fetch.mockImplementationOnce(hang);
    await expect(r.client.memory(0)).rejects.toMatchObject({ code: 'timeout', outcomeUnknown: false });
  });
  it('drops a late response after the account or company generation changed', async () => {
    const s = setup(); let release: (value: Response) => void = () => {};
    s.fetch.mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; }));
    const pending = s.client.memory(0); const assertion = expect(pending).rejects.toMatchObject({ code: 'context_changed' });
    await vi.waitFor(() => expect(s.fetch).toHaveBeenCalledTimes(1));
    s.scope.generation++; release(json(memoryPage())); await assertion;
  });
  it('requires a session of the same user', async () => {
    const s = setup(); s.getSession.mockResolvedValueOnce({ data: { session: { user: { id: OTHER }, access_token: 'fixture.browser.jwt' } }, error: null });
    await expect(s.client.memory(0)).rejects.toMatchObject({ code: 'reauthentication_required' });
    expect(s.fetch).not.toHaveBeenCalled();
  });
});
