import { beforeEach, expect, it, vi } from 'vitest';

// Giả lập PostgREST: mỗi response tối đa MAX_ROWS dòng (max-rows mặc định 1000).
// Không gọi .range() thì chỉ nhận trang đầu — đúng cách lịch thanh toán cũ bị cắt.
const MAX_ROWS = 1000;
const h = vi.hoisted(() => ({ rows: [] as unknown[], ranges: [] as Array<[number, number]>, orders: [] as string[] }));
vi.mock('@tanstack/react-query', () => ({ useQuery: (o: unknown) => o }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: () => {
    let window: [number, number] | null = null;
    const b: Record<string, unknown> = {};
    for (const method of ['select', 'lte', 'is', 'neq']) b[method] = () => b;
    b.order = (column: string) => { h.orders.push(column); return b; };
    b.range = (from: number, to: number) => { window = [from, to]; h.ranges.push([from, to]); return b; };
    b.then = (done: (value: unknown) => unknown) => {
      const [from, to] = window ?? [0, MAX_ROWS - 1];
      const data = h.rows.slice(from, Math.min(to + 1, from + MAX_ROWS));
      return Promise.resolve({ data, error: null }).then(done);
    };
    return b;
  } },
}));
import { usePaymentScheduleReport } from '../reports/financeReports';

const invoice = (i: number) => ({
  id: `inv-${String(i).padStart(5, '0')}`,
  due_date: '2026-10-01',
  total_amount: 1000,
  paid_amount: 0,
  remaining_amount: 1000,
  room: { id: `r${i}`, name: `P${i}` },
  building: { id: 'b1', name: 'Toà 1' },
  contract: { id: `c${i}`, contract_customers: [{ is_representative: true, customer: { id: `k${i}`, full_name: `Khách ${i}`, phone: null } }] },
});
// useQuery bị mock thành trả lại config ⇒ lấy thẳng queryFn để chạy.
const queryFnOf = (config: unknown) => (config as { queryFn: () => Promise<Array<{ id: string; remaining_amount: number }>> }).queryFn();

beforeEach(() => { h.rows = Array.from({ length: 1700 }, (_, i) => invoice(i)); h.ranges = []; h.orders = []; });

it('lấy đủ 1.700 hoá đơn qua nhiều trang thay vì bị cắt ở 1.000', async () => {
  const result = await queryFnOf(usePaymentScheduleReport(30));
  // Trước đây: một lần gọi không .range() → 1.000 dòng, 700 hoá đơn biến mất khỏi báo cáo.
  expect(result).toHaveLength(1700);
  expect(new Set(result.map(r => r.id)).size).toBe(1700);
  expect(result.reduce((s, r) => s + r.remaining_amount, 0)).toBe(1_700_000);
  expect(h.ranges.length).toBeGreaterThanOrEqual(2);
});

it('phân trang có thứ tự ổn định: due_date rồi id làm tiebreaker', async () => {
  await queryFnOf(usePaymentScheduleReport(30));
  expect(h.orders.slice(0, 2)).toEqual(['due_date', 'id']);
});
