import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useQuery } from '@tanstack/react-query';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), getSessionUser: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({ useQuery: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: mocks.getSessionUser }));

import { useChangeBreakdown, useDepositBreakdown } from '../useStatBreakdowns';
import type { InvoiceStatisticsFilters } from '../useInvoices';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionUser.mockResolvedValue({ id: 'fixture-user' });
  mocks.rpc.mockResolvedValue({ data: [], error: null });
});

for (const [kind, hook, rpcName] of [
  ['change', useChangeBreakdown, 'invoice_change_breakdown_v1'],
  ['deposit', useDepositBreakdown, 'invoice_deposit_breakdown_v1'],
] as const) {
  const query = (filters?: InvoiceStatisticsFilters, enabled = true) => {
    hook(filters, enabled);
    const options = vi.mocked(useQuery).mock.calls.at(-1)![0];
    return { ...options, run: options.queryFn as () => Promise<Record<string, unknown>[]> };
  };
  describe(`${kind} breakdown hook`, () => {
    it('giữ query key, enabled, cache và toàn bộ bộ lọc như thẻ', async () => {
      const filters: InvoiceStatisticsFilters = { building_id: 'b2', building_ids: ['b1', 'b2'], room_id: 'r1',
        billing_month: '2026-10', status: 'CANCELLED', payment_status: 'unpaid', start_date: '2026-10-01', end_date: '2026-10-31' };
      const q = query(filters, false);
      expect(q.queryKey).toEqual([`${kind}-breakdown`, filters]);
      expect(q.enabled).toBe(false);
      expect(q.staleTime).toBe(60_000);
      expect(q.meta).toEqual({ feedback: 'inline' });
      await q.run();
      expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith(rpcName, {
        p_billing_month: '2026-10', p_status: 'CANCELLED', p_payment_status: 'unpaid',
        p_filter_building_ids: ['b2'], p_room_ids: ['r1'], p_issue_date_from: '2026-10-01', p_issue_date_to: '2026-10-31',
      });
    });
    it('toàn kỳ, giao toà rỗng và array trống giống thẻ', async () => {
      await query().run();
      expect(mocks.rpc).toHaveBeenLastCalledWith(rpcName, {
        p_billing_month: undefined, p_status: undefined, p_payment_status: undefined,
        p_filter_building_ids: undefined, p_room_ids: undefined, p_issue_date_from: undefined, p_issue_date_to: undefined,
      });
      await query({ building_id: 'b9', building_ids: ['b1'] }).run();
      expect(mocks.rpc).toHaveBeenLastCalledWith(rpcName, expect.objectContaining({ p_filter_building_ids: [] }));
      await query({ building_ids: [] }).run();
      expect(mocks.rpc).toHaveBeenLastCalledWith(rpcName, expect.objectContaining({ p_filter_building_ids: undefined }));
    });
    it('giữ cấu trúc dòng, chuyển tiền dạng chuỗi và không cắt hơn 1000 dòng', async () => {
      const row = kind === 'change'
        ? { account_id: null, account_name: null, billing_month: '2026-10', building_name: 'Toà A', room_name: '101',
            payer_name: 'Khách thử', voucher_date: '2026-10-05', change_amount: '25', code: 'PT-1' }
        : { building_id: 'b1', room_id: 'r1', contract_id: 'c1', contract_number: 'HĐ-1',
            total_deposit: '100', deposit_paid: '40', deposit_remaining: '60', deposit_debt_mode: 'NORMAL',
            voucher_id: 'v1', code: 'PT-1', voucher_date: '2026-10-05', amount: '40', account_name: 'Sổ A',
            notes: 'Cọc', invoice_id: 'i1', invoice_number: 'HD-1', invoice_total: '200' };
      mocks.rpc.mockResolvedValue({ data: Array.from({ length: 1001 }, () => row), error: null });
      const rows = await query().run();
      expect(rows).toHaveLength(1001);
      expect(rows[0]).toMatchObject(kind === 'change'
        ? { change_amount: 25, account_name: '(chưa gán sổ thối)', payer_name: 'Khách thử' }
        : { amount: 40, total_deposit: 100, deposit_paid: 40, deposit_remaining: 60,
            invoice_total: 200, building_name: '—', room_name: '—', voucher_id: 'v1' });
    });
    it('không đăng nhập/lỗi RPC/phản hồi hỏng phải ném, không hiện 0 giả', async () => {
      mocks.getSessionUser.mockResolvedValueOnce(null);
      await expect(query().run()).rejects.toThrow('Not authenticated');
      expect(mocks.rpc).not.toHaveBeenCalled();
      mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'denied' } });
      await expect(query().run()).rejects.toMatchObject({ code: '42501' });
      for (const data of [null, {}, [{ change_amount: null, amount: 'bad' }]]) {
        mocks.rpc.mockResolvedValueOnce({ data, error: null });
        await expect(query().run()).rejects.toThrow('Chưa đọc');
      }
    });
  });
}
