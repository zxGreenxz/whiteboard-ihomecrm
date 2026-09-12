// @vitest-environment jsdom
import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import EditInvoiceDialog from '../EditInvoiceDialog';
import type { InvoiceWithRelations } from '@/types/invoice';

const network = vi.hoisted(() => ({ fetch: vi.fn(), permissions: undefined as Record<string, Record<string, boolean>> | undefined }));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: network.permissions }) }));
vi.mock('@/hooks/useInvoices', () => ({
  useInvoice: (id: string) => useQuery({ queryKey: ['invoice', id], queryFn: network.fetch }),
  useUpdateInvoice: vi.fn(), useExcessAmount: vi.fn(),
}));
vi.mock('@/hooks/useBuildingServices', () => ({ useBuildingServices: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('../IssuedInvoiceEditor', () => ({ default: ({ invoice }: { invoice: InvoiceWithRelations }) => {
  const [snapshot] = useState(invoice);
  return <output aria-label="Ảnh chụp chỉnh sửa">{JSON.stringify(snapshot)}</output>;
} }));
afterEach(cleanup);
beforeEach(() => { network.fetch.mockReset(); network.permissions = { invoices: { edit: true } }; });

function invoice(paid: number): InvoiceWithRelations {
  return { id: 'inv', status: paid ? 'PARTIAL_PAID' : 'APPROVED', paid_amount: paid,
    adjustment_revision: paid ? 1 : 0, updated_at: paid ? '2026-09-12T10:01:00.123456+00:00' : '2026-09-12T10:00:00+00:00',
    notes: paid ? 'Mới' : 'Cũ', invoice_items: [{ id: 'item', description: paid ? 'Khoản mới' : 'Khoản cũ' }],
  } as InvoiceWithRelations;
}
function setup(beforeOpen?: (client: QueryClient) => void) {
  const cached = invoice(0);
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(['invoice', 'inv'], cached);
  beforeOpen?.(client);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const view = render(<EditInvoiceDialog open invoice={cached} onOpenChange={() => {}} />, { wrapper });
  return { ...view, client, cached };
}

it('waits for the full fresh invoice before capturing form fields and expected tokens from a warm cache', async () => {
  let resolve!: (value: InvoiceWithRelations) => void;
  network.fetch.mockImplementation(() => new Promise<InvoiceWithRelations>(done => { resolve = done; }));
  const { client } = setup();
  expect(screen.queryByLabelText('Ảnh chụp chỉnh sửa')).toBeNull();
  await waitFor(() => expect(network.fetch).toHaveBeenCalledTimes(1));
  await act(async () => resolve(invoice(3239000)));
  expect(JSON.parse((await screen.findByLabelText('Ảnh chụp chỉnh sửa')).textContent!)).toEqual(invoice(3239000));
  client.clear();
});

it('does not fall back to cached editable data on read failure and allows an explicit retry', async () => {
  network.fetch.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(invoice(3239000));
  const { client } = setup();
  fireEvent.click(await screen.findByRole('button', { name: 'Thử tải lại' }));
  expect(screen.queryByLabelText('Ảnh chụp chỉnh sửa')).toBeNull();
  expect(JSON.parse((await screen.findByLabelText('Ảnh chụp chỉnh sửa')).textContent!)).toEqual(invoice(3239000));
  client.clear();
});

it('rejects a fresh cancelled invoice even when the cached row allowed adjustment', async () => {
  network.fetch.mockResolvedValue({ ...invoice(3239000), status: 'CANCELLED' });
  const { client } = setup();
  await screen.findByText('Hóa đơn không còn cho phép điều chỉnh.');
  expect(screen.queryByLabelText('Ảnh chụp chỉnh sửa')).toBeNull();
  client.clear();
});

it('keeps an opened snapshot fixed during background cache updates and reloads on the next opening', async () => {
  network.fetch.mockResolvedValueOnce(invoice(3239000)).mockResolvedValueOnce(invoice(4000000));
  const { client, rerender, cached } = setup();
  await screen.findByLabelText('Ảnh chụp chỉnh sửa');
  act(() => client.setQueryData(['invoice', 'inv'], invoice(4000000)));
  expect(JSON.parse(screen.getByLabelText('Ảnh chụp chỉnh sửa').textContent!)).toEqual(invoice(3239000));
  rerender(<EditInvoiceDialog open={false} invoice={cached} onOpenChange={() => {}} />);
  rerender(<EditInvoiceDialog open invoice={cached} onOpenChange={() => {}} />);
  expect(screen.queryByLabelText('Ảnh chụp chỉnh sửa')).toBeNull();
  expect(JSON.parse((await screen.findByLabelText('Ảnh chụp chỉnh sửa')).textContent!)).toEqual(invoice(4000000));
  client.clear();
});

it('starts a new read when an older invoice refresh is still in flight', async () => {
  let resolveOld!: (value: InvoiceWithRelations) => void;
  let resolveNew!: (value: InvoiceWithRelations) => void;
  network.fetch
    .mockImplementationOnce(() => new Promise<InvoiceWithRelations>(done => { resolveOld = done; }))
    .mockImplementationOnce(() => new Promise<InvoiceWithRelations>(done => { resolveNew = done; }));
  const { client } = setup(client => {
    void client.fetchQuery({ queryKey: ['invoice', 'inv'], queryFn: network.fetch, staleTime: 0 }).catch(() => {});
  });
  await waitFor(() => expect(network.fetch).toHaveBeenCalledTimes(2));
  expect(screen.queryByLabelText('Ảnh chụp chỉnh sửa')).toBeNull();
  await act(async () => resolveNew(invoice(3239000)));
  await screen.findByLabelText('Ảnh chụp chỉnh sửa');
  await act(async () => resolveOld(invoice(0)));
  expect(JSON.parse(screen.getByLabelText('Ảnh chụp chỉnh sửa').textContent!)).toEqual(invoice(3239000));
  client.clear();
});

it('does not mount an editor after closing while the opening read is pending', async () => {
  let resolve!: (value: InvoiceWithRelations) => void;
  network.fetch.mockImplementation(() => new Promise<InvoiceWithRelations>(done => { resolve = done; }));
  const { client, rerender, cached } = setup();
  await waitFor(() => expect(network.fetch).toHaveBeenCalledOnce());
  rerender(<EditInvoiceDialog open={false} invoice={cached} onOpenChange={() => {}} />);
  await act(async () => resolve(invoice(3239000)));
  expect(screen.queryByLabelText('Ảnh chụp chỉnh sửa')).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
  client.clear();
});

it('does not mount from a late read after edit permission becomes unavailable', async () => {
  let resolve!: (value: InvoiceWithRelations) => void;
  network.fetch.mockImplementation(() => new Promise<InvoiceWithRelations>(done => { resolve = done; }));
  const { client, rerender, cached } = setup();
  await waitFor(() => expect(network.fetch).toHaveBeenCalledOnce());
  network.permissions = undefined;
  rerender(<EditInvoiceDialog open invoice={cached} onOpenChange={() => {}} />);
  await act(async () => resolve(invoice(3239000)));
  expect(screen.queryByLabelText('Ảnh chụp chỉnh sửa')).toBeNull();
  client.clear();
});
