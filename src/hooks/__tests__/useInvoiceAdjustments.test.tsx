// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useAdjustInvoice, useReviewInvoiceAdjustment } from '../useInvoices';
import type { AdjustInvoiceInput } from '@/lib/invoiceAdjustmentRpc';
const boundary = vi.hoisted(() => ({ adjust: vi.fn(), review: vi.fn() }));
vi.mock('@/lib/invoiceAdjustmentRpc', () => ({ adjustInvoice: boundary.adjust, reviewInvoiceAdjustment: boundary.review }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
it('invalidates current documents, collection views and financial projections after adjustment', async () => {
  boundary.adjust.mockResolvedValue({ id: 'rev' });
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity }, mutations: { retry: false } } });
  const keys = ['invoices', 'invoices-legacy', 'invoice', 'invoice-statistics', 'excess-amount', 'invoice-totals-by-ids', 'first-invoice-details', 'invoice-rent-periods', 'business-performance', 'invoice-rounding-report', 'invoice-payments-summary', 'financial-analysis', 'collection-cycle', 'finance-v2-routes', 'invoice-history', 'unpaid-invoices'];
  keys.forEach(key => client.setQueryData([key, 'context'], { old: true }));
  client.setQueryData(['unrelated'], true);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result, unmount } = renderHook(useAdjustInvoice, { wrapper });
  await act(() => result.current.mutateAsync({ invoiceId: 'inv' } as AdjustInvoiceInput));
  for (const key of keys) expect(client.getQueryState([key, 'context'])?.isInvalidated, key).toBe(true);
  expect(client.getQueryState(['unrelated'])?.isInvalidated).toBe(false);
  unmount(); client.clear();
});
it('invalidates warm invoice history after review so the confirmation appears there', async () => {
  boundary.review.mockResolvedValue({ id: 'rev', review_status: 'CHECKED' });
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity }, mutations: { retry: false } } });
  client.setQueryData(['invoice-history', 'inv'], [{ review_status: 'PENDING' }]);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result, unmount } = renderHook(useReviewInvoiceAdjustment, { wrapper });
  await act(() => result.current.mutateAsync({ adjustmentId: 'rev', expectedRevision: 1 }));
  expect(client.getQueryState(['invoice-history', 'inv'])?.isInvalidated).toBe(true);
  unmount(); client.clear();
});
it('keeps failed reviews visible without invalidating data as a success', async () => {
  boundary.review.mockRejectedValue(new Error('Không có quyền xác nhận kiểm tra'));
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  client.setQueryData(['invoice', 'inv'], { old: true });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result, unmount } = renderHook(useReviewInvoiceAdjustment, { wrapper });
  await act(async () => { await expect(result.current.mutateAsync({ adjustmentId: 'rev', expectedRevision: 1 })).rejects.toThrow('Không có quyền'); });
  expect(client.getQueryState(['invoice', 'inv'])?.isInvalidated).toBe(false);
  unmount(); client.clear();
});
