// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ComponentProps } from 'react';
import type { InvoiceEntryShell } from './invoice-entry/InvoiceEntryShell';
import GenerateInvoiceDialog from './GenerateInvoiceDialog';

const api = vi.hoisted(() => ({ create: vi.fn(), plan: vi.fn(), quote: vi.fn(), read: vi.fn(),
  discounts: { version: 2 } as { version: number } | null, urls: [] as URL[] }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor' }) }));
vi.mock('@/hooks/useInvoices', () => ({ useCreateInvoice: () => ({ mutateAsync: api.create, isPending: false }), useExcessAmount: () => ({ data: 0 }) }));
vi.mock('@/lib/invoiceRentSupport', async original => ({ ...await original<typeof import('@/lib/invoiceRentSupport')>(), readInvoiceRentSupportPlan: api.plan, quoteInvoiceRentSupport: api.quote, readSavedInvoiceSupportRequest: api.read }));
vi.mock('@/hooks/useBuildings', () => ({ useBuildings: () => ({ data: [] }) }));
vi.mock('@/hooks/useRooms', () => ({ useRooms: () => ({ data: [] }) }));
vi.mock('@/hooks/useVehicles', () => ({ useVehicles: () => ({ data: { data: [] } }) }));
vi.mock('@/hooks/useBuildingServices', () => ({ useBuildingServices: () => ({ data: [] }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org1' }) }));
vi.mock('@/lib/invoiceHelpers', () => ({ computePreviousDebt: async () => ({ total: 0, sources: [] }),
  getContractDiscountSlot: async () => ({ applicable: false, amountPerMonth: 0, supportRevision: null }) }));
vi.mock('@/components/ui/select', async original => {
  const actual = await original<typeof import('@/components/ui/select')>();
  return { ...actual, SelectContent: (props: ComponentProps<typeof actual.SelectContent>) => <actual.SelectContent {...props} position="item-aligned" /> };
});
vi.mock('./invoice-entry/InvoiceEntryShell', () => ({ InvoiceEntryShell: ({ ctl, onSubmit, submit, validationError, selectors }: ComponentProps<typeof InvoiceEntryShell>) =>
  <form onSubmit={onSubmit}>{selectors?.('desktop').contract}
    <input aria-label="Tháng" value={ctl.v.billing_month} onChange={event => ctl.set.billingMonth(event.target.value)} />
    <output data-testid="discount">{ctl.v.discount_amount}</output><div>{validationError}</div>
    <button type="submit" disabled={submit.disabled}>Tạo</button>
  </form> }));
// Real useContracts + pagination + Supabase/PostgREST query builder. This read-only
// transport behaves like a projected response: omitted fields never reach the UI.
vi.mock('@/integrations/supabase/client', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  const columns = (select: string) => {
    let depth = 0, start = 0;
    const parts: string[] = [];
    for (let i = 0; i <= select.length; i++) {
      if (select[i] === '(') depth++;
      if (select[i] === ')') depth--;
      if (i === select.length || (select[i] === ',' && depth === 0)) { parts.push(select.slice(start, i)); start = i + 1; }
    }
    return parts.map(part => part.trim().split(/[!: (]/)[0]);
  };
  return { supabase: createClient('https://contract-projection.example.invalid', 'synthetic-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(init?.method ?? 'GET').toBe('GET');
      if (url.pathname === '/rest/v1/contracts') {
        api.urls.push(url);
        const row: Record<string, unknown> = { id: 'c1', status: 'ACTIVE', room_id: null, rent_price: 1000000,
          contract_number: 'C1', discounts: api.discounts,
          room: { id: 'r1', name: 'Room', building_id: 'b1' }, contract_customers: [], contract_services: [] };
        const selected = columns(url.searchParams.get('select') ?? '');
        const projected = Object.fromEntries(selected.filter(key => key in row).map(key => [key, row[key]]));
        return new Response(JSON.stringify(Number(url.searchParams.get('offset') ?? 0) === 0 ? [projected] : []), { status: 200 });
      }
      if (url.pathname === '/rest/v1/invoices') return new Response('null', { status: 200 });
      throw new Error('Unexpected backend read: ' + url.pathname);
    } },
  }) };
});
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); });
beforeEach(() => {
  vi.stubGlobal('PointerEvent', MouseEvent);
  HTMLElement.prototype.scrollIntoView = vi.fn(); HTMLElement.prototype.hasPointerCapture = vi.fn(() => false); HTMLElement.prototype.releasePointerCapture = vi.fn();
  api.discounts = { version: 2 }; api.urls = [];
  api.create.mockReset().mockResolvedValue({ id: 'new-invoice', invoice_number: 'INV-1', billing_month: '2026-11' });
  api.read.mockReset().mockResolvedValue(null);
  api.plan.mockReset().mockResolvedValue({ revision: 1, schedule: { version: 2, start_billing_month: '2026-09', segments: [{ month_count: 3, monthly_amount: '300000' }, { month_count: 9, monthly_amount: '100000' }] } });
  api.quote.mockReset().mockImplementation(async (_org, _contract, month) => ({ state: 'READY', plan_revision: 1, billing_month: month, invoice_support: '300000', quote_hash: 'quote' }));
});
async function selectContract() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  render(<QueryClientProvider client={client}><GenerateInvoiceDialog open onOpenChange={() => {}} /></QueryClientProvider>);
  await waitFor(() => expect(api.urls.length).toBe(2)); // Actual fetchAllRows asks for the terminating empty page.
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
  const option = await screen.findByRole('option', { name: 'C1 - Room' });
  fireEvent.keyDown(option, { key: 'Enter' });
  fireEvent.change(screen.getByLabelText('Tháng'), { target: { value: '2026-11' } });
}
it('uses the projected v2 contract marker to quote support and send canonical invoice context', async () => {
  await selectContract();
  await waitFor(() => expect(api.plan).toHaveBeenCalledWith('org1', 'c1'));
  await waitFor(() => expect(screen.getByTestId('discount').textContent).toBe('300000'));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Tạo' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Tạo' }));
  await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1));
  expect(api.quote).toHaveBeenCalled();
  expect(api.create.mock.calls[0][0]).toMatchObject({ discount_amount: 300000, rent_support_context: { version: 1, expected_plan_revision: 1, manual_discount_amount: '0' } });
  expect(api.urls[0].searchParams.get('status')).toBe('in.(ACTIVE)');
  expect(api.urls[0].searchParams.get('select')).not.toMatch(/\*|id_number|bank_account|sale_party|deduction_policy|rent_support_plans/);
});
it('keeps an actual projected legacy contract on its existing path without support reads', async () => {
  api.discounts = null;
  await selectContract();
  await waitFor(() => expect((screen.getByRole('button', { name: 'Tạo' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Tạo' }));
  await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1));
  expect(api.plan).not.toHaveBeenCalled(); expect(api.quote).not.toHaveBeenCalled();
  expect(api.create.mock.calls[0][0].rent_support_context).toBeUndefined();
});
