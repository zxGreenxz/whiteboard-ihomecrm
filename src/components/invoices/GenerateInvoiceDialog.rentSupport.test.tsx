// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import GenerateInvoiceDialog from './GenerateInvoiceDialog';
vi.mock('@/components/ui/select', async original => {
  const actual = await original<typeof import('@/components/ui/select')>();
  return { ...actual, SelectContent: (props: React.ComponentProps<typeof actual.SelectContent>) => <actual.SelectContent {...props} position="item-aligned" /> };
});

const api = vi.hoisted(() => ({ create: vi.fn(), plan: vi.fn(), quote: vi.fn(), read: vi.fn() }));
vi.mock('@/hooks/useInvoices', () => ({ useCreateInvoice: () => ({ mutate: api.create, isPending: false }), useExcessAmount: () => ({ data: 50000 }) }));
vi.mock('@/lib/invoiceRentSupport', async original => ({ ...await original<typeof import('@/lib/invoiceRentSupport')>(), readInvoiceRentSupportPlan: api.plan, quoteInvoiceRentSupport: api.quote, readSavedInvoiceSupportRequest: api.read }));
vi.mock('@/hooks/useContracts', () => ({ useContracts: () => ({ data: [{ id: 'c1', status: 'ACTIVE', discounts: { version: 2 }, rent_price: 1000000, room: { id: 'r1', name: 'Room', building_id: 'b1' } }] }) }));
vi.mock('@/hooks/useBuildings', () => ({ useBuildings: () => ({ data: [] }) }));
vi.mock('@/hooks/useRooms', () => ({ useRooms: () => ({ data: [] }) }));
vi.mock('@/hooks/useVehicles', () => ({ useVehicles: () => ({ data: { data: [] } }) }));
vi.mock('@/hooks/useBuildingServices', () => ({ useBuildingServices: () => ({ data: [] }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org1' }) }));
vi.mock('@/lib/invoiceHelpers', () => ({ computePreviousDebt: async () => ({ total: 0, sources: [] }), getContractDiscountSlot: async (_: string, { billingMonth }: { billingMonth: string }) => ({ supportRevision: 2, billingMonth, amountPerMonth: billingMonth === '2026-12' ? 100000 : 300000, applicable: true, label: 'Hỗ trợ' }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ is: () => ({ neq: () => ({ eq: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) }) }) }) }) }) } }));
vi.mock('./invoice-entry/InvoiceEntryShell', () => ({ InvoiceEntryShell: ({ ctl, onSubmit, submit, validationError, selectors }: any) => <form onSubmit={onSubmit}>{selectors('desktop').contract}<input aria-label="Tháng" value={ctl.v.billing_month} onChange={e => ctl.set.billingMonth(e.target.value)} /><input aria-label="Giảm trừ" value={ctl.v.discount_amount} onChange={e => ctl.set.discount(Number(e.target.value))} /><input aria-label="Giá thuê" value={ctl.v.rent_price} onChange={e => ctl.set.rent(Number(e.target.value))} /><div>{validationError}</div><button type="submit" disabled={submit.disabled}>Tạo</button></form> }));
afterEach(cleanup);
beforeEach(() => {
  vi.stubGlobal('PointerEvent', MouseEvent);
  HTMLElement.prototype.scrollIntoView = vi.fn(); HTMLElement.prototype.hasPointerCapture = vi.fn(() => false); HTMLElement.prototype.releasePointerCapture = vi.fn();
  api.create.mockReset(); api.read.mockResolvedValue(null);
  api.plan.mockResolvedValue({ revision: 2, schedule: { version: 2, start_billing_month: '2026-09', segments: [{ month_count: 3, monthly_amount: '300000' }, { month_count: 9, monthly_amount: '100000' }] } });
  api.quote.mockImplementation(async (_org, _contract, month) => ({ state: 'READY', plan_revision: 2, billing_month: month, invoice_support: month === '2026-12' ? '100000' : '300000', quote_hash: 'quote' }));
});
function open() {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={query}><GenerateInvoiceDialog open onOpenChange={() => {}} /></QueryClientProvider>);
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
  fireEvent.keyDown(screen.getByRole('option', { name: 'c1 - Room' }), { key: 'Enter' });
}
it('preserves manual discount and credit when November changes to December', async () => {
  open();
  // Only one available contract is auto-selected by the existing dialog.
  fireEvent.change(screen.getByLabelText('Tháng'), { target: { value: '2026-11' } });
  await waitFor(() => expect((screen.getByLabelText('Giảm trừ') as HTMLInputElement).value).toBe('350000'));
  fireEvent.change(screen.getByLabelText('Giảm trừ'), { target: { value: '370000' } });
  fireEvent.change(screen.getByLabelText('Tháng'), { target: { value: '2026-12' } });
  await waitFor(() => expect((screen.getByLabelText('Giảm trừ') as HTMLInputElement).value).toBe('170000'));
  fireEvent.click(screen.getByRole('button', { name: 'Tạo' }));
  await waitFor(() => expect(api.create).toHaveBeenCalled());
  expect(api.create.mock.calls[0][0]).toMatchObject({ discount_amount: 170000, applied_credit: 50000, rent_support_context: { version: 1, manual_discount_amount: '20000', expected_plan_revision: 2 } });
});
it('retains the request UUID across an unchanged failed attempt and reads its saved result', async () => {
  open();
  await waitFor(() => expect((screen.getByLabelText('Giảm trừ') as HTMLInputElement).value).toBe('350000'));
  fireEvent.click(screen.getByRole('button', { name: 'Tạo' }));
  await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Tạo' }));
  await waitFor(() => expect(api.create).toHaveBeenCalledTimes(2));
  expect(api.create.mock.calls[0][0].rent_support_context.request_id).toBe(api.create.mock.calls[1][0].rent_support_context.request_id);
  expect(api.read).toHaveBeenCalled();
});
it('blocks writes and shows a check error when the support quote fails', async () => {
  api.quote.mockRejectedValue(new Error('transport error'));
  open();
  await waitFor(() => expect(screen.getByText(/Không kiểm tra được hỗ trợ/)).toBeTruthy());
  expect((screen.getByRole('button', { name: 'Tạo' }) as HTMLButtonElement).disabled).toBe(true);
  expect(api.create).not.toHaveBeenCalled();
});
it('reports a saved old request after the form changes instead of writing a second invoice', async () => {
  open();
  await waitFor(() => expect((screen.getByRole('button', { name: 'Tạo' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Tạo' }));
  await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1));
  const request = api.create.mock.calls[0][0].rent_support_context.request_id;
  api.read.mockResolvedValue({ id: 'saved1', invoice_number: 'INV-SAVED', billing_month: '2026-09' });
  fireEvent.change(screen.getByLabelText('Tháng'), { target: { value: '2026-12' } });
  await waitFor(() => expect((screen.getByLabelText('Giảm trừ') as HTMLInputElement).value).toBe('150000'));
  fireEvent.click(screen.getByRole('button', { name: 'Tạo' }));
  await waitFor(() => expect(api.read).toHaveBeenCalledWith('org1', 'c1', request, undefined));
  expect(api.create).toHaveBeenCalledTimes(1);
});
it('does not replace the pending request when its exact readback fails', async () => {
  open();
  await waitFor(() => expect((screen.getByRole('button', { name: 'Tạo' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Tạo' }));
  await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1));
  api.read.mockRejectedValue(new Error('cannot verify'));
  fireEvent.change(screen.getByLabelText('Tháng'), { target: { value: '2026-12' } });
  await waitFor(() => expect((screen.getByLabelText('Giảm trừ') as HTMLInputElement).value).toBe('150000'));
  fireEvent.click(screen.getByRole('button', { name: 'Tạo' }));
  await waitFor(() => expect(api.read).toHaveBeenCalled());
  expect(api.create).toHaveBeenCalledTimes(1);
});
