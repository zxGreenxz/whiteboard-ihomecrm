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
import { contractsPagedQuery, fetchContractsForExport } from '../useContracts';
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
  await expect(contractsPagedQuery({ month: '2026-13' }, { page: 1, pageSize: 20 }).queryFn()).rejects.toMatchObject({ code: '22023' });
});

it('xuất Excel đọc từng khúc 1000 cùng bộ lọc tới khi đủ tổng', async () => {
  const many = Array.from({ length: 1000 }, (_, i) => row(`c${i}`));
  h.queue = [{ total: 1001, today: '2026-10-17', rows: many }, { total: 1001, today: '2026-10-17', rows: [row('last')] }];
  const all = await fetchContractsForExport({ stat: 'EXPIRED' });
  expect(all).toHaveLength(1001);
  expect(h.calls.map((c) => [c.args.p_offset, c.args.p_limit, c.args.p_stat])).toEqual([[0, 1000, 'EXPIRED'], [1000, 1000, 'EXPIRED']]);
});
