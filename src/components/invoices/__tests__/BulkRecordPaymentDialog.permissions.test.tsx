// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import BulkRecordPaymentDialog from '../BulkRecordPaymentDialog';
const mocks = vi.hoisted(() => ({ permissions: undefined as Record<string, Record<string, boolean>> | undefined }));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: mocks.permissions }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/hooks/useBuildings', () => ({ useBuildings: () => ({ data: [{ id: 'building', name: 'DEMO' }] }) }));
vi.mock('@/hooks/useAccounts', () => ({ useAccounts: () => ({ data: [] }) }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: { id: 'collector' } }) }));
vi.mock('@/hooks/useBulkRecordPayment', () => ({ useBulkRecordPayment: () => ({ mutateAsync: vi.fn() }) }));
vi.mock('@/hooks/useClipboardImagePaste', () => ({ useClipboardImagePaste: () => ({}) }));
vi.mock('@/hooks/useInvoices', () => ({ useInvoice: () => ({ data: undefined }) }));
vi.mock('../EditInvoiceDialog', () => ({ default: () => null }));
vi.mock('../PaymentsSummaryDialog', () => ({ default: () => null }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: () => {
  const rows = [{ id: 'invoice', invoice_number: 'DEMO-001', room_id: 'room', room: { name: 'DEMO-ROOM' }, status: 'APPROVED', total_amount: 1000000, paid_amount: 0, remaining_amount: 1000000 }];
  const builder = { select: () => builder, eq: () => builder, in: () => builder, gt: () => builder, is: async () => ({ data: rows, error: null }) };
  return builder;
} } }));
vi.mock('@/components/ui/select', async importOriginal => {
  const actual = await importOriginal<typeof import('@/components/ui/select')>();
  return { ...actual, SelectContent: (props: React.ComponentProps<typeof actual.SelectContent>) => <actual.SelectContent {...props} position="item-aligned" /> };
});
afterEach(cleanup);
beforeEach(() => {
  mocks.permissions = { invoices: { record_payment: true, edit: false } };
  vi.stubGlobal('PointerEvent', MouseEvent);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  HTMLElement.prototype.releasePointerCapture = vi.fn();
});
async function loadRows() {
  render(<BulkRecordPaymentDialog open onOpenChange={() => {}} />);
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
  fireEvent.keyDown(screen.getByRole('option', { name: 'DEMO' }), { key: 'Enter' });
  fireEvent.click(screen.getByRole('button', { name: 'Tải dữ liệu' }));
  await screen.findByText('DEMO-ROOM');
}
it('hides the invoice edit action for a collect-only actor even on an editable invoice', async () => {
  await loadRows();
  expect(screen.queryByRole('button', { name: 'Sửa hoá đơn' })).toBeNull();
});
it('shows the action when the actor also has invoices.edit', async () => {
  mocks.permissions = { invoices: { record_payment: true, edit: true } };
  await loadRows();
  expect(screen.getByRole('button', { name: 'Sửa hoá đơn' })).toBeTruthy();
});
it('keeps invoice edit hidden while permissions are still loading', async () => {
  mocks.permissions = undefined;
  await loadRows();
  expect(screen.queryByRole('button', { name: 'Sửa hoá đơn' })).toBeNull();
});
