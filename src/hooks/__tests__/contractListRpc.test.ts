import { beforeEach, expect, it, vi } from 'vitest';

// Danh sách Hợp đồng đọc qua MỘT lời gọi public.contract_list_v1 (migration 20261017115636):
// bộ lọc của trang đi thẳng thành tham số, hàng trả về giữ nhãn SQL, phản hồi hỏng không thành rỗng.
const h = vi.hoisted(() => ({ calls: [] as { fn: string; args: Record<string, unknown> }[], data: null as unknown, queue: [] as unknown[], error: null as unknown, from: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({ useQuery: (o: unknown) => o, useMutation: (o: unknown) => o, useQueryClient: () => ({ invalidateQueries: vi.fn() }), keepPreviousData: Symbol('keep') }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor' }) }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: async (fn: string, args: Record<string, unknown>) => { h.calls.push({ fn, args }); return { data: h.queue.length ? h.queue.shift() : h.data, error: h.error }; },
    from: h.from,
  },
}));
import { contractDayRefetchMs, contractsPagedQuery, contractStatsQuery, fetchContractsForExport, msToNextVnMidnight, useContractDashboardCounts, useContractStats, useContractsPaged } from '../useContracts';
import { getContractDisplayStatus } from '@/types/contract';

const row = (id: string, display_status = 'EXPIRING') => ({
  id, status: 'ACTIVE', end_date: '2030-01-01', expected_move_out_date: null, display_status, display_label: 'Sắp hết hạn',
  room: { id: 'r', name: '101', building_id: 'b', building: { id: 'b', name: 'Toà X' } },
  contract_customers: [{ id: 'cc', contract_id: id, customer_id: 'cu', is_representative: true, customer: { id: 'cu', full_name: 'An', phone: '090' } }],
});

beforeEach(() => { h.calls = []; h.queue = []; h.data = { total: 0, today: '2026-10-17', rows: [] }; h.error = null; h.from.mockReset(); });

it('đưa đúng bộ lọc trang thành tham số contract_list_v1, một lời gọi, không đọc bảng trực tiếp', async () => {
  await contractsPagedQuery(
    { search: '  Nguyễn  ', building_ids: ['b1', 'b2'], room_name: '101', lifecycle: 'ACTIVE', stat: 'EXPIRING', month: '2026-10' },
    { page: 3, pageSize: 20 },
  ).queryFn();
  expect(h.calls).toEqual([{ fn: 'contract_list_v1', args: {
    p_search: 'Nguyễn', p_building_ids: ['b1', 'b2'], p_room_name: '101', p_lifecycle: 'ACTIVE', p_stat: 'EXPIRING',
    p_month: '2026-10', p_limit: 20, p_offset: 40,
  } }]);
  expect(h.from).not.toHaveBeenCalled();
});

it('giá trị "tất cả" của trang không thành bộ lọc: toà [] , phòng all, tháng/tìm rỗng; mặc định ALL', async () => {
  await contractsPagedQuery({ search: '   ', building_ids: [], room_name: 'all', month: '' }, { page: 1, pageSize: 15 }).queryFn();
  expect(h.calls[0].args).toEqual({
    p_search: undefined, p_building_ids: undefined, p_room_name: undefined, p_lifecycle: 'ALL', p_stat: 'ALL',
    p_month: undefined, p_limit: 15, p_offset: 0,
  });
  await contractsPagedQuery().queryFn();
  expect(h.calls[1].args).toMatchObject({ p_lifecycle: 'ALL', p_stat: 'ALL', p_limit: 1000, p_offset: 0 });
});

it('giữ trần 1000 dòng mỗi lượt như max-rows cũ (mobile "Tải thêm" nhiều lần)', async () => {
  await contractsPagedQuery({}, { page: 1, pageSize: 1035 }).queryFn();
  expect(h.calls[0].args).toMatchObject({ p_limit: 1000, p_offset: 0 });
});

it('trả hàng kèm nhãn SQL và tổng; getContractDisplayStatus dùng nhãn đó', async () => {
  h.data = { total: 41, today: '2026-10-17', rows: [row('c1')] };
  const page = await contractsPagedQuery({}, { page: 1, pageSize: 20 }).queryFn();
  expect(page.count).toBe(41);
  expect(page.data[0].display_status).toBe('EXPIRING');
  // end_date 2030 tính tại chỗ sẽ là "Còn hạn" — hàng danh sách hiện đúng nhãn SQL.
  expect(getContractDisplayStatus(page.data[0])).toBe('EXPIRING');
});

it.each([
  ['nhãn lạ', { total: 1, rows: [row('c1', 'SOON')] }],
  ['thiếu nhãn', { total: 1, rows: [{ ...row('c1'), display_status: undefined }] }],
  ['thiếu danh sách khách', { total: 1, rows: [{ ...row('c1'), contract_customers: null }] }],
  ['thiếu id', { total: 1, rows: [{ ...row('c1'), id: undefined }] }],
  ['rows không phải mảng', { total: 0, rows: null }],
])('phản hồi hỏng (%s) báo lỗi, không hiện danh sách đoán', async (_label, data) => {
  h.data = data;
  await expect(contractsPagedQuery({}, { page: 1, pageSize: 20 }).queryFn()).rejects.toThrow();
});

it('lỗi RPC (quyền/validation) được ném nguyên cho trang hiện thẻ lỗi', async () => {
  h.error = { code: '22023', message: 'Tháng phải có dạng YYYY-MM' };
  await expect(contractsPagedQuery({ month: '2026-10' }, { page: 1, pageSize: 20 }).queryFn()).rejects.toMatchObject({ code: '22023' });
});

