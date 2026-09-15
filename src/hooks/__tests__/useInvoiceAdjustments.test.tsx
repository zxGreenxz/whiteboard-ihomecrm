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
// 15/09 (plan con B): bản trước ghim 16 tiền tố — gần đúng bằng tập mà hub
// realtime tự đánh ~0,8s sau khi hàng `invoices` đổi, tức mutation và hub làm
// hai lượt trên cùng một thứ. Giờ mutation chỉ giữ phần hub KHÔNG phủ, và ca này
// ghim cả hai vế: cái gì còn phải đánh, cái gì cố ý thôi không đánh.
it('invalidates the adjusted invoice and the aggregates the realtime hub does not cover', async () => {
  boundary.adjust.mockResolvedValue({ id: 'rev', invoice_id: 'inv' });
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity }, mutations: { retry: false } } });
  const aggregates = ['excess-amount', 'invoice-rounding-report', 'invoice-payments-summary', 'collection-cycle'];
  // Descriptor `invoices` của hub phủ sẵn — mutation không đánh lại nữa.
  const hubPhu = ['invoices', 'invoices-legacy', 'invoice-statistics', 'invoice-totals-by-ids', 'first-invoice-details', 'invoice-rent-periods', 'business-performance', 'unpaid-invoices'];
  aggregates.forEach(key => client.setQueryData([key, 'context'], { old: true }));
  hubPhu.forEach(key => client.setQueryData([key, 'context'], { old: true }));
  client.setQueryData(['invoice', 'inv'], { old: true });
  client.setQueryData(['invoice-history', 'inv'], { old: true });
  client.setQueryData(['invoice', 'hoa-don-khac'], { old: true });
  client.setQueryData(['unrelated'], true);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result, unmount } = renderHook(useAdjustInvoice, { wrapper });
  await act(() => result.current.mutateAsync({ invoiceId: 'inv' } as AdjustInvoiceInput));
  for (const key of aggregates) expect(client.getQueryState([key, 'context'])?.isInvalidated, key).toBe(true);
  expect(client.getQueryState(['invoice', 'inv'])?.isInvalidated).toBe(true);
  expect(client.getQueryState(['invoice-history', 'inv'])?.isInvalidated).toBe(true);
  // Hoá đơn KHÁC không bị kéo theo — đây là phần tiết kiệm thật sự trên màn danh sách.
  expect(client.getQueryState(['invoice', 'hoa-don-khac'])?.isInvalidated).toBe(false);
  for (const key of hubPhu) expect(client.getQueryState([key, 'context'])?.isInvalidated, key).toBe(false);
  expect(client.getQueryState(['unrelated'])?.isInvalidated).toBe(false);
  unmount(); client.clear();
});

// Không có mốc này thì hub vẫn đánh lượt thứ hai đầy đủ + prefetch cả domain,
// tức phần cắt ở ca trên chỉ là dời việc chứ không phải bớt việc.
it('marks the invoices table as locally written so the hub collapses its echo', async () => {
  const { laTiengVongNoiBo, __resetLocalWriteEchoForTest } = await import('@/lib/realtime/localWriteEcho');
  __resetLocalWriteEchoForTest();
  boundary.adjust.mockResolvedValue({ id: 'rev', invoice_id: 'inv' });
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result, unmount } = renderHook(useAdjustInvoice, { wrapper });
  expect(laTiengVongNoiBo('invoices', Date.now())).toBe(false);
  await act(() => result.current.mutateAsync({ invoiceId: 'inv' } as AdjustInvoiceInput));
  expect(laTiengVongNoiBo('invoices', Date.now())).toBe(true);
  __resetLocalWriteEchoForTest();
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
