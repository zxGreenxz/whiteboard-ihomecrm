// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RecordPaymentRPCData } from '../useInvoicePayments';
import type { BulkPaymentParams, BulkPaymentResult } from '../useBulkRecordPayment';

const mock = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), invalidateQueries: vi.fn(), depositDue: 0 }));
vi.mock('@tanstack/react-query', () => ({ useMutation: (options: unknown) => options,
  useQueryClient: () => ({ invalidateQueries: mock.invalidateQueries }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mock.rpc, from: mock.from } }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor' }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
import { useRecordPaymentRPC } from '../useInvoicePayments';
import { useBulkRecordPayment } from '../useBulkRecordPayment';

beforeEach(() => {
  vi.clearAllMocks();
  mock.depositDue = 0;
  mock.rpc.mockResolvedValue({ data: { tenders: [] }, error: null });
  mock.from.mockImplementation((table: string) => {
    const query = { select: () => query, eq: () => query,
      single: async () => ({ data: { id: 'invoice', total_amount: 4_805_000, paid_amount: 0, contract_id: 'contract', invoice_items: mock.depositDue ? [{ accounting_class: 'DEPOSIT', amount: mock.depositDue }] : [] }, error: null }),
      in: async () => ({ data: [{ id: 'cash', is_virtual: false }, { id: 'change', is_virtual: true }, { id: 'rounding', is_virtual: true }], error: null }) };
    return query;
  });
});
afterEach(cleanup);

it('single invoice hook preserves actual change in the V5 JSON', async () => {
  const { result } = renderHook(() => useRecordPaymentRPC());
  const mutation = result.current as unknown as { mutationFn: (input: RecordPaymentRPCData) => Promise<unknown> };
  await mutation.mutationFn({ invoice_id: 'invoice', collection_date: '2026-09-08', expected_paid_amount: 0,
    invoice_total_amount: 4_805_000, actual_change_amount: 200_000, overpay_action: 'REFUND', allow_rounding: true,
    tenders: [{ payment_method: 'TM', gross_amount: 5_000_000, account_id: 'cash', change_account_id: 'change', rounding_account_id: 'rounding' }] });
  expect(mock.rpc.mock.lastCall?.[1].p_tenders).toMatchObject([{ gross_amount: 5_000_000, requested_change_amount: 200_000 }]);
});

const params: BulkPaymentParams = { payment_date: '2026-09-08', items: [{ invoice_id: 'invoice',
  amount_tm: 5_000_000, amount_tk: 0, amount_tt: 0, change_amount: 200_000,
  account_id: 'cash', change_account_id: 'change', rounding_amount: 5_000, rounding_account_id: 'rounding' }] };

it('Thu tiền / bulk hook preserves gross, change, rounding and retry identity', async () => {
  const { result } = renderHook(() => useBulkRecordPayment());
  const mutation = result.current as unknown as { mutationFn: (input: BulkPaymentParams) => Promise<BulkPaymentResult> };
  mock.rpc.mockResolvedValueOnce({ data: null, error: { message: 'Network timeout' } });
  expect((await mutation.mutationFn(params)).failures).toHaveLength(1);
  expect((await mutation.mutationFn(params)).ok).toEqual(['invoice']);
  const [first, second] = mock.rpc.mock.calls;
  expect(first[1]).toEqual(second[1]);
  expect(first[1]).toMatchObject({ p_allow_rounding: true,
    p_tenders: [{ gross_amount: 5_000_000, requested_change_amount: 200_000 }] });
});

it('bulk cannot silently retain money by lowering change', async () => {
  const { result } = renderHook(() => useBulkRecordPayment());
  const mutation = result.current as unknown as { mutationFn: (input: BulkPaymentParams) => Promise<BulkPaymentResult> };
  const response = await mutation.mutationFn({ ...params, items: [{ ...params.items[0], change_amount: 190_000 }] });
  expect(response.failures).toHaveLength(1);
  expect(mock.rpc).not.toHaveBeenCalled();
});

it('fresh deposit data keeps the shortage as debt while still recording actual money', async () => {
  mock.depositDue = 1_000_000;
  const { result } = renderHook(() => useBulkRecordPayment());
  const mutation = result.current as unknown as { mutationFn: (input: BulkPaymentParams) => Promise<BulkPaymentResult> };
  expect((await mutation.mutationFn(params)).ok).toEqual(['invoice']);
  expect(mock.rpc.mock.lastCall?.[1]).toMatchObject({ p_allow_rounding: false,
    p_tenders: [{ requested_change_amount: 200_000, rounding_account_id: null }] });
});
