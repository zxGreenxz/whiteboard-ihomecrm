// @vitest-environment jsdom
// Phiếu tổng: mỗi dòng có "Tên phiếu lẻ" riêng ⇒ phiếu lẻ tên "<tên lẻ> - <tên phiếu tổng>";
// dòng để trống giữ cách cũ "<tên phiếu tổng> - <loại hạng mục>" (15/11/2026).
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({ useMutation: (options: unknown) => options, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: h.rpc, from: h.from } }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'u1', user_metadata: { full_name: 'Người lập' } }) }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'o1' }) }));
vi.mock('../accountingClass', () => ({ loadIncomeExpenseAccountingClassResolver: async () => () => 'OTHER' }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
import { useCreateIncomeExpenseBatch } from '../batch';
import { batchChildVoucherName, type IncomeExpenseBatchFormValues } from '@/lib/incomeExpenseValidation';

type Builder = { insert: () => Builder; select: () => Builder; single: () => Promise<unknown>; then: (resolve: (r: unknown) => unknown) => Promise<unknown> };
const dong = { building_id: 'b1', room_id: null, income_expense_type_id: 't1', type_name: 'Điện lạnh', quantity: 1, unit_price: 100, start_date: '2026-10-01', end_date: '2026-10-31' };
const input: IncomeExpenseBatchFormValues = {
  type: 'EXPENSE', shared_name: 'Chốt ML đợt 1', account_id: 'a1', voucher_date: '2026-10-31', payer_name: null,
  business_result_accounting: null, attachments: [], notes: null,
  items: [{ ...dong, voucher_name: '  VSML 101 (3/7) ' }, { ...dong, voucher_name: '   ' }, { ...dong }],
};

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); }, removeItem: (k: string) => { values.delete(k); } });
  h.rpc.mockReset(); h.from.mockReset();
});

describe('Tên phiếu lẻ trong phiếu tổng', () => {
  it('ghép tên lẻ trước tên phiếu tổng; trống thì giữ tên cũ theo loại hạng mục', () => {
    expect(batchChildVoucherName('Chốt ML đợt 1', { voucher_name: 'VSML 101 (3/7)', type_name: 'Điện lạnh' })).toBe('VSML 101 (3/7) - Chốt ML đợt 1');
    expect(batchChildVoucherName('  ', { voucher_name: 'VSML 101' })).toBe('VSML 101');
    expect(batchChildVoucherName('Chốt ML đợt 1', { voucher_name: ' ', type_name: 'Điện lạnh' })).toBe('Chốt ML đợt 1 - Điện lạnh');
    expect(batchChildVoucherName('Chốt ML đợt 1', { type_name: 'Điện lạnh' })).toBe('Chốt ML đợt 1 - Điện lạnh');
  });

  it('mỗi phiếu lẻ gửi lên máy chủ mang đúng tên của dòng mình', async () => {
    const builder: Builder = { insert: vi.fn(() => builder), select: vi.fn(() => builder), single: vi.fn().mockResolvedValue({ data: { id: 'batch1' }, error: null }), then: (resolve) => Promise.resolve({ error: null }).then(resolve) };
    h.from.mockReturnValue(builder);
    h.rpc.mockResolvedValueOnce({ data: { id: 'v1' }, error: null }).mockResolvedValueOnce({ data: { id: 'v2' }, error: null }).mockResolvedValueOnce({ data: { id: 'v3' }, error: null });
    const mutation = useCreateIncomeExpenseBatch() as unknown as { mutationFn: (i: IncomeExpenseBatchFormValues) => Promise<{ voucherIds: string[] }> };
    const result = await mutation.mutationFn(input);
    expect(result.voucherIds).toEqual(['v1', 'v2', 'v3']);
    const names = h.rpc.mock.calls.map(([fn, args]) => [fn, (args as { p_row: { name: string } }).p_row.name]);
    expect(names).toEqual([
      ['ie_compat_insert_v2', 'VSML 101 (3/7) - Chốt ML đợt 1'],
      ['ie_compat_insert_v2', 'Chốt ML đợt 1 - Điện lạnh'],
      ['ie_compat_insert_v2', 'Chốt ML đợt 1 - Điện lạnh'],
    ]);
  });
});
