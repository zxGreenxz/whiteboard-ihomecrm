// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
const h = vi.hoisted(() => ({ rpc: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({ useMutation: (options: unknown) => options, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: h.rpc } }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'user' }) }));
vi.mock('sonner', () => ({ toast: { success: h.success, error: h.error, warning: vi.fn() } }));
import { useCreateIncomeExpense } from '../mutations';
import type { CreateIncomeExpenseInput } from '../types';
const org = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const source = { provider: 'grab' as const, mailbox: 'test@gmail.com', receipt_id: 'GRAB123', message_id: 'abc123' };
const input: CreateIncomeExpenseInput = { type: 'EXPENSE', name: 'Chi Grab', building_id: id, account_id: id, voucher_date: '2026-10-04', attachments: [], business_result_accounting: null,
  items: [{ income_expense_type_id: id, quantity: 1, unit_price: 85000, start_date: '2026-10-01', end_date: '2026-10-31' }], email_bill_source: source, email_bill_organization_id: org };
type Mutation = { mutationFn: (value: CreateIncomeExpenseInput) => Promise<unknown>; onSuccess: (data: unknown) => void };
beforeEach(() => { vi.clearAllMocks(); });
it('email source always uses atomic import and reviewed amount rather than ordinary create', async () => {
  h.rpc.mockResolvedValue({ data: { id, created: true }, error: null });
  const { result } = renderHook(() => useCreateIncomeExpense());
  await (result.current as unknown as Mutation).mutationFn(input);
  expect(h.rpc).toHaveBeenCalledOnce();
  expect(h.rpc.mock.calls[0]).toEqual(['create_income_expense_from_email_v1', expect.objectContaining({ p_organization_id: org, p_source: source, p_items: input.items })]);
});
it('permission or missing RPC never falls through to normal voucher creation', async () => {
  const { result } = renderHook(() => useCreateIncomeExpense());
  for (const code of ['42501', 'PGRST202']) {
    h.rpc.mockClear(); h.rpc.mockResolvedValue({ data: null, error: { code, message: 'rejected' } });
    await expect((result.current as unknown as Mutation).mutationFn(input)).rejects.toThrow();
    expect(h.rpc).toHaveBeenCalledOnce();
    expect(h.rpc.mock.calls[0][0]).toBe('create_income_expense_from_email_v1');
  }
});
it('recovered duplicate does not claim a new voucher was created', () => {
  const { result } = renderHook(() => useCreateIncomeExpense());
  (result.current as unknown as Mutation).onSuccess({ id, created: false });
  expect(h.success).toHaveBeenCalledWith(expect.stringContaining('trước đó'));
});
