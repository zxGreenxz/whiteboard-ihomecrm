import { expect, it, vi } from 'vitest';
import type { ZaloConversation, ZaloLabel } from '@/components/chat-zalo/types';
const mock = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], select: vi.fn(), afterPage: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({ useQuery: (query: unknown) => query }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ organization: { id: 'org-a' } }) }));
vi.mock('@/integrations/supabase/client', () => {
  const from = () => {
    const sort: string[] = [];
    let after = '';
    let scope = '';
    const q = {
      select: (columns: string) => { mock.select(columns); return q; },
      eq: () => q,
      order: (key: string) => { sort.push(key); return q; },
      gt: (_key: string, id: string) => { after = id; return q; },
      or: (expression: string) => { scope = expression; return q; },
      range: (start: number, end: number) => {
        const limitId = scope.match(/id\.lte\.([^,)]+)/)?.[1];
        const sorted = mock.rows.filter(row => String(row.id) > after && (!limitId || row.last_message_at || String(row.id) <= limitId)).sort((a, b) => {
          const time = sort[0] === 'last_message_at' ? String(b.last_message_at ?? '').localeCompare(String(a.last_message_at ?? '')) : 0;
          return time || String(a.id).localeCompare(String(b.id));
        });
        const data = sorted.slice(start, end + 1).map(row => ({ ...row }));
        if (data.length === 1000) mock.afterPage();
        return Promise.resolve({ data, error: null });
      },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(resolve({ data: mock.rows, error: null })),
    };
    return q;
  };
  return { supabase: { from } };
});
import { useZaloConversations, useZaloLabels } from '../useZaloChat';

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
  mock.rows = [
    { id: 'personal', peer_name: 'A', thread_type: 'user', profile: { isGroup: true } },
    { id: 'group', peer_name: 'B', thread_type: 'group', profile: { isGroup: false } },
  ];
  const query = useZaloConversations() as unknown as { queryFn: () => Promise<ZaloConversation[]> };
  const rows = await query.queryFn();
  expect(rows.find(row => row.id === 'personal')?.isGroup).toBe(false);
  expect(rows.find(row => row.id === 'group')?.isGroup).toBe(true);
});

it('includes groups after the first PostgREST page in the inbox and recipient list', async () => {
  mock.rows = Array.from({ length: 1001 }, (_, i) => ({ id: String(i).padStart(5, '0'), peer_name: 'Group', thread_type: 'group', is_sale_partner: i === 1000 }));
  const query = useZaloConversations() as unknown as { queryFn: () => Promise<ZaloConversation[]> };
  const rows = await query.queryFn();
  expect(rows).toHaveLength(1001);
  expect(rows[1000]).toMatchObject({ id: '01000', isGroup: true, isSalePartner: true });
});

it('keeps a group that becomes the latest conversation between pages', async () => {
  mock.rows = Array.from({ length: 1001 }, (_, index) => ({
    id: String(index).padStart(5, '0'), peer_name: 'Group', thread_type: 'group',
  }));
  mock.afterPage.mockImplementationOnce(() => { mock.rows[1000].last_message_at = '2026-01-01T00:00:00Z'; });
  const query = useZaloConversations() as unknown as { queryFn: () => Promise<ZaloConversation[]> };
  const rows = await query.queryFn();
  expect(rows).toHaveLength(1001);
  expect(rows[0].id).toBe('01000');
});

it('keeps the newest 5000 when many contacts have no messages', async () => {
  mock.rows = Array.from({ length: 5002 }, (_, index) => ({
    id: String(index).padStart(5, '0'), peer_name: 'Group', thread_type: 'group',
    last_message_at: index === 5001 ? '2026-01-01T00:00:00Z' : null,
  }));
  const query = useZaloConversations() as unknown as { queryFn: () => Promise<ZaloConversation[]> };
  const rows = await query.queryFn();
  expect(rows).toHaveLength(5000);
  expect(rows[0].id).toBe('05001');
  expect(rows.at(-1)?.id).toBe('04998');
});

it('keeps the newest threads when activity moves another contact across the 5000 cutoff', async () => {
  mock.rows = Array.from({ length: 5001 }, (_, index) => ({
    id: String(index).padStart(5, '0'), peer_name: 'Group', thread_type: 'group',
    last_message_at: index === 5000 ? '2026-01-03T00:00:00Z' : null,
  }));
  mock.afterPage.mockImplementationOnce(() => { mock.rows[4999].last_message_at = '2026-01-02T00:00:00Z'; });
  const query = useZaloConversations() as unknown as { queryFn: () => Promise<ZaloConversation[]> };
  const rows = await query.queryFn();
  expect(rows).toHaveLength(5000);
  expect(rows.slice(0, 2).map(row => row.id)).toEqual(['05000', '04999']);
  expect(rows.at(-1)?.id).toBe('04997');
});
