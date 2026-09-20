// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc } }));
import { useRequestIncomeExpenseChanges, useResubmitIncomeExpenseReview } from './reviewMutations';

const id = 'aaaaaaaa-0000-4000-8000-000000000001';
const input = { voucherId: id, expectedReviewVersion: 3, idempotencyKey: 'same-attempt' };
const response = (reviewState = 'PENDING') => ({ data: { voucherId: id, approvalStatus: 'UNAPPROVED', reviewState, reviewVersion: 4 }, error: null });
const clients: QueryClient[] = [];
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  clients.push(client); return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
beforeEach(() => rpc.mockReset());
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); });

describe('shared review mutations', () => {
  it('resubmits the same voucher with an empty patch and reuses the caller key after an uncertain result', async () => {
    rpc.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(response());
    const { result } = renderHook(() => useResubmitIncomeExpenseReview(), { wrapper });
    await act(async () => { await expect(result.current.mutateAsync(input)).rejects.toMatchObject({ kind: 'unconfirmed' }); });
    await act(async () => { expect(await result.current.mutateAsync(input)).toEqual(response().data); });
    expect(rpc.mock.calls).toEqual(Array.from({ length: 2 }, () => ['resubmit_income_expense_v2', {
      p_voucher: id, p_expected_review_version: 3, p_patch: {}, p_idempotency_key: 'same-attempt',
    }]));
  });
  it('requests review with the reason and never calls create, approve or post', async () => {
    rpc.mockResolvedValue(response('CHANGES_REQUESTED'));
    const { result } = renderHook(() => useRequestIncomeExpenseChanges(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ ...input, reason: 'Kiểm tra lại người nhận' }); });
    expect(rpc).toHaveBeenCalledExactlyOnceWith('request_income_expense_changes_v2', {
      p_voucher: id, p_expected_review_version: 3, p_reason: 'Kiểm tra lại người nhận', p_field_mask: {}, p_idempotency_key: 'same-attempt',
    });
  });
  it.each([['42501', 'permission'], ['40001', 'concurrency'], ['55000', 'conflict']])('preserves %s as a definite rejection without fallback', async (code, kind) => {
    rpc.mockResolvedValue({ data: null, error: { code, message: 'server detail' } });
    const { result } = renderHook(() => useResubmitIncomeExpenseReview(), { wrapper });
    await act(async () => { await expect(result.current.mutateAsync(input)).rejects.toMatchObject({ code, kind }); });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it('does not report success when the returned identity, state or version contradicts the request', async () => {
    const { result } = renderHook(() => useResubmitIncomeExpenseReview(), { wrapper });
    for (const patch of [{ voucherId: 'bbbbbbbb-0000-4000-8000-000000000001' }, { reviewVersion: 9 }, { approvalStatus: 'APPROVED' }, { reviewState: 'CHANGES_REQUESTED' }]) {
      rpc.mockResolvedValueOnce({ ...response(), data: { ...response().data, ...patch } });
      await act(async () => { await expect(result.current.mutateAsync(input)).rejects.toMatchObject({ kind: 'unconfirmed' }); });
    }
    expect(rpc).toHaveBeenCalledTimes(4);
  });
  it('rejects missing CAS or a financial patch before sending a request', async () => {
    const { result } = renderHook(() => useResubmitIncomeExpenseReview(), { wrapper });
    await act(async () => { await expect(result.current.mutateAsync({ ...input, expectedReviewVersion: Number.NaN })).rejects.toMatchObject({ kind: 'validation' }); });
    const accidentalPatch = { ...input, amount: 1_000_000 };
    await act(async () => { await expect(result.current.mutateAsync(accidentalPatch)).rejects.toMatchObject({ kind: 'validation' }); });
    expect(rpc).not.toHaveBeenCalled();
  });
});
