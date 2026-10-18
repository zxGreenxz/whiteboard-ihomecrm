import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ZaloConversation, ZaloLabel } from '@/components/chat-zalo/types';
import type { ZaloConversationPage } from '../useZaloChat';
const mock = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], select: vi.fn(), from: vi.fn(), rpc: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({ useQuery: (query: unknown) => query }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ organization: { id: 'org-a' } }) }));
vi.mock('@/integrations/supabase/client', () => {
  const q = { select: (columns: string) => { mock.select(columns); return q; }, eq: () => q, order: () => q, limit: () => Promise.resolve({ data: mock.rows, error: null }), then: (resolve: (value: unknown) => unknown) => Promise.resolve(resolve({ data: mock.rows, error: null })) };
  return { supabase: { from: (table: string) => { mock.from(table); return q; }, rpc: mock.rpc } };
});
import { LIST_LIMIT, useZaloConversationList, useZaloConversations, useZaloLabels } from '../useZaloChat';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FIELDS = { account_id: null, peer_zalo_uid: null, label_ids: [], initials: null, peer_avatar_url: null, tone: 'emerald', last_message_at: '2026-10-17T01:00:00+00:00',
  sub_label: null, sub_tone: null, last_message_text: 'Chào', unread_count: 0, list_tag: null, is_online: false, header_tag: null, header_sub: null,
  peer_phone: null, is_pinned: false, is_muted: false, marked_unread: false, thread_type: 'user', customer_id: null, lead_id: null, contract_id: null,
  room_id: null, is_sale_partner: false, profile: {} };
const row = (n: number, over: Record<string, unknown> = {}) => ({ ...FIELDS, id: id(n), peer_name: `Khách ${n}`, ...over });
type ListQuery<T> = { queryKey: unknown[]; enabled: boolean; queryFn: () => Promise<T>; placeholderData?: (previous: unknown, query?: { queryKey: unknown[] }) => unknown };

beforeEach(() => { vi.clearAllMocks(); mock.rpc.mockResolvedValue({ data: { total: 0, rows: [] }, error: null }); });

it('keeps equal label IDs from separate accounts instead of deduplicating them together', async () => {
  mock.rows = [{ account_id: 'account-a', label_id: 7, name: 'Sale A' }, { account_id: 'account-b', label_id: 7, name: 'Sale B' }];
  const query = useZaloLabels() as unknown as { queryFn: () => Promise<ZaloLabel[]> };
  await expect(query.queryFn()).resolves.toEqual(expect.arrayContaining([
    expect.objectContaining({ accountId: 'account-a', labelId: 7, name: 'Sale A' }),
    expect.objectContaining({ accountId: 'account-b', labelId: 7, name: 'Sale B' }),
  ]));
  expect(mock.select).toHaveBeenCalledWith(expect.stringContaining('account_id'));
});

it('an explicit personal thread cannot become a group from an outdated profile snapshot', async () => {
  mock.rpc.mockResolvedValue({ data: { total: 2, rows: [
    row(1, { thread_type: 'user', profile: { isGroup: true } }),
    row(2, { thread_type: 'group', profile: { isGroup: false } }),
  ] }, error: null });
  const query = useZaloConversations() as unknown as ListQuery<ZaloConversation[]>;
  const rows = await query.queryFn();
  expect(rows.find(r => r.id === id(1))?.isGroup).toBe(false);
  expect(rows.find(r => r.id === id(2))?.isGroup).toBe(true);
});

