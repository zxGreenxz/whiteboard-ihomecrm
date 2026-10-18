import { beforeEach, expect, it, vi } from 'vitest';
import type { InvoiceWithRelations } from '@/types/invoice';

const h = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('@tanstack/react-query', () => ({ useQuery: (o: unknown) => o }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: () => {
    let offset = 0;
    const b: Record<string, unknown> = {};
    for (const method of ['select', 'is', 'neq', 'eq', 'order']) b[method] = () => b;
    b.range = (from: number) => { offset = from; return b; };
    b.then = (done: (value: unknown) => unknown) => Promise.resolve({ data: offset ? [] : h.rows, error: null }).then(done);
    return b;
  } },
}));
import { useThuTienInvoices } from '../useCollectionReport';
import { latestLivePayment, paidAsOf, paymentsInRange, remainingAsOf } from '@/lib/collect';

const TODAY = '2026-10-18';
// useQuery bị mock thành trả lại config ⇒ lấy thẳng queryFn để chạy.
const queryFnOf = (config: unknown) => (config as { queryFn: () => Promise<InvoiceWithRelations[]> }).queryFn();

beforeEach(() => {
  h.rows = [{
    id: 'inv-1', organization_id: 'org-1', invoice_number: 'HD-1', billing_month: '2026-10', status: 'PARTIAL_PAID',
    total_amount: 3_000_000, paid_amount: 1_000_000, remaining_amount: 2_000_000, notes: null,
    building_id: 'b1', room_id: 'r1', contract_id: 'c1', contract: null, building: null, room: null,
    payments: [
      { id: 'p-song', amount: 1_000_000, payment_date: TODAY, payment_method: 'TM', created_at: `${TODAY}T02:00:00Z`, collection_id: 'col-1', reversed_at: null },
      // Thu nhầm 2.000.000 rồi bấm Hoàn tác — paid_amount đã trừ lại, payment vẫn còn dòng.
      { id: 'p-hoan-tac', amount: 2_000_000, payment_date: TODAY, payment_method: 'TK', created_at: `${TODAY}T03:00:00Z`, collection_id: 'col-2', reversed_at: `${TODAY}T03:05:00Z` },
    ],
  }];
});

it('"đã thu hôm nay" không cộng khoản đã hoàn tác', async () => {
  const [invoice] = await queryFnOf(useThuTienInvoices('2026-10'));
  // Trước đây: 3.000.000 (cộng cả khoản đã hoàn tác) và hoá đơn bị coi như đã thu đủ.
  expect(paymentsInRange(invoice, TODAY, TODAY)).toEqual({ sum: 1_000_000, has: true });
  expect(invoice.payments?.map(p => p.id)).toEqual(['p-song']);
});

it('còn nợ theo ngày tính từ khoản còn sống, nút Hoàn tác vẫn trỏ khoản còn sống', async () => {
  const [invoice] = await queryFnOf(useThuTienInvoices('2026-10'));
  expect(paidAsOf(invoice, TODAY)).toBe(false);
  expect(remainingAsOf(invoice, TODAY)).toBe(2_000_000);
  expect(latestLivePayment(invoice)).toEqual({ id: 'p-song', collection_id: 'col-1' });
});

it('hoá đơn chỉ có khoản đã hoàn tác không xuất hiện là "có thu" trong ngày', async () => {
  (h.rows[0] as { payments: Array<{ reversed_at: string | null }> }).payments[0].reversed_at = `${TODAY}T04:00:00Z`;
  const [invoice] = await queryFnOf(useThuTienInvoices('2026-10'));
  expect(paymentsInRange(invoice, TODAY, TODAY)).toEqual({ sum: 0, has: false });
  expect(latestLivePayment(invoice)).toBeNull();
});
