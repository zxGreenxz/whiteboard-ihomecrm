// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PropsWithChildren } from 'react';
import type { InvoiceFormData } from '@/types/invoice';
import { useCreateInvoice } from '../useInvoices';

const api = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), toast: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: api }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor', email: 'synthetic@example.invalid' }) }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org' }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: api.toast }) }));
const invoiceId = 'ef2bf5f1-7306-4df2-bf7e-03e761b0912f';
const requestId = '888af989-f4e0-4d09-87c1-30a509b6c490';
const form: InvoiceFormData = {
 contract_id: 'contract', building_id: 'building', room_id: 'room', billing_month: '2026-12',
 issue_date: '2026-12-01', due_date: '2026-12-05', discount_amount: 120000, applied_credit: 0,
 prepaid_amount: 0, previous_debt: 0,
 rent_support_context: { version: 1, expected_plan_revision: 1, manual_discount_amount: '20000', request_id: requestId },
 items: [{ type: 'RENT', description: 'Rent', unit_price: 5000000, quantity: 1, coefficient: 1, sort_order: 0 }],
};
const clients: QueryClient[] = [];
function createHook() {
 const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
 clients.push(client);
 return renderHook(() => useCreateInvoice(), { wrapper: ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
}
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); });
beforeEach(() => {
 vi.clearAllMocks();
 api.from.mockImplementation(() => { throw new Error('No table read/write fallback is allowed'); });
});
function respondWith(receipt: unknown) {
 api.rpc.mockImplementation(async (name: string) => {
  if (name === 'quote_contract_rent_support_v1') return { data: { invoice_support: '100000', agreed_amount: '100000', plan_revision: 1, billing_month: '2026-12', quote_hash: 'quote', state: 'READY' }, error: null };
  if (name === 'create_invoice_v1') return { data: receipt, error: null };
  throw new Error('Unexpected RPC: ' + name);
 });
}
it('confirms the canonical create receipt through the real mutation and preserves its identity', async () => {
 respondWith({ invoice_id: invoiceId, status: 'DRAFT', invoice_number: 'INV-2026-01012' });
 const { result } = createHook();
 let saved: unknown;
 await act(async () => { saved = await result.current.mutateAsync(form); });
 expect(saved).toMatchObject({ id: invoiceId, invoice_number: 'INV-2026-01012', status: 'DRAFT' });
 expect(api.rpc.mock.calls.map(call => call[0])).toEqual(['quote_contract_rent_support_v1', 'create_invoice_v1']);
 expect(api.rpc.mock.calls[1][1]).toMatchObject({ p_discount_amount: 120000, p_applied_credit: 0, p_rent_support_context: form.rent_support_context });
 expect(api.from).not.toHaveBeenCalled();
 expect(api.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Đã tạo hoá đơn INV-2026-01012' }));
});
it.each([{}, { invoice_id: invoiceId, id: 'different-invoice' }])('keeps invalid receipts unknown without fallback or success feedback: %j', async receipt => {
 respondWith(receipt);
 const { result } = createHook();
 await act(async () => { await expect(result.current.mutateAsync(form)).rejects.toBeInstanceOf(TypeError); });
 expect(api.from).not.toHaveBeenCalled();
 expect(api.rpc.mock.calls.filter(call => call[0] === 'create_invoice_v1')).toHaveLength(1);
 expect(api.toast).toHaveBeenCalledTimes(1);
 expect(api.toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive', description: expect.stringContaining('Chưa xác nhận được kết quả') }));
});
