import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  query: vi.fn(), fetch: vi.fn(), org: '11111111-1111-4111-8111-111111111111',
}));
vi.mock('@tanstack/react-query', async importOriginal => ({
  ...await importOriginal<typeof import('@tanstack/react-query')>(), useQuery: h.query,
}));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: h.org }) }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'fixture-user' }) }));
vi.mock('@/integrations/supabase/client', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  return { supabase: createClient('https://fixture.invalid', 'fixture-key', {
    auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: h.fetch },
  }) };
});
import { useCustomers } from '../useCustomers';

const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
const stats = { total: 1205, individual: 1200, organization: 5, foreign: 2 };
const row = (n: number) => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, full_name: `Khách ${n}`, created_at: '2026-10-17T00:00:00+00:00',
  current_building_id: null, current_building_name: null, current_room_name: null });
let reply: unknown;

beforeEach(() => {
  vi.clearAllMocks();
  requests.length = 0;
  h.org = '11111111-1111-4111-8111-111111111111';
  reply = { total: 41, stats, rows: [row(1), row(2)] };
  h.fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push({ path: new URL(request.url).pathname, body: await request.json() as Record<string, unknown> });
    return Response.json(reply);
  });
});

function queryOptions(invoke: () => unknown) {
  invoke();
  return h.query.mock.calls.at(-1)![0] as {
    queryFn: () => Promise<unknown>; queryKey: unknown[]; enabled: boolean;
    placeholderData: (previous: unknown, query: { queryKey: unknown[] }) => unknown;
  };
}

describe('màn Khách hàng đọc qua customer_list_v1', () => {
  it('danh sách phân trang gửi đúng bộ lọc, từ khoá đã trim và trang; trả tổng của server', async () => {
    const filters = { search: '  NGUYỄN NHAT AN ', status: 'RENTING' as const, statFilter: 'INDIVIDUAL' as const };
    const result = await queryOptions(() => useCustomers(filters, { page: 2, pageSize: 20 })).queryFn();
    expect(requests).toEqual([{ path: '/rest/v1/rpc/customer_list_v1', body: {
      p_organization_id: h.org, p_status: 'RENTING', p_kind: 'INDIVIDUAL', p_search: 'NGUYỄN NHAT AN',
      p_limit: 20, p_offset: 20, p_include_location: true,
    } }]);
    expect(result).toEqual({ data: [row(1), row(2)], count: 41, stats });
  });

  it('thẻ đếm đi cùng MỘT lời gọi danh sách: thẻ loại chỉ lọc dòng, stats của server giữ nguyên', async () => {
    reply = { total: 2, stats, rows: [row(1), row(2)] };
    const filters = { search: 'duong', status: 'MOVED_OUT' as const, building_id: 'b-1', room_id: 'r-1', statFilter: 'FOREIGN' as const };
    const result = await queryOptions(() => useCustomers(filters, { page: 1, pageSize: 20 })).queryFn();
    expect(requests).toHaveLength(1);
    expect(requests[0].body).toEqual({
      p_organization_id: h.org, p_status: 'MOVED_OUT', p_kind: 'FOREIGN', p_search: 'duong', p_building_ids: ['b-1'], p_room_id: 'r-1',
      p_limit: 20, p_offset: 0, p_include_location: true,
    });
    // stats là của tập lọc KHÔNG theo thẻ loại (server bỏ qua p_kind khi đếm), không phải 2 dòng FOREIGN.
    expect(result).toMatchObject({ count: 2, stats });
  });

  it('lọc toà/phòng đi cùng lời gọi danh sách; thẻ "Tất cả" và từ khoá rỗng không gửi gì', async () => {
    await queryOptions(() => useCustomers({ search: '  ', statFilter: 'ALL', building_id: 'b-1' }, { page: 1, pageSize: 20 })).queryFn();
    expect(requests[0].body).toEqual({
      p_organization_id: h.org, p_building_ids: ['b-1'], p_limit: 20, p_offset: 0, p_include_location: true,
    });
  });

  it('picker hợp đồng: không phân trang, bỏ toà hiện tại, count = số dòng như trước', async () => {
    reply = { total: 2, stats: { ...stats, total: 2 }, rows: [row(1), row(2)] };
    const result = await queryOptions(() => useCustomers(undefined, undefined, { skipLocationEnrichment: true })).queryFn();
    expect(requests[0].body).toEqual({ p_organization_id: h.org, p_offset: 0, p_include_location: false });
    expect(result).toEqual({ data: [row(1), row(2)], count: 2, stats: { ...stats, total: 2 } });
  });

  it('lỗi quyền và câu trả lời sai hình dạng là lỗi, không phải danh sách rỗng hay số 0', async () => {
    h.fetch.mockImplementation(async () => Response.json({ message: 'permission denied', code: '42501' }, { status: 403 }));
    await expect(queryOptions(() => useCustomers({}, { page: 1, pageSize: 20 })).queryFn()).rejects.toMatchObject({ code: '42501' });
    for (const bad of [null, {}, { total: 1, stats, rows: [{ id: 'x' }] }, { total: 0, stats, rows: [row(1)] },
      { total: 3, stats, rows: [row(1), row(1)] }, { total: 2, stats: { ...stats, total: 1 }, rows: [] }]) {
      h.fetch.mockImplementation(async () => Response.json(bad));
      await expect(queryOptions(() => useCustomers({}, { page: 1, pageSize: 1 }, { skipLocationEnrichment: true })).queryFn(), JSON.stringify(bad)).rejects.toThrow();
    }
    const { current_building_id: _drop, ...withoutLocation } = row(1);
    h.fetch.mockImplementation(async () => Response.json({ total: 1, stats, rows: [withoutLocation] }));
    await expect(queryOptions(() => useCustomers({}, { page: 1, pageSize: 20 })).queryFn()).rejects.toThrow('không nhất quán');
  });

  it('không mang số liệu sang công ty khác và không chạy khi chưa chọn công ty', () => {
    const list = queryOptions(() => useCustomers({ search: 'an' }, { page: 1, pageSize: 20 }));
    expect(list.queryKey).toEqual(['customers', { search: 'an' }, { page: 1, pageSize: 20 }, h.org]);
    const previous = { data: [row(1)], count: 1, stats };
    expect(list.placeholderData(previous, { queryKey: list.queryKey })).toBe(previous);
    expect(list.placeholderData(previous, { queryKey: ['customers', {}, undefined, 'other-org'] })).toBeUndefined();
    h.org = '';
    expect(queryOptions(() => useCustomers({ search: 'an' })).enabled).toBe(false);
  });
});
