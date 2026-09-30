// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { InvoiceWithRelations } from '@/types/invoice';

const h = vi.hoisted(() => ({
  read: vi.fn(),
  firstError: false,
  tenderError: false,
  retryFirst: vi.fn(),
  retryTender: vi.fn(),
}));
const source = (data: unknown, error = false, refetch = vi.fn()) => ({
  data: error ? undefined : data, error: error ? new Error('Failed to fetch') : null,
  status: error ? 'error' : 'success', fetchStatus: 'idle', isError: error, isLoading: false, refetch,
});
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: () => { const b = { select: () => b, eq: () => b, order: h.read }; return b; } },
}));
vi.mock('@/hooks/useInvoices', () => ({
  useFirstInvoiceDetails: () => source(new Map(), h.firstError, h.retryFirst),
  useContractDepositVouchers: () => source([]),
}));
vi.mock('@/hooks/useCollectionTenders', () => ({
  useInvoiceTenders: () => source([], h.tenderError, h.retryTender), toChangeMethodTender: vi.fn(),
}));
vi.mock('@/hooks/useDeletePayment', () => ({
  useDeletePayment: () => ({ mutate: vi.fn(), isPending: false }),
  useCollectionReversalEligibility: () => source({}), COLLECTION_BLOCK_TEXT: {},
}));
vi.mock('@/hooks/useUploadPaymentReceipt', () => ({ useUploadPaymentReceipt: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock('@/hooks/useClipboardImagePaste', () => ({ useClipboardImagePaste: () => ({}) }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: { id: 'user1' } }) }));
vi.mock('@/hooks/useIsCompanyOwner', () => ({ useIsCompanyOwner: () => ({ data: false }) }));
vi.mock('@/hooks/useIsAdmin', () => ({ useIsSuperAdmin: () => ({ data: false }) }));
vi.mock('@/components/ui/attachment-lightbox', () => ({ AttachmentLightbox: () => null }));
vi.mock('../ChangeCollectionMethodDialog', () => ({ default: () => null }));
import PaymentsSummaryDialog from '../PaymentsSummaryDialog';

const receipt = {
  id: 'tender1', source_kind: 'COLLECTION_TENDER', payment_id: null, collection_id: 'collection1',
  voucher_id: 'voucher1', account_id: 'book1', collected_amount: 120000, applied_amount: 100000,
  credit_amount: 20000, payment_method: 'TM', payment_date: '2026-09-29',
  receipt_number: 'PT-01', receipt_image_url: null, created_at: '2026-09-29T02:00:00Z',
};
const invoice = { id: 'invoice1', invoice_number: 'HD-01', billing_month: '2026-09', total_amount: 100000, paid_amount: 100000, remaining_amount: 0 } as InvoiceWithRelations;
function view() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><PaymentsSummaryDialog open onOpenChange={() => {}} invoice={invoice} /></QueryClientProvider>);
}
beforeEach(() => { vi.clearAllMocks(); h.firstError = false; h.tenderError = false; h.read.mockResolvedValue({ data: [receipt], error: null }); });
afterEach(cleanup);

it.each([null, [{ ...receipt, collected_amount: null }], [{ ...receipt, applied_amount: 'invalid' }], [{ ...receipt, credit_amount: '' }]])(
  'biên nhận thiếu hoặc tiền lỗi không thành empty/zero: %s', async data => {
    h.read.mockResolvedValue({ data, error: null }); view();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Chưa tải được'));
    expect(screen.queryByText('Chưa có phiếu thanh toán nào.')).toBeNull();
    expect(screen.queryByText(/Tổng receipt/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Hoàn tác' })).toBeNull();
  },
);
it('tổng thu dùng biên nhận máy chủ, gồm cả phần credit thay vì số đã áp vào hóa đơn', async () => {
  view(); await screen.findByText(/Tổng receipt/);
  const total = screen.getByText(/Tổng receipt/).parentElement!;
  expect(total.textContent).toContain('120.000');
  expect(screen.getByText(/Áp vào HĐ: 100\.000/)).toBeTruthy();
  expect(screen.getByText(/Credit: 20\.000/)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Phiếu thu PT-01' }).getAttribute('href')).toContain('voucher1');
});
it.each(['first', 'tender'])('thiếu nguồn %s chặn tổng và cho tải lại từng nguồn', async which => {
  h.firstError = which === 'first'; h.tenderError = which === 'tender'; view();
  await screen.findByRole('alert'); expect(screen.queryByText(/Tổng receipt/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Tải lại' }));
  await waitFor(() => expect(which === 'first' ? h.retryFirst : h.retryTender).toHaveBeenCalledOnce());
});
