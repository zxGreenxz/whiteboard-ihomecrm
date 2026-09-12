// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCreateInvoice, useUpdateInvoice, invoicesListQuery } from '../useInvoices';
import type { InvoiceFormData } from '@/types/invoice';

const boundary = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), inserted: [] as unknown[], select: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: { mutationFn: unknown }) => ({ mutateAsync: options.mutationFn }),
  useQuery: vi.fn(), useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'demo-user', email: 'demo@example.invalid' }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: boundary }));
vi.mock('@/lib/invoiceUtils', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/invoiceUtils')>(), generateInvoiceNumber: async () => 'DEMO-DEPOSIT',
}));

const form: InvoiceFormData = {
  contract_id: 'demo-contract', building_id: 'demo-building', room_id: 'demo-room',
  billing_month: '2026-09', issue_date: '2026-09-01', due_date: '2026-09-05',
  discount_amount: 0, prepaid_amount: 0, previous_debt: 0,
  items: [
    { type: 'OTHER', accounting_class: 'DEPOSIT', description: 'Tiền cọc', unit_price: 2200000, quantity: 1, coefficient: 1, sort_order: 0 },
    { type: 'OTHER', accounting_class: 'REVENUE', description: 'Phí xử lý cọc', unit_price: 50000, quantity: 1, coefficient: 1, sort_order: 1 },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  boundary.inserted = [];
  boundary.rpc.mockResolvedValue({ data: { id: 'demo-invoice' }, error: null });
  boundary.from.mockImplementation((table: string) => {
    const builder = {
      select: boundary.select.mockImplementation(() => builder),
      eq: vi.fn(() => builder), is: vi.fn(() => builder), order: vi.fn(() => builder),
      in: vi.fn(() => builder), not: vi.fn(() => builder), range: vi.fn(() => builder),
      neq: vi.fn(() => builder), delete: vi.fn(() => builder), update: vi.fn(() => builder),
      insert: (items: unknown) => { if (table === 'invoice_items') boundary.inserted.push(items); return builder; },
      single: async () => ({ data: { id: 'demo-invoice', status: 'DRAFT', paid_amount: 0 }, error: null }),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [], error: null, count: 0 }).then(resolve),
    };
    return builder;
  });
});

for (const operation of ['create', 'update'] as const) {
  describe(operation, () => {
    const submit = () => {
      const { result } = renderHook(() => ({ create: useCreateInvoice(), update: useUpdateInvoice() }));
      return operation === 'create'
        ? result.current.create.mutateAsync(form)
        : result.current.update.mutateAsync({ id: 'demo-invoice', formData: form });
    };
    it('sends explicit deposit and revenue classes to the canonical writer', async () => {
      await submit();
      expect(boundary.rpc.mock.calls[0]?.[1].p_items).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'OTHER', accounting_class: 'DEPOSIT', amount: 2200000 }),
        expect.objectContaining({ type: 'OTHER', accounting_class: 'REVENUE', amount: 50000 }),
      ]));
      expect(boundary.inserted).toHaveLength(0);
    });
    it('preserves both classes when the canonical writer is unavailable', async () => {
      boundary.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } });
      await submit();
      expect(boundary.inserted).toEqual([[expect.objectContaining({ accounting_class: 'DEPOSIT', amount: 2200000 }), expect.objectContaining({ accounting_class: 'REVENUE', amount: 50000 })]]);
    });
  });
}

it('requests accounting class in the invoice list projection used by edit', async () => {
  await invoicesListQuery().queryFn();
  const projection = boundary.select.mock.calls[0]?.[0] as string;
  expect(projection.match(/invoice_items\s*\(([^)]*)\)/)?.[1]?.split(',').map(column => column.trim())).toContain('accounting_class');
});
