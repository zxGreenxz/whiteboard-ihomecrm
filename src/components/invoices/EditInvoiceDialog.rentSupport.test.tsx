// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import EditInvoiceDialog from './EditInvoiceDialog';
import type { InvoiceWithRelations } from '@/types/invoice';
const api = vi.hoisted(() => ({ update: vi.fn(), quote: vi.fn(), plan: vi.fn(), read: vi.fn(), sourceBlocked: false }));
vi.mock('@/hooks/useInvoices', () => ({ useUpdateInvoice: () => ({ mutate: api.update, isPending: false }), useExcessAmount: () => ({ data: 0 }), useInvoice: vi.fn() }));
vi.mock('@/hooks/useBuildingServices', () => ({ useBuildingServices: () => ({ data: [], isError: api.sourceBlocked }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org1' }) }));
vi.mock('@/lib/invoiceRentSupport', async original => ({ ...await original<typeof import('@/lib/invoiceRentSupport')>(), readInvoiceRentSupportPlan: api.plan, quoteInvoiceRentSupport: api.quote, readSavedInvoiceSupportRequest: api.read }));
vi.mock('./invoice-entry/InvoiceEntryShell', () => ({ InvoiceEntryShell: ({ ctl, onSubmit, submit, validationError, onResetAll }: any) => <form onSubmit={onSubmit}><input aria-label="Tháng" value={ctl.v.billing_month} onChange={e => ctl.set.billingMonth(e.target.value)} /><input aria-label="Giảm trừ" value={ctl.v.discount_amount} onChange={e => ctl.set.discount(Number(e.target.value))} /><input aria-label="Giá thuê" value={ctl.v.rent_price} onChange={e => ctl.set.rent(Number(e.target.value))} /><div>{validationError}</div><button type="button" onClick={onResetAll}>Reset</button><button type="submit" disabled={submit.disabled}>Lưu</button></form> }));
afterEach(cleanup);
beforeEach(() => {
  api.sourceBlocked = false; api.update.mockReset(); api.read.mockReset().mockResolvedValue(null);
  api.plan.mockResolvedValue({ revision: 2, schedule: { version: 2, start_billing_month: '2026-09', segments: [{ month_count: 3, monthly_amount: '300000' }, { month_count: 9, monthly_amount: '100000' }] } });
  api.quote.mockImplementation(async (_org, _contract, month) => ({ state: 'READY', plan_revision: 2, billing_month: month, invoice_support: month === '2026-12' ? '100000' : '300000', quote_hash: 'quote' }));
});
const invoice = () => ({ id: 'invoice1', contract_id: 'contract1', organization_id: 'org1', building_id: 'b1', room_id: null, status: 'DRAFT', paid_amount: 0,
  billing_month: '2026-11', issue_date: '2026-11-01', due_date: '2026-11-05', kind: 'MONTHLY', discount_amount: 370000,
  invoice_support_amount: 300000, manual_discount_amount: 20000, credit_discount_amount: 50000, rent_support_plan_revision: 2,
  invoice_items: [{ id: 'rent1', type: 'RENT', accounting_class: 'REVENUE', description: 'Tiền thuê', unit_price: 1000000, quantity: 1, coefficient: 1, amount: 1000000 }] } as unknown as InvoiceWithRelations);
function open() { render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><EditInvoiceDialog open onOpenChange={() => {}} invoice={invoice()} /></QueryClientProvider>); }
it('hydrates the three saved discount parts and changes month without absorbing prior support', async () => {
  open();
  fireEvent.change(screen.getByLabelText('Tháng'), { target: { value: '2026-12' } });
  await waitFor(() => expect((screen.getByLabelText('Giảm trừ') as HTMLInputElement).value).toBe('170000'));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Lưu' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Lưu' }));
  await waitFor(() => expect(api.update).toHaveBeenCalled());
  expect(api.update.mock.calls[0][0]).toMatchObject({ id: 'invoice1', formData: { discount_amount: 170000, applied_credit: 50000, rent_support_context: { manual_discount_amount: '20000', expected_plan_revision: 2 } } });
});
it('quotes changed revenue and blocks update when support needs review', async () => {
  open();
  await waitFor(() => expect((screen.getByRole('button', { name: 'Lưu' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText('Giá thuê'), { target: { value: '100000' } });
  await waitFor(() => expect(screen.getByText(/Hỗ trợ vượt doanh thu/)).toBeTruthy());
  expect((screen.getByRole('button', { name: 'Lưu' }) as HTMLButtonElement).disabled).toBe(true);
});
it('resets automatic support together with the saved form without turning it into manual discount', async () => {
  open();
  fireEvent.change(screen.getByLabelText('Tháng'), { target: { value: '2026-12' } });
  await waitFor(() => expect((screen.getByLabelText('Giảm trừ') as HTMLInputElement).value).toBe('170000'));
  fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
  await waitFor(() => expect((screen.getByLabelText('Giảm trừ') as HTMLInputElement).value).toBe('370000'));
});
it('keeps settlement support at zero rather than consuming the monthly entitlement', async () => {
  api.quote.mockImplementation(async (_org, _contract, month, _items, _credit, _context, kind) => ({ state: 'READY', plan_revision: 2, billing_month: month, invoice_support: kind === 'SETTLEMENT' ? '0' : '300000', quote_hash: 'quote' }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><EditInvoiceDialog open onOpenChange={() => {}} invoice={{ ...invoice(), kind: 'SETTLEMENT', discount_amount: 70000, invoice_support_amount: 0 }} /></QueryClientProvider>);
  await waitFor(() => expect((screen.getByRole('button', { name: 'Lưu' }) as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByLabelText('Giảm trừ') as HTMLInputElement).value).toBe('70000');
  fireEvent.click(screen.getByRole('button', { name: 'Lưu' }));
  await waitFor(() => expect(api.update).toHaveBeenCalled());
  expect(api.update.mock.calls[0][0].formData.rent_support_context.manual_discount_amount).toBe('20000');
});
it.each(['reconcile', 'source'])('keeps only the old readback when %s blocks a changed ready edit form', async block => {
  api.update.mockImplementation((_input, callbacks) => callbacks.onError(block === 'reconcile' ? new TypeError('Failed to fetch') : new Error('definitive rejection')));
  open();
  await waitFor(() => expect((screen.getByRole('button', { name: 'Lưu' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Lưu' }));
  await waitFor(() => expect(api.update).toHaveBeenCalledTimes(1));
  const request = api.update.mock.calls[0][0].formData.rent_support_context.request_id;
  api.sourceBlocked = block === 'source';
  fireEvent.change(screen.getByLabelText('Tháng'), { target: { value: '2026-12' } });
  await waitFor(() => expect((screen.getByLabelText('Giảm trừ') as HTMLInputElement).value).toBe('170000'));
  fireEvent.click(screen.getByRole('button', { name: 'Lưu' }));
  await waitFor(() => expect(api.read).toHaveBeenCalledTimes(1));
  expect(api.update).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Lưu' }));
  await waitFor(() => expect(api.read).toHaveBeenCalledTimes(2));
  expect(api.read.mock.calls).toEqual([['org1', 'contract1', request, 'invoice1'], ['org1', 'contract1', request, 'invoice1']]);
  api.read.mockResolvedValue({ id: 'invoice1', invoice_number: 'INV-NOVEMBER', billing_month: '2026-11' });
  fireEvent.click(screen.getByRole('button', { name: 'Lưu' }));
  await waitFor(() => expect(api.read).toHaveBeenCalledTimes(3));
  expect(api.read).toHaveBeenLastCalledWith('org1', 'contract1', request, 'invoice1');
  expect(api.update).toHaveBeenCalledTimes(1);
});
