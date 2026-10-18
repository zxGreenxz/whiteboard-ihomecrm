import { beforeEach, expect, it, vi } from 'vitest';
import type { ZaloConversation } from '@/components/chat-zalo/types';

const mock = vi.hoisted(() => ({ entries: [] as Array<[unknown[], unknown]>, set: vi.fn(), cancel: vi.fn(), invalidate: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: unknown) => options,
  useQueryClient: () => ({ cancelQueries: mock.cancel, getQueriesData: () => mock.entries, setQueryData: mock.set, invalidateQueries: mock.invalidate }),
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn() } }));
vi.mock('@/hooks/useZaloChat', () => ({ QK: { conversations: ['zalo', 'conversations'] } }));
import { useSetConversationFlags } from '../useZaloConversationActions';

const conv = (id: string, pinned = false) => ({ id, pinned, muted: false, markedUnread: false }) as ZaloConversation;
type Hook = { onMutate: (v: { conversationId: string; pinned?: boolean }) => Promise<unknown> };
beforeEach(() => vi.clearAllMocks());

it('ghim lạc quan cả danh sách nền (mảng) lẫn trang cột danh sách { rows, total }, bỏ qua ô thành viên nhóm', async () => {
  const baseKey = ['zalo', 'conversations', 'org-a'];
  const listKey = ['zalo', 'conversations', 'org-a', 'list', { p_filter: 'all' }];
  const membersKey = ['zalo', 'conversations', 'org-a', 'members', 'acc', 'c1'];
  mock.entries = [[baseKey, [conv('c1'), conv('c2')]], [listKey, { rows: [conv('c1'), conv('c2')], total: 9 }], [membersKey, { 42: { name: 'An' } }], [['zalo', 'conversations', 'x'], undefined]];
  const hook = useSetConversationFlags() as unknown as Hook;
  await expect(hook.onMutate({ conversationId: 'c2', pinned: true })).resolves.toEqual({ entries: mock.entries });
  expect(mock.set).toHaveBeenCalledTimes(2);
  expect(mock.set).toHaveBeenCalledWith(baseKey, [conv('c2', true), conv('c1')]);
  expect(mock.set).toHaveBeenCalledWith(listKey, { rows: [conv('c2', true), conv('c1')], total: 9 });
});
