// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { InvoiceWithRelations } from '@/types/invoice';
import IssuedInvoiceEditor from '../IssuedInvoiceEditor';
import { InvoiceAdjustmentError } from '@/lib/invoiceAdjustmentRpc';
const mocks = vi.hoisted(() => ({ save: vi.fn(), refetch: vi.fn(), defaults: vi.fn() }));
vi.mock('@/hooks/useInvoices', () => ({ useAdjustInvoice: () => ({ mutateAsync: mocks.save, isPending: false }), useInvoice: () => ({ refetch: mocks.refetch }) }));
vi.mock('@/hooks/useBuildingServices', () => ({ useBuildingServices: mocks.defaults }));
vi.mock('../PaymentsSummaryDialog', () => ({ default: ({ open }: { open: boolean }) => open ? <div>Hoàn tác khoản thu</div> : null }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn() } }));
const invoice = { id: 'dddd0000-0000-4000-8000-000000000101', status: 'APPROVED', paid_amount: 0, adjustment_revision: 2, updated_at: '2026-09-12T10:00:00Z', total_amount: 2000, discount_amount: 0, notes: 'Cũ', invoice_items: [{ id: 'dddd0000-0000-4000-8000-000000000111', service_id: null, type: 'OTHER', accounting_class: 'DEPOSIT', description: 'Cọc', unit_price: 2000, quantity: 2, coefficient: 0.5, amount: 2000, sort_order: 4, previous_reading: 0, current_reading: 0, from_date: '2026-09-01', to_date: '2026-09-12' }] } as InvoiceWithRelations;
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks(); mocks.save.mockResolvedValue({});
  vi.stubGlobal('PointerEvent', MouseEvent);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  HTMLElement.prototype.releasePointerCapture = vi.fn();
});
function fillReason() { fireEvent.change(screen.getByLabelText('Lý do điều chỉnh'), { target: { value: 'Bổ sung ghi chú' } }); }
it('submits current items and saved fields, never loading building defaults', async () => {
  render(<IssuedInvoiceEditor invoice={invoice} onOpenChange={() => {}} />);
  fireEvent.change(screen.getByLabelText('Ghi chú'), { target: { value: 'Mới' } }); fillReason();
  fireEvent.click(screen.getByRole('button', { name: 'Lưu điều chỉnh' }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
  expect(mocks.save.mock.calls[0]?.[0]).toMatchObject({ notes: 'Mới', expectedRevision: 2, expectedPaidAmount: 0, afterItems: [{ id: invoice.invoice_items![0]!.id, quantity: 2, coefficient: 0.5, previous_reading: 0, accounting_class: 'DEPOSIT' }] });
  expect(mocks.defaults).not.toHaveBeenCalled();
});
it('requires separate reason and prevents duplicate requests while pending', async () => {
  mocks.save.mockReturnValue(new Promise(() => {}));
  render(<IssuedInvoiceEditor invoice={invoice} onOpenChange={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Lưu điều chỉnh' }));
  await screen.findByText('Lý do cần ít nhất 3 ký tự'); expect(mocks.save).not.toHaveBeenCalled();
  fillReason(); fireEvent.submit(screen.getByRole('button', { name: 'Lưu điều chỉnh' }).closest('form')!);
  fireEvent.submit(screen.getByRole('button', { name: 'Lưu điều chỉnh' }).closest('form')!);
  await waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
});
it('saves discount and discount notes independently of the adjustment reason', async () => {
  render(<IssuedInvoiceEditor invoice={{ ...invoice, discount_amount: 100, discount_notes: 'Đã lưu' }} onOpenChange={() => {}} />);
  // Ghi chú giảm trừ sửa qua popover góc ô Giảm trừ; jsdom không mở được Popover trong Dialog nên
  // chỉ kiểm nút có sẵn và ghi chú đã lưu được giữ nguyên khi đổi số tiền.
  expect((screen.getByRole('button', { name: 'Ghi chú giảm trừ' }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.change(screen.getByLabelText('Giảm trừ'), { target: { value: '500' } }); fillReason();
  fireEvent.click(screen.getByRole('button', { name: 'Lưu điều chỉnh' }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
  expect(mocks.save.mock.calls[0]?.[0]).toMatchObject({ discountAmount: 500, discountNotes: 'Đã lưu', notes: 'Cũ', reason: 'Bổ sung ghi chú' });
});
it('keeps error visible and preserves retry key for unchanged request; changed notes use a new key', async () => {
  mocks.save.mockRejectedValue(new InvoiceAdjustmentError({}));
  const close = vi.fn(); render(<IssuedInvoiceEditor invoice={invoice} onOpenChange={close} />); fillReason();
  for (let count = 1; count <= 2; count++) {
    fireEvent.click(screen.getByRole('button', { name: 'Lưu điều chỉnh' }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(count));
    await screen.findByRole('alert');
  }
  expect(mocks.save.mock.calls[0]?.[0].idempotencyKey).toBe(mocks.save.mock.calls[1]?.[0].idempotencyKey);
  fireEvent.change(screen.getByLabelText('Ghi chú'), { target: { value: 'Khác' } });
  fireEvent.click(screen.getByRole('button', { name: 'Lưu điều chỉnh' }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(3));
  expect(mocks.save.mock.calls[2]?.[0].idempotencyKey).not.toBe(mocks.save.mock.calls[0]?.[0].idempotencyKey);
  expect(close).not.toHaveBeenCalled();
});
it.each(['40001', 'PT409'])('%s: refetch does not change edited snapshot; explicit conflict reload resets both document and token', async code => {
  mocks.save.mockRejectedValueOnce(new InvoiceAdjustmentError({ code }));
  const fresh = { ...invoice, adjustment_revision: 3, paid_amount: 1000, updated_at: '2026-09-12T11:00:00Z', notes: 'Mới từ server' };
  mocks.refetch.mockResolvedValue({ data: fresh, error: null });
  const view = render(<IssuedInvoiceEditor invoice={invoice} onOpenChange={() => {}} />);
  fillReason(); view.rerender(<IssuedInvoiceEditor invoice={fresh} onOpenChange={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Lưu điều chỉnh' }));
  await screen.findByRole('alert');
  expect((screen.getByRole('button', { name: 'Lưu điều chỉnh' }) as HTMLButtonElement).disabled).toBe(true);
  expect(mocks.save.mock.calls[0]?.[0]).toMatchObject({ expectedRevision: 2, expectedPaidAmount: 0, notes: 'Cũ' });
  fireEvent.click(screen.getByRole('button', { name: 'Tải lại hóa đơn' }));
  await waitFor(() => expect((screen.getByLabelText('Ghi chú') as HTMLTextAreaElement).value).toBe('Mới từ server'));
  fillReason(); fireEvent.click(screen.getByRole('button', { name: 'Lưu điều chỉnh' }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(2));
  expect(mocks.save.mock.calls[1]?.[0]).toMatchObject({ expectedRevision: 3, expectedPaidAmount: 1000, notes: 'Mới từ server' });
});
it('opens the canonical payment history in context after an allocation constraint', async () => {
  mocks.save.mockRejectedValue(new InvoiceAdjustmentError({ code: '55000', message: 'Tiền đã phân bổ; đảo giao dịch' }));
  render(<IssuedInvoiceEditor invoice={invoice} onOpenChange={() => {}} />); fillReason();
  fireEvent.click(screen.getByRole('button', { name: 'Lưu điều chỉnh' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Mở lịch sử thanh toán' }));
  expect(await screen.findByText('Hoàn tác khoản thu')).toBeTruthy();
});
