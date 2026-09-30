// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import ExcelInvoiceDialog from '../ExcelInvoiceDialog';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
const source = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('@/hooks/invoices/useExcelInvoiceData', () => ({ fetchExcelInvoiceSource: source.load, fetchPreviousDebtForContract: vi.fn(), useSubmitExcelInvoices: () => vi.fn() }));
vi.mock('@/hooks/useBuildings', () => ({ useBuildings: () => ({ data: [{ id: 'b1', name: 'Building' }] }) }));
vi.mock('@/hooks/useBuildingServices', () => ({ useBuildingServices: () => ({ data: undefined }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/ui/select', async (importOriginal) => {
 const actual = await importOriginal<typeof import('@/components/ui/select')>();
 return { ...actual, SelectContent: (props: React.ComponentProps<typeof actual.SelectContent>) => <actual.SelectContent {...props} position='item-aligned' /> };
});
afterEach(cleanup);
it('discards an in-flight Excel load when the user changes billing month', async () => {
  vi.stubGlobal('PointerEvent', MouseEvent);
  HTMLElement.prototype.scrollIntoView = vi.fn(); HTMLElement.prototype.hasPointerCapture = vi.fn(() => false); HTMLElement.prototype.releasePointerCapture = vi.fn();
  let resolve!: (data: unknown) => void;
  source.load.mockReturnValue(new Promise(done => { resolve = done; }));
  render(<QueryClientProvider client={new QueryClient()}><ExcelInvoiceDialog open onOpenChange={() => {}} /></QueryClientProvider>);
  fireEvent.keyDown(screen.getAllByRole('combobox')[0], { key: 'ArrowDown' });
  fireEvent.keyDown(screen.getByRole('option', { name: 'Building' }), { key: 'Enter' });
  fireEvent.click(screen.getByRole('button', { name: 'Tải dữ liệu' }));
  await waitFor(() => expect(source.load).toHaveBeenCalledWith('b1'));
  fireEvent.change(document.querySelector('input[type="month"]')!, { target: { value: '2026-12' } });
  await act(async () => resolve({ dupRoomNames: [], contracts: [{ id: 'c1', room_id: 'r1', room: { name: 'OLD-MONTH-ROOM' }, rent_price: 1000000, rent_support: { revision: 1, schedule: { version: 2, start_billing_month: '2026-09', segments: [{ month_count: 12, monthly_amount: '300000' }] } } }],
    meterByRoom: new Map(), lastReading: new Map(), creditByContract: new Map(), invoiceCountByContract: new Map(), previousDebtByContract: new Map() }));
  expect(screen.queryByText('OLD-MONTH-ROOM')).toBeNull();
});
