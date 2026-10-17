import { beforeEach, describe, expect, it, vi } from 'vitest';
import { customerSearchFilter } from '@/lib/customerSearch';

const h = vi.hoisted(() => ({
  query: vi.fn(), fetch: vi.fn(), location: vi.fn(), org: '11111111-1111-4111-8111-111111111111',
}));
vi.mock('@tanstack/react-query', async importOriginal => ({
  ...await importOriginal<typeof import('@tanstack/react-query')>(), useQuery: h.query,
}));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: h.org }) }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'fixture-user' }) }));
vi.mock('@/lib/customerResidenceHistory', () => ({ readResidenceLocationIds: h.location }));
vi.mock('@/integrations/supabase/client', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  return { supabase: createClient('https://fixture.invalid', 'fixture-key', {
    auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: h.fetch },
  }) };
});
import { useCustomers, useCustomerStats } from '../useCustomers';

const requests: Request[] = [];
const counts = { total: 1205, individual: 1200, organization: 5, foreign: 2 };

beforeEach(() => {
  vi.clearAllMocks();
  requests.length = 0;
  h.org = '11111111-1111-4111-8111-111111111111';
  h.location.mockResolvedValue(['customer-a']);
  h.fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    const url = new URL(request.url);
    if (url.pathname.endsWith('/rpc/get_customer_stats')) return Response.json(counts);
    const type = url.searchParams.get('customer_type');
    const count = type === 'eq.INDIVIDUAL' ? counts.individual : type === 'eq.ORGANIZATION' ? counts.organization
      : url.searchParams.has('is_foreign') ? counts.foreign : counts.total;
    return new Response(request.method === 'HEAD' ? null : '[]', { headers: { 'Content-Range': `0-19/${count}` } });
  });
});

function queryOptions(invoke: () => unknown) {
  invoke();
  return h.query.mock.calls.at(-1)![0] as {
    queryFn: () => Promise<unknown>; queryKey: unknown[]; enabled: boolean;
    placeholderData: (previous: unknown, query: { queryKey: unknown[] }) => unknown;
  };
}

describe('customer search list and counts', () => {
  it('sends the same server search for paginated list and every stat count', async () => {
    const filters = { search: 'NGUYEN NHAT AN', status: 'RENTING' as const };
    await queryOptions(() => useCustomers(filters, { page: 2, pageSize: 20 }, { skipLocationEnrichment: true })).queryFn();
    const stats = await queryOptions(() => useCustomerStats(filters)).queryFn();
    expect(stats).toEqual(counts);
    expect(requests).toHaveLength(5);
    for (const request of requests) {
      const params = new URL(request.url).searchParams;
      expect(params.get('or')).toBe(`(${customerSearchFilter(filters.search)})`);
      expect(params.get('organization_id')).toBe(`eq.${h.org}`);
      expect(params.get('status_v2')).toBe('eq.RENTING');
      expect(params.get('deleted_at')).toBe('is.null');
      expect(request.headers.get('prefer')).toContain('count=exact');
    }
    expect(new URL(requests[0].url).searchParams.get('offset')).toBe('20');
    expect(new URL(requests[0].url).searchParams.get('limit')).toBe('20');
    expect(requests.slice(1).every(request => request.method === 'HEAD')).toBe(true);
  });

  it('keeps residence filters in sync and ignores the selected stat card when counting', async () => {
    const filters = { search: 'duong', status: 'MOVED_OUT' as const, building_id: 'building-a', room_id: 'room-a', statFilter: 'FOREIGN' as const };
    await queryOptions(() => useCustomers(filters)).queryFn();
    await queryOptions(() => useCustomerStats(filters)).queryFn();
    expect(h.location.mock.calls).toEqual(Array(2).fill([h.org, 'building-a', 'room-a', true]));
    expect(requests.every(request => new URL(request.url).searchParams.get('id') === 'in.(customer-a)')).toBe(true);
    expect(new URL(requests[1].url).searchParams.has('is_foreign')).toBe(false);
  });

  it('returns zero counts when the selected location has no matching customers', async () => {
    h.location.mockResolvedValue([]);
    const result = await queryOptions(() => useCustomerStats({ search: 'an', building_id: 'empty', status: 'RENTING' })).queryFn();
    expect(result).toEqual({ total: 0, individual: 0, organization: 0, foreign: 0 });
    expect(h.location).toHaveBeenCalledWith(h.org, 'empty', undefined, false);
    expect(requests).toHaveLength(0);
  });

  it('retains the single RPC for empty search', async () => {
    expect(await queryOptions(() => useCustomerStats({ search: '  ' })).queryFn()).toEqual(counts);
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0].url).pathname).toBe('/rest/v1/rpc/get_customer_stats');
  });

  it('propagates failed and missing counts instead of reporting zero', async () => {
    h.fetch.mockImplementation(async () => Response.json({ message: 'permission denied', code: '42501' }, { status: 403 }));
    await expect(queryOptions(() => useCustomerStats({ search: 'an' })).queryFn()).rejects.toMatchObject({ code: '42501' });
    h.fetch.mockImplementation(async () => new Response(null));
    await expect(queryOptions(() => useCustomerStats({ search: 'an' })).queryFn()).rejects.toThrow('Chưa xác nhận');
  });

  it('does not carry stats across organizations or run without an organization', () => {
    const options = queryOptions(() => useCustomerStats({ search: 'an' }));
    expect(options.queryKey.at(-1)).toBe(h.org);
    expect(options.placeholderData(counts, { queryKey: options.queryKey })).toBe(counts);
    expect(options.placeholderData(counts, { queryKey: ['customer-stats', {}, 'other-org'] })).toBeUndefined();
    h.org = '';
    expect(queryOptions(() => useCustomerStats({ search: 'an' })).enabled).toBe(false);
  });
});