it('xuất Excel đọc từng khúc 1000 cùng bộ lọc tới khi đủ tổng', async () => {
  const many = Array.from({ length: 1000 }, (_, i) => row(`c${i}`));
  h.queue = [{ total: 1001, today: '2026-10-17', rows: many }, { total: 1001, today: '2026-10-17', rows: [row('last')] }];
  const all = await fetchContractsForExport({ stat: 'EXPIRED' });
  expect(all).toHaveLength(1001);
  expect(h.calls.map((c) => [c.args.p_offset, c.args.p_limit, c.args.p_stat])).toEqual([[0, 1000, 'EXPIRED'], [1000, 1000, 'EXPIRED']]);
});

it.each(['2026-13', '2026-00', '10/2026', 'abc'])('tháng lưu trong phiên sai dạng (%s) ⇒ bỏ lọc tháng như web cũ, không gửi lên SQL', async (month) => {
  await contractsPagedQuery({ month }, { page: 1, pageSize: 20 }).queryFn();
  expect(h.calls[0].args.p_month).toBeUndefined();
});

it('ô thống kê đọc contract_stats_v2 (cùng RLS/mốc ngày với danh sách); toà [] = mọi toà; số thiếu thì báo lỗi', async () => {
  h.data = { total: 9, expiring: 2, expired: 1, terminated: 3, today: '2026-10-17' };
  await expect(contractStatsQuery(['b1']).queryFn()).resolves.toEqual({ total: 9, expiring: 2, expired: 1, terminated: 3, today: '2026-10-17' });
  await contractStatsQuery([]).queryFn();
  expect(h.calls).toEqual([{ fn: 'contract_stats_v2', args: { p_building_ids: ['b1'] } }, { fn: 'contract_stats_v2', args: { p_building_ids: undefined } }]);
  h.data = { total: 9, expiring: null, expired: 1, terminated: 3, today: '2026-10-17' };
  await expect(contractStatsQuery().queryFn()).rejects.toThrow();
  h.data = { total: 9, expiring: 2, expired: 1, terminated: 3 };
  await expect(contractStatsQuery().queryFn(), 'thiếu ngày công ty').rejects.toThrow();
});

it('đọc lại đúng lúc qua 00:00 giờ VN (+5 s) để nhãn/ô không giữ ngày cũ', () => {
  expect(msToNextVnMidnight(Date.parse('2026-10-17T16:59:00Z'))).toBe(60_000 + 5_000); // 23:59 giờ VN
  expect(msToNextVnMidnight(Date.parse('2026-10-17T17:00:00Z'))).toBe(86_400_000 + 5_000); // đúng 00:00 giờ VN
  expect(msToNextVnMidnight(Date.parse('2026-10-17T05:00:00Z'))).toBe(12 * 3_600_000 + 5_000); // 12:00 giờ VN
});

it('đọc lại theo ngày SQL: ngày cũ hơn hôm nay giờ VN ⇒ 60 s (+jitter); còn lại ⇒ qua 00:00 giờ VN (+jitter)', () => {
  const noon = Date.parse('2026-10-17T05:00:00Z'); // 12:00 giờ VN ngày 17/10
  expect(contractDayRefetchMs('2026-10-16', noon, () => 0)).toBe(60_000);
  expect(contractDayRefetchMs('2026-10-16', noon, () => 0.999)).toBe(60_000 + 29_970);
  expect(contractDayRefetchMs('2026-10-17', noon, () => 0)).toBe(msToNextVnMidnight(noon));
  expect(contractDayRefetchMs(undefined, noon, () => 0.5)).toBe(msToNextVnMidnight(noon) + 15_000);
  // 00:30 giờ VN ngày 18/10 mà SQL còn trả 17/10 (đồng hồ lệch) ⇒ đọc lại sớm.
  expect(contractDayRefetchMs('2026-10-17', Date.parse('2026-10-17T17:30:00Z'), () => 0)).toBe(60_000);
});

it('danh sách và ô thống kê gắn đúng lịch đọc lại theo ngày SQL, kể cả tab nền', () => {
  type Opts = { refetchInterval: (q: { state: { data?: { today?: string } } }) => number; refetchIntervalInBackground: boolean };
  for (const opts of [useContractsPaged() as unknown as Opts, useContractStats() as unknown as Opts]) {
    expect(opts.refetchIntervalInBackground).toBe(true);
    const stale = opts.refetchInterval({ state: { data: { today: '2000-01-01' } } });
    expect(stale).toBeGreaterThanOrEqual(60_000);
    expect(stale).toBeLessThan(90_000);
    const fresh = opts.refetchInterval({ state: { data: { today: '2999-01-01' } } });
    expect(fresh).toBeGreaterThan(5_000);
    expect(fresh).toBeLessThanOrEqual(86_400_000 + 35_000);
  }
});

it('ô Sắp hết hạn trên trang chủ = ô của contract_stats_v2 (không tự đếm theo ngày máy)', async () => {
  h.data = { total: 9, expiring: 4, expired: 1, terminated: 3, today: '2026-10-17' };
  h.from.mockImplementation(() => { const b: Record<string, unknown> = {}; for (const n of ['select', 'is', 'eq', 'in', 'gte', 'lte']) b[n] = () => b; b.then = (r: (v: unknown) => unknown) => Promise.resolve({ count: 7, error: null }).then(r); return b; });
  const read = (useContractDashboardCounts('b1') as unknown as { queryFn: () => Promise<unknown> }).queryFn;
  await expect(read()).resolves.toEqual({ active: 7, newThisMonth: 7, expiringSoon: 4, terminatedThisMonth: 7 });
  expect(h.calls).toEqual([{ fn: 'contract_stats_v2', args: { p_building_ids: ['b1'] } }]);
});
