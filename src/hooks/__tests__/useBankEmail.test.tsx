// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  review: vi.fn(),
  organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
}));

vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: mocks.organizationId }) }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: { id: 'actor-1' } }) }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor-1' }) }));
vi.mock('@/lib/bankEmail', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/bankEmail')>();
  return { ...actual, listBankEmail: mocks.list, reviewBankEmail: mocks.review };
});

import { useBankEmailInbox, useReviewBankEmail } from '../useBankEmail';
import { BankEmailActualOutcomeError } from '@/lib/bankEmail';

const empty = { connections: [], transactions: [], hasMore: false };

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function wrap(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

afterEach(() => { vi.clearAllMocks(); mocks.organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; });

describe('bank email hook', () => {
  it('fetches the selected organization and isolates a later organization change', async () => {
    mocks.list.mockResolvedValue(empty);
    const queryClient = client();
    const { result, rerender } = renderHook(() => useBankEmailInbox(), { wrapper: wrap(queryClient) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mocks.list).toHaveBeenCalledWith('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', null);
    mocks.organizationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    rerender();
    await waitFor(() => expect(mocks.list).toHaveBeenCalledWith('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', null));
    expect(queryClient.getQueryData(['bank-email', 'actor-1', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'])).not.toBeUndefined();
  });

  it('invalidates money reads only after a confirmed posted receipt', async () => {
    const receipt = { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', status: 'POSTED', reason: null, invoiceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', receipt: {
      collection_id: '11111111-1111-4111-8111-111111111111', invoice_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', gross_amount: 500000, applied_amount: 500000, change_amount: 0, credit_amount: 0, rounding_amount: 0, credit_lot_id: null,
      tenders: [{ tender_id: '22222222-2222-4222-8222-222222222222', payment_id: '33333333-3333-4333-8333-333333333333', voucher_id: '44444444-4444-4444-8444-444444444444', applied_amount: 500000 }], invoice: { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' },
    } };
    mocks.review.mockResolvedValue(receipt);
    const queryClient = client();
    const invalidated: string[] = [];
    const originalInvalidate = queryClient.invalidateQueries.bind(queryClient);
    vi.spyOn(queryClient, 'invalidateQueries').mockImplementation(async options => {
      invalidated.push(String(options?.queryKey?.[0]));
      return originalInvalidate(options);
    });
    const { result } = renderHook(() => useReviewBankEmail(), { wrapper: wrap(queryClient) });
    await act(async () => {
      await result.current.mutateAsync({ transactionId: receipt.id, organizationId: mocks.organizationId, invoiceNumber: 'HD-01', expectedInvoiceId: receipt.invoiceId, expectedAmount: 500000, action: 'post' });
    });
    expect(invalidated).toContain('invoices');
    expect(invalidated).toContain('payments');
    expect(invalidated).toContain('accounts-with-balance');
  });

  it('does not invalidate money reads for an ignored transaction', async () => {
    mocks.review.mockResolvedValue({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', status: 'IGNORED', reason: null, invoiceId: null, receipt: null });
    const queryClient = client();
    const invalidated: string[] = [];
    vi.spyOn(queryClient, 'invalidateQueries').mockImplementation(async options => { invalidated.push(String(options?.queryKey?.[0])); });
    const { result } = renderHook(() => useReviewBankEmail(), { wrapper: wrap(queryClient) });
    await act(async () => {
      await result.current.mutateAsync({ transactionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', organizationId: mocks.organizationId, action: 'ignore' });
    });
    expect(invalidated).toContain('bank-email');
    expect(invalidated).not.toContain('invoices');
  });

  it('invalidates money reads when the server already posted a different actual invoice', async () => {
    const actualInvoiceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const actual = { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', status: 'POSTED' as const, reason: null, invoiceId: actualInvoiceId, receipt: {
      collection_id: '11111111-1111-4111-8111-111111111111', invoice_id: actualInvoiceId,
      gross_amount: 500000, applied_amount: 500000, change_amount: 0, credit_amount: 0,
      rounding_amount: 0, credit_lot_id: null,
      tenders: [{ tender_id: '22222222-2222-4222-8222-222222222222', payment_id: '33333333-3333-4333-8333-333333333333', voucher_id: '44444444-4444-4444-8444-444444444444', applied_amount: 500000 }],
      invoice: { id: actualInvoiceId },
    } };
    mocks.review.mockRejectedValue(new BankEmailActualOutcomeError(actual));
    const queryClient = client();
    const invalidated: string[] = [];
    vi.spyOn(queryClient, 'invalidateQueries').mockImplementation(async options => { invalidated.push(String(options?.queryKey?.[0])); });
    const { result } = renderHook(() => useReviewBankEmail(), { wrapper: wrap(queryClient) });
    await act(async () => {
      await expect(result.current.mutateAsync({ transactionId: actual.id, organizationId: mocks.organizationId, invoiceNumber: 'HD-01', expectedInvoiceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', expectedAmount: 500000, action: 'post' })).rejects.toBeInstanceOf(BankEmailActualOutcomeError);
    });
    expect(invalidated).toContain('bank-email');
    expect(invalidated).toContain('invoices');
    expect(invalidated).toContain('payments');
    expect(invalidated).toContain('accounts-with-balance');
  });
});
