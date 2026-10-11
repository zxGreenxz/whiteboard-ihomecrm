import { beforeEach, expect, it, vi } from 'vitest';
import type { ForwardMediaInput, ForwardMediaResult } from '@/lib/zaloForwardMedia';

const mock = vi.hoisted(() => ({ rpc: vi.fn(), invalidate: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({ useMutation: (options: unknown) => options, useQueryClient: () => ({ invalidateQueries: mock.invalidate }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mock.rpc } }));
vi.mock('@/hooks/useZaloChat', () => ({ QK: { messages: (id: string) => ['zalo-messages', id], conversations: ['zalo-conversations'] } }));
import { useForwardZaloMedia } from '../useForwardZaloMedia';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
type Options = { mutationFn: (input: ForwardMediaInput) => Promise<ForwardMediaResult>; retry: boolean; onSuccess: (result: ForwardMediaResult) => void };
beforeEach(() => vi.clearAllMocks());

it('chỉ làm mới tin của đích được tiếp nhận, và danh sách hội thoại', () => {
  const hook = useForwardZaloMedia() as unknown as Options;
  hook.onSuccess({ recipients: [
    { conversation_id: id(1), status: 'queued', message_ids: [id(2)], job_id: id(3), reused: false },
    { conversation_id: id(4), status: 'rejected', error: 'Tài khoản chưa kết nối.' },
  ] });
  expect(mock.invalidate.mock.calls).toEqual([[{ queryKey: ['zalo-messages', id(1)] }], [{ queryKey: ['zalo-conversations'] }]]);
});

it('mạng lỗi không tự chạy lại mutation; mã yêu cầu do phiên chuyển tiếp giữ', async () => {
  const hook = useForwardZaloMedia() as unknown as Options;
  expect(hook.retry).toBe(false);
  mock.rpc.mockResolvedValue({ data: null, error: { message: 'network' } });
  await expect(hook.mutationFn({ sourceMessageIds: [id(1)], conversationIds: [id(2)], requestId: id(3) })).rejects.toEqual({ message: 'network' });
  expect(mock.rpc).toHaveBeenCalledTimes(1);
  expect(mock.invalidate).not.toHaveBeenCalled();
});
