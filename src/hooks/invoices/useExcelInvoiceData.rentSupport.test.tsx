// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useSubmitExcelInvoices } from './useExcelInvoiceData';
import { buildExcelRows } from '@/lib/excelInvoiceRows';
const api = vi.hoisted(() => ({ create: vi.fn(), read: vi.fn() }));
vi.mock('@/hooks/useInvoices', () => ({ useCreateInvoice: () => ({ mutateAsync: api.create, isPending: false }) }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org1' }) }));
vi.mock('@/lib/invoiceRentSupport', async original => ({ ...await original<typeof import('@/lib/invoiceRentSupport')>(), readSavedInvoiceSupportRequest: api.read }));
it('reuses an unchanged failed row request and skips a successful sibling on retry', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  api.read.mockResolvedValue(null);
  api.create.mockImplementation(async payload => { if (payload.contract_id === 'c2') throw new Error('lost response'); return { id: 'i1' }; });
  const rows = buildExcelRows({ contracts: ['c1', 'c2'].map(id => ({ id, room_id: id, rent_price: 1000000, rent_support: { revision: 2, schedule: { version: 2, start_billing_month: '2026-09', segments: [{ month_count: 12, monthly_amount: '100000' }] } } })), meterByRoom: new Map(), lastReading: new Map(), creditByContract: new Map(), invoiceCountByContract: new Map(), previousDebtByContract: new Map(), defaults: { elec: 3500, water: 0, pdv: 0, elecServiceId: null, waterServiceId: null, pdvServiceId: null }, billingMonth: '2026-11' });
  const ctx = { buildingId: 'b1', billingMonth: '2026-11', issueDate: '2026-11-01', dueDate: '2026-11-05', periodStart: new Date('2026-11-01'), fromDate: '2026-11-01', toDate: '2026-11-30' };
  const { result } = renderHook(() => useSubmitExcelInvoices());
  await act(async () => { await result.current.submit(rows, ctx); });
  const failedRequest = api.create.mock.calls[1][0].rent_support_context.request_id;
  await act(async () => { await result.current.submit(rows, ctx); });
  expect(api.create.mock.calls.map(call => call[0].contract_id)).toEqual(['c1', 'c2', 'c2']);
  expect(api.create.mock.calls[2][0].rent_support_context.request_id).toBe(failedRequest);
  expect(api.read).toHaveBeenCalledWith('org1', 'c2', failedRequest);
  expect(errors).toHaveBeenCalledTimes(2);
  errors.mockRestore();
});
