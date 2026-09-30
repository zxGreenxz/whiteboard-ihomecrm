// @vitest-environment jsdom
import {renderHook,cleanup} from '@testing-library/react';
import { afterEach,beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ rows: null as unknown, read: vi.fn(), rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: h.rpc, from: () => {
    const b = { select: () => b, in: () => b, eq: () => b, single: h.read,
      then: (done: (value: unknown) => unknown) => Promise.resolve({ data: h.rows, error: null }).then(done) };
    return b;
  } },
}));
vi.mock('@tanstack/react-query', () => ({ useMutation: (o: unknown) => o, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org1' }) }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'u1' }) }));
import { useBulkCancelInvoices } from '../useInvoices';
const run = (ids: string[]) => {const {result}=renderHook(()=>useBulkCancelInvoices());return (result.current as unknown as { mutationFn: (ids: string[]) => Promise<unknown> }).mutationFn(ids);};
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  h.rows = [{ id: 'i1', organization_id: 'org1', status: 'DRAFT', paid_amount: 0, deleted_at: null }, { id: 'i2', organization_id: 'org1', status: 'DRAFT', paid_amount: 0, deleted_at: null }];
  h.read.mockResolvedValue({ data: null, error: { code: '42501' } });
});
it('bulk hủy chỉ xác nhận ID có receipt đã hủy, giữ unknown và không gửi lại invoice chưa đối chiếu', async () => {
  h.rpc.mockImplementation((_name: string, args: { p_invoice_id: string }) => Promise.resolve({ data: args.p_invoice_id === 'i1' ? { invoice: { id: 'i1', status: 'CANCELLED' } } : {}, error: null }));
  const result = await run(['i1', 'i2']);
  expect(result).toMatchObject({ done: 1, failed: 1, completedIds: ['i1'], failures: [{ id: 'i2', outcomeUnknown: true }] });
  h.rows=(h.rows as {id:string}[]).filter(row=>row.id==='i2');
  const before = h.rpc.mock.calls.length; await run(['i2']);
  expect(h.rpc).toHaveBeenCalledTimes(before);
});
it('receipt sai ID hoặc state không cho bulk nói đã hủy', async () => {
  h.rows = [{ id: 'i3', organization_id: 'org1', status: 'DRAFT', paid_amount: 0, deleted_at: null }];
  h.rpc.mockResolvedValue({ data: { invoice: { id: 'other', status: 'CANCELLED' } }, error: null });
  h.read.mockResolvedValue({ data: { id: 'i3', status: 'APPROVED' }, error: null });
  expect(await run(['i3'])).toMatchObject({ done: 0, failed: 1, completedIds: [], failures: [{ id: 'i3', outcomeUnknown: true }] });
});
it('bulk có state thiếu nhưng readback target đã hủy được xác nhận đúng ID', async () => {
  h.rows = [{ id: 'i4', organization_id: 'org1', status: 'DRAFT', paid_amount: 0, deleted_at: null }];
  h.rpc.mockResolvedValue({ data: {}, error: null }); h.read.mockResolvedValue({ data: { id: 'i4', status: 'CANCELLED' }, error: null });
  expect(await run(['i4'])).toMatchObject({ done: 1, failed: 0, completedIds: ['i4'] });
});
it('nguồn invoice null không thành không có invoice đủ điều kiện', async () => {
  h.rows = null; await expect(run(['i5'])).rejects.toThrow(); expect(h.rpc).not.toHaveBeenCalled();
});
