// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import InvoiceAdjustmentHistory from '../InvoiceAdjustmentHistory';
import { InvoiceDetailMobile } from '../InvoiceDetailMobile';
import type { InvoiceAdjustment, InvoiceWithRelations } from '@/types/invoice';
import { InvoiceAdjustmentError } from '@/lib/invoiceAdjustmentRpc';
const mocks = vi.hoisted(() => ({ review: vi.fn(), permission: true, refetch: vi.fn() }));
vi.mock('@/hooks/useInvoices', () => ({ useReviewInvoiceAdjustment: () => ({ mutateAsync: mocks.review, isPending: false }), useInvoice: () => ({ refetch: mocks.refetch }) }));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: {} }) }));
vi.mock('@/lib/permissionPages', () => ({ canUse: (_: unknown, page: string, action: string) => mocks.permission && page === 'invoices' && action === 'approve' }));
vi.mock('@/lib/storage', () => ({ createSignedUrlFromStored: vi.fn() }));
vi.mock('@/components/contracts/detail/useDragScroll', () => ({ useDragScroll: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn() } }));
const snapshot = (description: string, amount: number) => ({ total_amount: amount, discount_amount: 0, notes: description, items: [{ description, unit_price: amount * 4, quantity: 0.5, coefficient: 0.5, amount }] });
const revision = (n: number): InvoiceAdjustment => ({ id: `rev-${n}`, organization_id: 'org', invoice_id: 'inv', idempotency_key: `key-${n}`, adjusted_by: 'user', checked_by: null, revision: n, before_snapshot: snapshot(`Trước ${n}`, n * 1000), after_snapshot: snapshot(`Sau ${n}`, (n + 1) * 1000), before_total: n * 1000, after_total: (n + 1) * 1000, delta: 1000, reason: `Lý do ${n}`, adjusted_at: '2026-09-12T10:00:00Z', review_status: 'PENDING', checked_at: null } as InvoiceAdjustment);
const invoice = { id: 'inv', invoice_adjustments: [revision(2), revision(1)], adjustment_revision: 2, adjustment_review_status: 'PENDING', status: 'APPROVED', total_amount: 3000, discount_amount: 0, previous_debt: 0, invoice_items: [], payments: [], contract_id: 'contract' } as InvoiceWithRelations;
afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); mocks.permission = true; mocks.review.mockResolvedValue({}); });
it('shows immutable original and both before/after snapshots with stored amounts in deterministic order', () => {
  const { container } = render(<InvoiceAdjustmentHistory invoice={invoice} />);
  expect(screen.getByText('Hóa đơn gốc')).toBeTruthy();
  expect(screen.getAllByText('Trước 1').length).toBeGreaterThan(0);
  expect(screen.getAllByText('Sau 2').length).toBeGreaterThan(0);
  expect([...container.querySelectorAll('[data-revision]')].map(node => node.getAttribute('data-revision'))).toEqual(['1', '2']);
  expect(screen.getAllByRole('button', { name: 'Xác nhận kiểm tra' })).toHaveLength(1);
});
it('reviews only the newest revision with the expected revision and prevents duplicate requests', async () => {
  mocks.review.mockReturnValue(new Promise(() => {}));
  render(<InvoiceAdjustmentHistory invoice={invoice} />);
  const button = screen.getByRole('button', { name: 'Xác nhận kiểm tra' }); fireEvent.click(button); fireEvent.click(button);
  await waitFor(() => expect(mocks.review).toHaveBeenCalledOnce());
  expect(mocks.review).toHaveBeenCalledWith({ adjustmentId: 'rev-2', expectedRevision: 2 });
});
it('hides review controls when approve capability is absent', () => {
  mocks.permission = false; render(<InvoiceAdjustmentHistory invoice={invoice} />);
  expect(screen.queryByRole('button', { name: 'Xác nhận kiểm tra' })).toBeNull();
});
it('requires explicit reload after stale review', async () => {
  mocks.review.mockRejectedValue(new InvoiceAdjustmentError({ code: '40001' }));
  mocks.refetch.mockResolvedValue({ data: { ...invoice, adjustment_revision: 3, invoice_adjustments: [...invoice.invoice_adjustments!, revision(3)] }, error: null });
  render(<InvoiceAdjustmentHistory invoice={invoice} />);
  fireEvent.click(screen.getByRole('button', { name: 'Xác nhận kiểm tra' }));
  await screen.findByRole('alert');
  expect((screen.getByRole('button', { name: 'Xác nhận kiểm tra' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Tải lại lịch sử' }));
  await waitFor(() => expect(mocks.refetch).toHaveBeenCalledOnce());
});
it('renders one shared history on mobile', () => {
  const noop = () => {};
  render(<InvoiceDetailMobile invoice={invoice} relatedVouchers={[]} onBack={noop} showPay={false} payIsRefund={false} onRecordPayment={noop} showEdit={false} onEdit={noop} showCancel={false} onCancel={noop} showRestore={false} onRestore={noop} showQR={false} onShowQR={noop} />);
  expect(screen.getAllByText('Lịch sử điều chỉnh')).toHaveLength(1);
  expect(screen.getByText('Hóa đơn gốc')).toBeTruthy();
});
