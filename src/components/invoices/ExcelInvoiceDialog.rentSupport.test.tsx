// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ExcelInvoiceDialog from './ExcelInvoiceDialog';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
vi.mock('@/lib/invoiceRentSupport', async original => ({ ...await original<typeof import('@/lib/invoiceRentSupport')>(), quoteInvoiceRentSupport: api.quote, readSavedInvoiceSupportRequest: api.read }));
const api = vi.hoisted(() => ({ load: vi.fn(), create: vi.fn(), read: vi.fn(), quote: vi.fn(), toast: vi.fn() }));
vi.mock('@/hooks/invoices/useExcelInvoiceData', async original => ({ ...await original<typeof import('@/hooks/invoices/useExcelInvoiceData')>(), fetchExcelInvoiceSource: api.load }));
vi.mock('@/hooks/useInvoices', () => ({ useCreateInvoice: () => ({ mutateAsync: api.create, isPending: false }) }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org1' }) }));
vi.mock('@/hooks/useBuildings', () => ({ useBuildings: () => ({ data: [{ id: 'b1', name: 'Building' }] }) }));
// Loaded empty services are valid; undefined now correctly means source unavailable.
vi.mock('@/hooks/useBuildingServices', () => ({ useBuildingServices: () => ({ data: [] }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: api.toast }) }));
vi.mock('@/components/ui/select', async original => { const actual = await original<typeof import('@/components/ui/select')>(); return { ...actual, SelectContent: (props: React.ComponentProps<typeof actual.SelectContent>) => <actual.SelectContent {...props} position="item-aligned" /> }; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
beforeEach(() => {
  api.create.mockReset(); api.toast.mockClear(); api.read.mockReset(); api.quote.mockReset();
  api.create.mockResolvedValue({ id: 'created' }); api.read.mockResolvedValue(null); api.quote.mockResolvedValue({ state: 'READY' });
  vi.stubGlobal('PointerEvent', MouseEvent); HTMLElement.prototype.scrollIntoView = vi.fn(); HTMLElement.prototype.hasPointerCapture = vi.fn(() => false); HTMLElement.prototype.releasePointerCapture = vi.fn();
  api.load.mockResolvedValue({ dupRoomNames: [], contracts: [{ id: 'c1', room_id: 'r1', organization_id: 'org1', room: { name: 'Room' }, rent_price: 1000000, rent_support: { revision: 2, schedule: { version: 2, start_billing_month: '2026-09', segments: [{ month_count: 3, monthly_amount: '300000' }, { month_count: 9, monthly_amount: '100000' }] } } }], meterByRoom: new Map(), lastReading: new Map(), creditByContract: new Map([['c1', 50000]]), invoiceCountByContract: new Map(), previousDebtByContract: new Map() });
});
it('recalculates support after loading while preserving manual discount, credit and row edits', async () => {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ExcelInvoiceDialog open onOpenChange={() => {}} /></QueryClientProvider>);
  fireEvent.keyDown(screen.getAllByRole('combobox')[0], { key: 'ArrowDown' }); fireEvent.keyDown(screen.getByRole('option', { name: 'Building' }), { key: 'Enter' });
  fireEvent.change(document.querySelector('input[type="month"]')!, { target: { value: '2026-11' } });
  fireEvent.click(screen.getByRole('button', { name: 'Tải dữ liệu' }));
  await screen.findByText('Room');
  const discount = document.querySelector('input[value="350.000"]')!;
  expect(discount).toBeTruthy();
  fireEvent.change(discount, { target: { value: '370000' } });
  fireEvent.change(document.querySelector('input[type="month"]')!, { target: { value: '2026-12' } });
  await waitFor(() => expect(document.querySelector('input[value="170.000"]')).toBeTruthy());
  expect(screen.getByText('Room')).toBeTruthy();
});
async function loadNovember(onOpenChange = vi.fn()) {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ExcelInvoiceDialog open onOpenChange={onOpenChange} /></QueryClientProvider>);
  fireEvent.keyDown(screen.getAllByRole('combobox')[0], { key: 'ArrowDown' }); fireEvent.keyDown(screen.getByRole('option', { name: 'Building' }), { key: 'Enter' });
  fireEvent.change(document.querySelector('input[type="month"]')!, { target: { value: '2026-11' } });
  fireEvent.click(screen.getByRole('button', { name: 'Tải dữ liệu' }));
  await screen.findByText('Room');
  await waitFor(() => expect((screen.getByRole('button', { name: /Tạo \d+ hoá đơn/ }) as HTMLButtonElement).disabled).toBe(false));
}
it('preserves row edits and blocks quotes and writes while the month is cleared, then recovers on input', async () => {
  await loadNovember();
  fireEvent.change(document.querySelector('input[value="350.000"]')!, { target: { value: '370000' } });
  await waitFor(() => expect((screen.getByRole('button', { name: /Tạo \d+ hoá đơn/ }) as HTMLButtonElement).disabled).toBe(false));
  const priorQuotes = api.quote.mock.calls.length;
  fireEvent.change(document.querySelector('input[type="month"]')!, { target: { value: '' } });
  expect(screen.getByText('Room')).toBeTruthy();
  expect(document.querySelector('input[value="370.000"]')).toBeTruthy();
  expect(screen.getByText(/Kỳ thanh toán không hợp lệ/)).toBeTruthy();
  const submit = screen.getByRole('button', { name: /Tạo \d+ hoá đơn/ }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  fireEvent.click(submit);
  expect(api.create).not.toHaveBeenCalled();
  expect(api.quote.mock.calls.length).toBe(priorQuotes);
  fireEvent.change(document.querySelector('input[type="month"]')!, { target: { value: '2026-12' } });
  await waitFor(() => expect(document.querySelector('input[value="170.000"]')).toBeTruthy());
  await waitFor(() => expect(submit.disabled).toBe(false));
});
it.each(['changed month', 'changed content in same month'])('keeps the final old invoice/month recovery visible after an unknown write and %s retry', async change => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const onOpenChange = vi.fn();
  api.create.mockRejectedValueOnce(new Error('lost response'));
  await loadNovember(onOpenChange);
  fireEvent.click(screen.getByRole('button', { name: /Tạo \d+ hoá đơn/ }));
  await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(api.toast).toHaveBeenCalled());
  const request = api.create.mock.calls[0][0].rent_support_context.request_id;
  api.read.mockResolvedValue({ id: 'saved11', invoice_number: 'INV-NOVEMBER', billing_month: '2026-11' });
  if (change === 'changed month') fireEvent.change(document.querySelector('input[type="month"]')!, { target: { value: '2026-12' } });
  else fireEvent.change(document.querySelector('input[value="350.000"]')!, { target: { value: '370000' } });
  await waitFor(() => expect((screen.getByRole('button', { name: /Tạo \d+ hoá đơn/ }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: /Tạo \d+ hoá đơn/ }));
  await waitFor(() => expect(api.read).toHaveBeenCalledWith('org1', 'c1', request));
  await waitFor(() => expect(api.toast.mock.lastCall?.[0].description).toContain('INV-NOVEMBER — kỳ 2026-11'));
  expect(api.toast.mock.lastCall?.[0].description).toContain(`Kỳ ${change === 'changed month' ? '2026-12' : '2026-11'}: 0`);
  expect(api.toast.mock.lastCall?.[0].description).toContain('Nội dung đang nhập chưa được lưu cho dòng này');
  expect(screen.getByText(/INV-NOVEMBER — kỳ 2026-11/)).toBeTruthy();
  expect(screen.getByText(change === 'changed month' ? /Kỳ 2026-12 chưa được tạo cho dòng này/ : /Nội dung đang nhập chưa được lưu cho dòng này/)).toBeTruthy();
  expect(onOpenChange).not.toHaveBeenCalled();
  expect(api.create).toHaveBeenCalledTimes(1);
  errors.mockRestore();
});
