// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useRoomTransferQuote } from './useRoomTransferQuote';
import { readRoomTransferQuote } from '@/lib/contract-lifecycle/roomTransferQuote';

const h = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: h.rpc } }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org' }) }));
const input = { contractId: 'contract', newRoomId: 'room', transferDate: '2026-10-01', newDeposit: 500 };
const firstQuote = { period_start: '2026-10-01', period_end: '2026-10-31', old_days: 0, new_days: 31,
  period_rent: 1000, billed_rent: 0, rent_delta: 1000, required_deposit: 500, held_deposit: 250,
  deposit_shortfall: 250, deposit_surplus: 0, invoice_id: null, invoice_status: null, quote_key: 'dddddddddddddddddddddddddddddddd' };
afterEach(() => { cleanup(); h.rpc.mockReset(); });

it('không dùng kết quả cũ khi đổi tiền cọc trong lúc đang tải', async () => {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  let finishFirst!: (value: unknown) => void;
  const late = new Promise(resolve => { finishFirst = resolve; });
  h.rpc.mockReturnValueOnce(late).mockResolvedValueOnce({data:{ ...firstQuote, required_deposit: 0, quote_key: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },error:null});
  const { result, rerender } = renderHook(props => useRoomTransferQuote(props), { wrapper, initialProps: input });
  await waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(1));
  rerender({ ...input, newDeposit: 0 });
  expect(result.current.data).toBeUndefined();
  await waitFor(() => expect(result.current.data?.quote_key).toBe('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'));
  await act(async () => { finishFirst({data:firstQuote, error:null}); await late; });
  expect(result.current.data?.quote_key).toBe('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
  expect(h.rpc.mock.calls[1]).toEqual(['preview_room_transfer_v1', {p_org:'org',p_contract_id:'contract',p_new_room_id:'room',p_transfer_date:'2026-10-01',p_new_rent_price:null,p_new_deposit:0}]);
});

it.each([
  { period_end: '2026-09-30' }, { required_deposit: 100 }, { quote_key: '' },
  { invoice_id: null, invoice_status: 'PAID' }, { billed_rent: null },
])('không chấp nhận báo giá thiếu dữ kiện hoặc sai kỳ/cọc (%#)', async invalid => {
  h.rpc.mockResolvedValue({data:{ ...firstQuote, ...invalid },error:null});
  await expect(readRoomTransferQuote('org', input)).rejects.toThrow(/xem trước/);
});

it('chuyển trong thời gian miễn tiền trước kỳ tính đầu: báo giá bắt đầu sau ngày chuyển và không tính ngày phòng cũ', async () => {
  h.rpc.mockResolvedValue({data:{ ...firstQuote, period_start:'2026-10-10', old_days:0, new_days:22 }, error:null});
  await expect(readRoomTransferQuote('org', input)).resolves.toMatchObject({ old_days:0, period_start:'2026-10-10' });
});
