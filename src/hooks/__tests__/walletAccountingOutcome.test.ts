import { afterEach, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({ useQuery: (config: unknown) => config, useMutation: (config: unknown) => config, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: io }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
import { usePersonalTransactions, useUpdatePersonalTransaction, useDeletePersonalTransaction } from '../usePersonalTransactions';
import { useAccountingStandard } from '../useAccountingStandard';

afterEach(() => { io.from.mockReset(); io.rpc.mockReset(); });
type QueryHook = { queryFn: () => Promise<unknown> };
type MutationHook<T> = { mutationFn: (input: T) => Promise<unknown> };

it('không biến phản hồi ví cá nhân null thành ví rỗng', async () => {
  const chain = { select: vi.fn(), is: vi.fn(), order: vi.fn() };
  chain.select.mockReturnValue(chain); chain.is.mockReturnValue(chain);
  chain.order.mockReturnValueOnce(chain).mockResolvedValueOnce({ data: null, error: null });
  io.from.mockReturnValue(chain);
  await expect((usePersonalTransactions() as unknown as QueryHook).queryFn()).rejects.toThrow('Chưa xác nhận');
});

it('không biến phản hồi Chuẩn kế toán null thành danh sách tổ chức rỗng', async () => {
  io.rpc.mockResolvedValue({ data: null, error: null });
  await expect((useAccountingStandard() as unknown as QueryHook).queryFn()).rejects.toThrow('Chưa xác nhận');
});

it.each([['cập nhật', useUpdatePersonalTransaction], ['xóa', useDeletePersonalTransaction]])('%s ví cá nhân cần hàng được xác nhận', async (_label, hook) => {
  const chain = { update: vi.fn(), eq: vi.fn(), select: vi.fn(), single: vi.fn().mockResolvedValue({ data: null, error: null }) };
  chain.update.mockReturnValue(chain); chain.eq.mockReturnValue(chain); chain.select.mockReturnValue(chain);
  io.from.mockReturnValue(chain);
  const input = _label === 'xóa' ? 'txn-1' : { id: 'txn-1', values: { type: 'INCOME', amount: 100, txn_date: '2026-09-30' } };
  await expect((hook() as unknown as MutationHook<typeof input>).mutationFn(input)).rejects.toThrow('Chưa xác nhận');
  expect(chain.select).toHaveBeenCalledWith('id');
});