describe('danh sách hội thoại đọc qua zalo_conversation_list_v1', () => {
  it('danh sách nền: một RPC, không đọc bảng zalo_conversations, giữ query key và thứ tự hàm trả về', async () => {
    mock.rpc.mockResolvedValue({ data: { total: 2, rows: [row(2, { is_pinned: true }), row(1, { profile: { kind: 'tenant', room: 'P1' } })] }, error: null });
    const query = useZaloConversations() as unknown as ListQuery<ZaloConversation[]>;
    expect(query.queryKey).toEqual(['zalo', 'conversations', 'org-a']);
    const rows = await query.queryFn();
    expect(mock.rpc).toHaveBeenCalledTimes(1);
    expect(mock.rpc).toHaveBeenCalledWith('zalo_conversation_list_v1', expect.objectContaining({ p_organization_id: 'org-a', p_limit: 1000, p_offset: 0 }));
    const [, args] = mock.rpc.mock.calls[0] as [string, Record<string, unknown>];
    for (const key of ['p_filter', 'p_search', 'p_account_ids', 'p_label_account_id', 'p_label_id', 'p_building_ids']) expect(args[key]).toBeUndefined();
    expect(mock.from).not.toHaveBeenCalledWith('zalo_conversations');
    expect(rows.map(r => r.id)).toEqual([id(2), id(1)]);
    expect(rows[1].profile).toEqual({ kind: 'tenant', room: 'P1' });
    // Không có khoá kind trong profile thu gọn ⇒ vẫn mặc định 'unknown' như projection cũ.
    expect(rows[0].profile).toEqual({ kind: 'unknown' });
  });

  it('cột danh sách: thẻ/tìm/tài khoản/nhãn thành tham số SQL, trang LIST_LIMIT, trả tổng khớp', async () => {
    mock.rpc.mockResolvedValue({ data: { total: 41, rows: [row(3)] }, error: null });
    const query = useZaloConversationList({ filter: 'unread', search: '  an ', selectedAccountIds: ['acc-a'], accountIds: ['acc-a', 'acc-b'], label: 'acc-a:7' }) as unknown as ListQuery<ZaloConversationPage>;
    const args = { p_organization_id: 'org-a', p_filter: 'unread', p_search: 'an', p_account_ids: ['acc-a'], p_label_account_id: 'acc-a', p_label_id: 7,
      p_limit: LIST_LIMIT, p_offset: 0 };
    expect(query.queryKey).toEqual(['zalo', 'conversations', 'org-a', 'list', expect.objectContaining(args)]);
    const page = await query.queryFn();
    expect(mock.rpc).toHaveBeenCalledWith('zalo_conversation_list_v1', expect.objectContaining(args));
    expect(page.total).toBe(41);
    expect(page.rows.map(r => r.id)).toEqual([id(3)]);
    expect(LIST_LIMIT).toBe(300);
  });

  it('chọn đủ mọi tài khoản thì không lọc tài khoản; bỏ chọn hết thì gửi mảng rỗng', async () => {
    const all = useZaloConversationList({ filter: 'all', search: '', selectedAccountIds: ['acc-b', 'acc-a'], accountIds: ['acc-a', 'acc-b'], label: null }) as unknown as ListQuery<ZaloConversationPage>;
    await all.queryFn();
    expect((mock.rpc.mock.calls[0][1] as Record<string, unknown>).p_account_ids).toBeUndefined();
    expect((mock.rpc.mock.calls[0][1] as Record<string, unknown>).p_search).toBeUndefined();
    const none = useZaloConversationList({ filter: 'all', search: '', selectedAccountIds: [], accountIds: ['acc-a'], label: null }) as unknown as ListQuery<ZaloConversationPage>;
    await none.queryFn();
    expect((mock.rpc.mock.calls[1][1] as Record<string, unknown>).p_account_ids).toEqual([]);
  });

  it('lỗi RPC hay câu trả lời lệch hình dạng là lỗi, không phải danh sách rỗng', async () => {
    const query = useZaloConversationList({ filter: 'all', search: '' }) as unknown as ListQuery<ZaloConversationPage>;
    const failure = { code: '42501', message: 'zalo_conversation_list_v1 chỉ chạy bằng JWT người dùng' };
    mock.rpc.mockResolvedValueOnce({ data: null, error: failure });
    await expect(query.queryFn()).rejects.toBe(failure);
    for (const data of [
      { total: 0, rows: [row(1)] },
      { total: 2, rows: [row(1), row(1)] },
      { total: 1, rows: [row(1, { profile: { memberProfiles: {} } })] },
      { total: 1, rows: [(({ room_id: _drop, ...rest }) => rest)(row(1))] },
      { total: 301, rows: Array.from({ length: 301 }, (_, i) => row(i + 1)) },
      { rows: [] },
      null,
    ]) {
      mock.rpc.mockResolvedValueOnce({ data, error: null });
      await expect(query.queryFn(), JSON.stringify(data)?.slice(0, 80)).rejects.toThrow();
    }
  });

  it('giữ trang cũ khi đổi bộ lọc trong cùng công ty, bỏ khi đổi công ty', () => {
    const query = useZaloConversationList({ filter: 'all', search: 'a' }) as unknown as ListQuery<ZaloConversationPage>;
    const previous = { rows: [], total: 0 };
    expect(query.placeholderData?.(previous, { queryKey: ['zalo', 'conversations', 'org-a', 'list', {}] })).toBe(previous);
    expect(query.placeholderData?.(previous, { queryKey: ['zalo', 'conversations', 'org-b', 'list', {}] })).toBeUndefined();
  });
});
