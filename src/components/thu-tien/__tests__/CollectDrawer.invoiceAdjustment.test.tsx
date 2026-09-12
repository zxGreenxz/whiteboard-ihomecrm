// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CollectDrawer } from '../CollectDrawer';
import type { InvoiceWithRelations } from '@/types/invoice';
const mocks = vi.hoisted(() => ({ note: vi.fn(), invoice: vi.fn(), canEdit: true }));
vi.mock('@/hooks/useQuickCollect', () => ({ useQuickCollect: () => ({ collect: vi.fn(), accountIdFor: () => 'account', accountOptionsFor: () => [], changeAccountNameFor: () => 'Sổ thối', isCollecting: false }) }));
vi.mock('@/hooks/useDeletePayment', () => ({ useDeletePayment: () => ({ mutate: vi.fn() }), useCollectionReversalEligibility: () => ({ data: {} }), COLLECTION_BLOCK_TEXT: {} }));
vi.mock('@/hooks/useCollectionReport', () => ({ useInvoiceItemsLite: () => ({ data: [], isLoading: false, isError: false }) }));
vi.mock('@/hooks/useUpdateInvoiceNote', () => ({ useUpdateInvoiceNote: () => ({ mutate: mocks.note }) }));
vi.mock('@/hooks/useInvoices', () => ({ useInvoice: mocks.invoice }));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: {} }) }));
vi.mock('@/lib/permissionPages', () => ({ canUse: () => mocks.canEdit }));
vi.mock('@/lib/receiptUpload', () => ({ uploadReceiptToStorage: vi.fn() }));
vi.mock('@/lib/paymentRecordRpc', () => ({ deriveInvoiceDepositDue: () => 0 }));
vi.mock('../InvoiceDetailCard', () => ({ InvoiceDetailCard: () => null }));
vi.mock('../CollectPayForm', () => ({ CollectPayForm: () => null }));
vi.mock('../CollectKeypad', () => ({ CollectKeypad: () => null }));
vi.mock('@/components/invoices/EditInvoiceDialog', () => ({ default: ({ invoice }: { invoice: InvoiceWithRelations }) => <div>Editor snapshot {invoice.updated_at}</div> }));
const fixture = { id: 'inv', status: 'APPROVED', paid_amount: 0, total_amount: 2000, notes: 'Ghi chú hóa đơn cũ', invoice_items: [], updated_at: 'full-snapshot' } as InvoiceWithRelations;
const props = { invoice: fixture, show: true, mode: 'view' as const, canRecordPayment: true, prev: null, next: null, onClose: () => {}, onNavigate: () => {} };
afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); mocks.canEdit = true; mocks.invoice.mockImplementation((id?: string) => ({ data: id ? fixture : undefined, isLoading: false, isError: false })); });
it('issued collection notes do not directly update the invoice; the invoice editor loads a full snapshot', () => {
  render(<CollectDrawer {...props} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Ghi chú khoản thu' } }); fireEvent.blur(screen.getByRole('textbox'));
  expect(mocks.note).not.toHaveBeenCalled();
  expect(screen.getByText('Ghi chú này được lưu cùng khoản thu khi bấm Thu.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Điều chỉnh ghi chú hóa đơn' }));
  expect(screen.getByText('Editor snapshot full-snapshot')).toBeTruthy();
});
it('keeps ordinary DRAFT quick-note saving', () => {
  render(<CollectDrawer {...props} invoice={{ ...fixture, status: 'DRAFT' }} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Ghi chú nháp' } }); fireEvent.blur(screen.getByRole('textbox'));
  expect(mocks.note).toHaveBeenCalledWith({ invoice_id: 'inv', notes: 'Ghi chú nháp' }, expect.objectContaining({ onError: expect.any(Function) }));
});
it('does not offer invoice adjustments without invoice edit capability', () => {
  mocks.canEdit = false; render(<CollectDrawer {...props} />);
  expect(screen.queryByRole('button', { name: 'Điều chỉnh ghi chú hóa đơn' })).toBeNull();
});
