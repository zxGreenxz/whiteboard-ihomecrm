// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ExcelInvoiceDialog from './ExcelInvoiceDialog';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
vi.mock('@/lib/invoiceRentSupport', async original => ({ ...await original<typeof import('@/lib/invoiceRentSupport')>(), quoteInvoiceRentSupport: async () => ({ state: 'READY' }) }));
const api = vi.hoisted(() => ({ load: vi.fn(), submit: vi.fn() }));
vi.mock('@/hooks/invoices/useExcelInvoiceData', () => ({ fetchExcelInvoiceSource: api.load, fetchPreviousDebtForContract: vi.fn(), useSubmitExcelInvoices: () => ({ submit: api.submit }) }));
vi.mock('@/hooks/useBuildings', () => ({ useBuildings: () => ({ data: [{ id: 'b1', name: 'Building' }] }) }));
vi.mock('@/hooks/useBuildingServices', () => ({ useBuildingServices: () => ({ data: undefined }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/ui/select', async original => { const actual = await original<typeof import('@/components/ui/select')>(); return { ...actual, SelectContent: (props: React.ComponentProps<typeof actual.SelectContent>) => <actual.SelectContent {...props} position="item-aligned" /> }; });
afterEach(cleanup);
beforeEach(() => {
  vi.stubGlobal('PointerEvent', MouseEvent); HTMLElement.prototype.scrollIntoView = vi.fn(); HTMLElement.prototype.hasPointerCapture = vi.fn(() => false); HTMLElement.prototype.releasePointerCapture = vi.fn();
  api.load.mockResolvedValue({ dupRoomNames: [], contracts: [{ id: 'c1', room_id: 'r1', organization_id: 'org1', room: { name: 'Room' }, rent_price: 1000000, rent_support: { revision: 2, schedule: { version: 2, start_billing_month: '2026-09', segments: [{ month_count: 3, monthly_amount: '300000' }, { month_count: 9, monthly_amount: '100000' }] } } }], meterByRoom: new Map(), lastReading: new Map(), creditByContract: new Map([['c1', 50000]]), invoiceCountByContract: new Map(), previousDebtByContract: new Map() });
  api.submit.mockResolvedValue({ ok: 1, fail: 0, readingFails: [] });
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
