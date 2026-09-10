import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createOrganizationFetch, getWorkingOrganization, hasPendingOrganizationRequests,
  organizationStorageKey, readWorkingOrganization, requireWorkingOrganization,
  setWorkingOrganization, syncWorkingOrganizationUser, WORKING_ORGANIZATION_HEADER,
} from '../workingOrganization';

const orgA = 'aaaa0000-0000-4000-8000-000000000001';
const orgB = 'bbbb0000-0000-4000-8000-000000000002';
const origin = 'https://fixture.supabase.co';
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  syncWorkingOrganizationUser(null);
});
afterEach(() => { syncWorkingOrganizationUser(null); vi.unstubAllGlobals(); });

describe('company request context', () => {
  it.each(['SecurityError', 'QuotaExceededError'])('keeps an explicit in-memory choice when storage raises %s', (name) => {
    const unavailable = () => { throw new DOMException('Storage unavailable', name); };
    vi.stubGlobal('localStorage', { getItem: unavailable, setItem: unavailable, removeItem: unavailable });
    expect(readWorkingOrganization('user-a')).toBeNull();
    setWorkingOrganization('user-a', orgA);
    expect(requireWorkingOrganization()).toBe(orgA);
    syncWorkingOrganizationUser('user-b');
    expect(getWorkingOrganization()).toBeNull();
  });

  it('surfaces unexpected persistence errors and clears previous identity context', () => {
    setWorkingOrganization('user-a', orgA);
    const broken = () => { throw new Error('unexpected storage failure'); };
    vi.stubGlobal('localStorage', { getItem: broken, setItem: broken, removeItem: broken });
    expect(() => syncWorkingOrganizationUser('user-b')).toThrow('unexpected storage failure');
    expect(getWorkingOrganization()).toBeNull();
    expect(() => setWorkingOrganization('user-b', orgB)).toThrow('unexpected storage failure');
  });

  it('does not inherit another account or the unowned legacy preference', () => {
    localStorage.setItem('ihomecrm.selectedOrganizationId', orgB);
    syncWorkingOrganizationUser('user-a');
    expect(getWorkingOrganization()).toBeNull();
    expect(() => requireWorkingOrganization()).toThrow('chọn công ty');
    setWorkingOrganization('user-a', orgA);
    syncWorkingOrganizationUser('user-b');
    expect(getWorkingOrganization()).toBeNull();
    setWorkingOrganization('user-b', orgB);
    syncWorkingOrganizationUser('user-a');
    expect(requireWorkingOrganization()).toBe(orgA);
    syncWorkingOrganizationUser(null);
    expect(getWorkingOrganization()).toBeNull();
    expect(readWorkingOrganization('user-b')).toBe(orgB);
    localStorage.setItem(organizationStorageKey('user-b'), 'invalid');
    expect(readWorkingOrganization('user-b')).toBeNull();
  });

  it('preserves request body/authentication and sends context only to the configured REST endpoint', async () => {
    setWorkingOrganization('user-a', orgA);
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => { calls.push({ input, init }); return new Response('{}'); };
    const fetchWithOrg = createOrganizationFetch(origin, fetcher);
    const body = JSON.stringify({ p_value: 10 });
    await fetchWithOrg(`${origin}/rest/v1/rpc/example`, { method: 'POST', body, headers: { Authorization: 'Bearer fixture', [WORKING_ORGANIZATION_HEADER]: orgB } });
    expect(new Headers(calls[0]?.init?.headers).get(WORKING_ORGANIZATION_HEADER)).toBe(orgA);
    expect(new Headers(calls[0]?.init?.headers).get('Authorization')).toBe('Bearer fixture');
    expect(calls[0]?.init?.body).toBe(body);
    for (const url of [`${origin}/auth/v1/token`, `${origin}/storage/v1/object`, 'https://other.example/rest/v1/x']) {
      await fetchWithOrg(url);
      expect(calls.at(-1)?.init).toBeUndefined();
    }
    syncWorkingOrganizationUser(null);
    await fetchWithOrg(new Request(`${origin}/rest/v1/table`, { headers: { [WORKING_ORGANIZATION_HEADER]: orgA } }));
    expect(new Headers(calls.at(-1)?.init?.headers).has(WORKING_ORGANIZATION_HEADER)).toBe(false);
  });

  it('captures the dispatched company and releases the switch guard even after network failure', async () => {
    let rejectRequest: (error: Error) => void = () => {};
    let sentHeaders: Headers | null = null;
    const fetcher: typeof fetch = (_input, init) => {
      sentHeaders = new Headers(init?.headers);
      return new Promise<Response>((_resolve, reject) => { rejectRequest = reject; });
    };
    setWorkingOrganization('user-a', orgA);
    const pending = createOrganizationFetch(origin, fetcher)(`${origin}/rest/v1/rpc/example`);
    expect(hasPendingOrganizationRequests()).toBe(true);
    setWorkingOrganization('user-a', orgB);
    expect((sentHeaders as Headers | null)?.get(WORKING_ORGANIZATION_HEADER)).toBe(orgA);
    rejectRequest(new Error('offline'));
    await expect(pending).rejects.toThrow('offline');
    expect(hasPendingOrganizationRequests()).toBe(false);
  });

  it('blocks company switching during storage writes without changing storage request headers or data', async () => {
    let complete: (response: Response) => void = () => {};
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>(resolve => { complete = resolve; }));
    const body = new FormData();
    body.set('metadata', JSON.stringify({ ihomecrm_organization_id: orgB }));
    const init = { method: 'POST', body, headers: { Authorization: 'Bearer fixture' } };
    const pending = createOrganizationFetch(origin, fetcher)(`${origin}/storage/v1/object/payment-receipts/file`, init);
    expect(hasPendingOrganizationRequests()).toBe(true);
    expect(fetcher).toHaveBeenCalledWith(`${origin}/storage/v1/object/payment-receipts/file`, init);
    complete(new Response('{}'));
    await pending;
    expect(hasPendingOrganizationRequests()).toBe(false);
  });
});
