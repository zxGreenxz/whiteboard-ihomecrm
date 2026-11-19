// useInvoiceTotalsByIds (tách khỏi useInvoices.ts 23/10/2026): tên + phần dựng tên của hoá đơn đọc về đúng
// như getInvoiceTitle trên cùng bản ghi (Báo cáo LN giữ nguyên tên). Id / mã giả.
import { afterEach, expect, it, vi } from 'vitest';
import { getInvoiceTitle } from '@/lib/invoiceUtils';
import type { InvoiceWithRelations } from '@/types/invoice';

const h = vi.hoisted(() => ({ rows: [] as unknown[], calls: [] as string[][] }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.in = (_c: string, ids: string[]) => { h.calls.push(ids); return b; };
      b.is = () => Promise.resolve({ data: h.rows, error: null });
      return b;
    },
  },
}));
vi.mock('@tanstack/react-query', () => ({ useQuery: (o: unknown) => o }));

import { useInvoiceTotalsByIds } from '@/hooks/useInvoiceTotalsByIds';

afterEach(() => { h.rows = []; h.calls = []; });

const ROWS = [
  { id: 'i1', total_amount: 3_000_000, paid_amount: 0, remaining_amount: 3_000_000, kind: 'MONTHLY', billing_month: '2026-10',
    notes: null, issue_date: '2026-10-01', contract: { start_billing_date: '2026-10-01' },
    invoice_items: [{ type: 'RENT', from_date: '2026-10-01' }, { type: 'SERVICE', from_date: null }] },
  { id: 'i2', total_amount: '1500000', paid_amount: '0', remaining_amount: '1500000', kind: 'MONTHLY', billing_month: '2026-10',
    notes: null, issue_date: '2026-10-01', contract: null, invoice_items: [{ type: 'SERVICE', from_date: null }, { type: 'PENALTY', from_date: null }] },
  { id: 'i3', total_amount: 500_000, paid_amount: 0, remaining_amount: 500_000, kind: 'SETTLEMENT', billing_month: '2026-10',
    notes: 'Hoá đơn thu thêm khi bỏ cọc', issue_date: '2026-10-05', contract: null, invoice_items: [] },
];

it('tên hoá đơn đọc về trùng getInvoiceTitle; phần dựng tên đủ để nơi khác chèn phòng', async () => {
  h.rows = ROWS;
  const q = useInvoiceTotalsByIds(['i2', 'i1', 'i3', 'i1']) as unknown as { queryKey: unknown[]; queryFn: () => Promise<Map<string, {
    displayTitle: string; total_amount: number; titleParts: { hasRent: boolean; hasService: boolean; isFirstMonth: boolean; isExtra: boolean };
  }>> };
  expect(q.queryKey).toEqual(['invoice-totals-by-ids', ['i1', 'i2', 'i3']]);
  const map = await q.queryFn();
  expect(h.calls).toEqual([['i1', 'i2', 'i3']]);
  for (const r of ROWS) {
    expect(map.get(r.id)?.displayTitle).toBe(getInvoiceTitle(r as unknown as InvoiceWithRelations));
  }
  expect([...map.values()].map((x) => x.displayTitle)).toEqual([
    'TIỀN PHÒNG THÁNG ĐẦU TIÊN - 10/2026', 'Hóa đơn dịch vụ - 10/2026', 'Hóa đơn thu thêm (thanh lý) - 05/10/2026']);
  expect(map.get('i1')?.titleParts).toMatchObject({ hasRent: true, hasService: true, isFirstMonth: true });
  expect(map.get('i2')?.titleParts).toMatchObject({ hasRent: false, hasService: true });
  expect(map.get('i3')?.titleParts).toMatchObject({ isExtra: true });
  expect(map.get('i2')?.total_amount).toBe(1_500_000);
});
