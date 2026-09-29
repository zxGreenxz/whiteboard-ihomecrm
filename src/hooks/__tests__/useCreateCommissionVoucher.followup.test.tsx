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
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const hook = renderHook(useCreateCommissionVoucher, { wrapper: ({ children }: PropsWithChildren) =>
    <QueryClientProvider client={client}>{children}</QueryClientProvider> });
  return { ...hook, invalidate };
}
beforeEach(() => {
  state.org = 'dddd0000-0000-4000-8000-000000000001';
  state.rpc.mockReset();
  state.rpc.mockImplementation(async (name, args) => name === 'record_contract_commission_event_v1'
    ? { data: { id: '33333333-3333-4333-8333-333333333333', contract_id: args.p_contract_id,
      kind: args.p_kind, action: args.p_action, request_id: args.p_request_id }, error: null }
    : { data: { id: '44444444-4444-4444-8444-444444444444', code: 'PC-TEST' }, error: null });
});
afterEach(cleanup);

it('ghi yêu cầu trước RPC tạo tiền và trả đúng phiếu', async () => {
  const { result } = setup();
  await act(async () => { expect(await result.current.mutateAsync(input)).toMatchObject({ code: 'PC-TEST' }); });
  expect(state.rpc.mock.calls.map(c => c[0])).toEqual(['record_contract_commission_event_v1', 'create_commission_voucher']);
  expect(state.rpc.mock.calls[0][1]).toMatchObject({ p_action: 'ATTEMPTED', p_amount: 500000, p_organization_id: state.org });
});
it('không ghi tiền nếu không lưu được dấu yêu cầu', async () => {
  state.rpc.mockResolvedValue({ error: { message: 'offline' }, data: null });
  const { result } = setup();
  await act(async () => { await expect(result.current.mutateAsync(input)).rejects.toThrow('chưa gửi tạo phiếu chi'); });
  expect(state.rpc.mock.calls.map(c => c[0])).toEqual(['record_contract_commission_event_v1']);
});
it('ghi lỗi theo cùng request và làm mới đối chiếu ngay cả khi trả lỗi', async () => {
  const base = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((name, args) => name === 'create_commission_voucher'
    ? Promise.resolve({ data: null, error: { message: 'Kết nối bị ngắt' } }) : base(name, args));
  const { result, invalidate } = setup();
  await act(async () => { await expect(result.current.mutateAsync(input)).rejects.toThrow('kiểm tra kết quả'); });
  expect(state.rpc.mock.calls[2][1]).toMatchObject({ p_action: 'FAILED', p_request_id: state.rpc.mock.calls[0][1].p_request_id });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['contract-commission-followups'] });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['existing-commission-vouchers'] });
});
it('không gửi RPC khi chưa xác định org', async () => {
  state.org = null;
  const { result } = setup();
  await act(async () => { await expect(result.current.mutateAsync(input)).rejects.toThrow('tổ chức'); });
  expect(state.rpc).not.toHaveBeenCalled();
});

it('phản hồi tạo phiếu sai cấu trúc được lưu để kiểm tra, không tự gọi tạo lại', async () => {
  const base = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((name, args) => name === 'create_commission_voucher'
    ? Promise.resolve({ data: { id: '44444444-4444-4444-8444-444444444444' }, error: null }) : base(name, args));
  const { result } = setup();
  await act(async () => { await expect(result.current.mutateAsync(input)).rejects.toThrow('Chưa xác nhận được thông tin phiếu vừa tạo'); });
  expect(state.rpc.mock.calls.filter(c => c[0] === 'create_commission_voucher')).toHaveLength(1);
  expect(state.rpc.mock.calls[2][1]).toMatchObject({ p_action: 'FAILED' });
});
