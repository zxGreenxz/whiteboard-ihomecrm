// @vitest-environment jsdom
import { act, renderHook, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PropsWithChildren } from 'react';

const state = vi.hoisted(() => ({ rpc: vi.fn(), org: 'dddd0000-0000-4000-8000-000000000001' as string | null }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: state.rpc } }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: state.org }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
import { useCreateCommissionVoucher, type CreateCommissionVoucherInput } from '../useCommissionVoucher';

const input: CreateCommissionVoucherInput = {
  contract_id: '11111111-1111-4111-8111-111111111111', contract_number: 'HD-TEST',
  building_id: '22222222-2222-4222-8222-222222222222', room_id: null, tenant_id: null,
  account_id: null, voucher_date: '2026-09-29', kind: 'broker', amount: 500000,
  payer_name: null, recipient_name: 'Môi giới', recipient_bank: null, recipient_account_number: null,
  item_description: 'Hoa hồng',
};
function setup() {
  // A caller's permissive default must not cause an automatic money retry.
  const client = new QueryClient({ defaultOptions: { mutations: { retry: 2, retryDelay: 0 } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const hook = renderHook(useCreateCommissionVoucher, { wrapper: ({ children }: PropsWithChildren) =>
    <QueryClientProvider client={client}>{children}</QueryClientProvider> });
  return { ...hook, invalidate };
}
let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  state.org = 'dddd0000-0000-4000-8000-000000000001';
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  state.rpc.mockReset();
  state.rpc.mockImplementation(async (name, args) => name === 'prepare_commission_requests_v1'
    ? { data: args.p_intents.map((intent: { contract_id: string; kind: string; request_id: string }) => ({
      contract_id: intent.contract_id, kind: intent.kind, request_id: intent.request_id })), error: null }
    : { data: { status: 'COMPLETED', id: '44444444-4444-4444-8444-444444444444', code: 'PC-TEST' }, error: null });
});
afterEach(() => {
  // Expected mutation errors are asserted locally; other console errors remain failures.
  expect(errors.mock.calls.every(call => call[0] === 'Error creating commission voucher:')).toBe(true);
  errors.mockRestore(); cleanup();
});

it('prepares exact payload before execute and uses the returned request identity', async () => {
  const { result } = setup();
  await act(async () => { expect(await result.current.mutateAsync(input)).toMatchObject({ status: 'COMPLETED', code: 'PC-TEST' }); });
  expect(state.rpc.mock.calls.map(c => c[0])).toEqual(['prepare_commission_requests_v1', 'execute_commission_request_v1']);
  const prepared = state.rpc.mock.calls[0][1];
  expect(prepared).toMatchObject({ p_organization_id: state.org, p_intents: [{ contract_id: input.contract_id, kind: 'broker', amount: 500000 }] });
  expect(state.rpc.mock.calls[1][1]).toEqual({ p_organization_id: state.org, p_contract_id: input.contract_id,
    p_kind: 'broker', p_request_id: prepared.p_intents[0].request_id });
  expect(errors).not.toHaveBeenCalled();
});
it('never executes money when prepare fails and does not automatically retry', async () => {
  state.rpc.mockResolvedValue({ error: { message: 'offline' }, data: null });
  const { result } = setup();
  await act(async () => { await expect(result.current.mutateAsync(input)).rejects.toMatchObject({ message: 'offline' }); });
  expect(state.rpc.mock.calls.map(c => c[0])).toEqual(['prepare_commission_requests_v1']);
  expect(errors).toHaveBeenCalledOnce();
});
it('invalidates true sources after execute transport failure without another execute or client FAILED event', async () => {
  const base = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((name, args) => name === 'execute_commission_request_v1'
    ? Promise.resolve({ data: null, error: { message: 'Kết nối bị ngắt' } }) : base(name, args));
  const { result, invalidate } = setup();
  await act(async () => { await expect(result.current.mutateAsync(input)).rejects.toMatchObject({ message: 'Kết nối bị ngắt' }); });
  expect(state.rpc.mock.calls.map(c => c[0])).toEqual(['prepare_commission_requests_v1', 'execute_commission_request_v1']);
  for (const key of ['contract-commission-followups', 'existing-commission-vouchers', 'sale-bonus-status', 'income-expenses', 'accounts-with-balance', 'commission-voucher-facts'])
    expect(invalidate).toHaveBeenCalledWith({ queryKey: [key] });
  expect(errors).toHaveBeenCalledOnce();
});
it('does not send RPC without an organization', async () => {
  state.org = null; const { result } = setup();
  await act(async () => { await expect(result.current.mutateAsync(input)).rejects.toThrow('tổ chức'); });
  expect(state.rpc).not.toHaveBeenCalled(); expect(errors).toHaveBeenCalledOnce();
});
it('rejects an incomplete prepare receipt before any execute', async () => {
  state.rpc.mockResolvedValue({ data: [], error: null }); const { result } = setup();
  await act(async () => { await expect(result.current.mutateAsync(input)).rejects.toThrow('Chưa xác nhận đầy đủ'); });
  expect(state.rpc.mock.calls.map(c => c[0])).toEqual(['prepare_commission_requests_v1']);
});
it('rejects invalid execute result without another money request', async () => {
  const base = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((name, args) => name === 'execute_commission_request_v1'
    ? Promise.resolve({ data: { id: '44444444-4444-4444-8444-444444444444' }, error: null }) : base(name, args));
  const { result, invalidate } = setup();
  await act(async () => { await expect(result.current.mutateAsync(input)).rejects.toThrow(); });
  expect(state.rpc.mock.calls.map(c => c[0])).toEqual(['prepare_commission_requests_v1', 'execute_commission_request_v1']);
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['contract-commission-followups'] });
});
it('surfaces FAILED server receipt and leaves explicit retry to the user', async () => {
  const base = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((name, args) => name === 'execute_commission_request_v1'
    ? Promise.resolve({ data: { status: 'FAILED', id: null, code: null }, error: null }) : base(name, args));
  const { result } = setup();
  await act(async () => { await expect(result.current.mutateAsync(input)).rejects.toThrow('Máy chủ chưa tạo được phiếu'); });
  expect(state.rpc.mock.calls.filter(c => c[0] === 'execute_commission_request_v1')).toHaveLength(1);
});
it('reuses a saved request without preparing replacement payload', async () => {
  const preparedRequest = { contract_id: input.contract_id, kind: input.kind, request_id: '33333333-3333-4333-8333-333333333333' };
  const { result } = setup();
  await act(async () => { await result.current.mutateAsync({ ...input, preparedRequest }); });
  expect(state.rpc.mock.calls).toEqual([['execute_commission_request_v1', { p_organization_id: state.org,
    p_contract_id: input.contract_id, p_kind: input.kind, p_request_id: preparedRequest.request_id }]]);
});
