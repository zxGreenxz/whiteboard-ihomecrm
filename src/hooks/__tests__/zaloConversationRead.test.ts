import { expect, it, vi } from 'vitest';
import type { ZaloConversation, ZaloLabel } from '@/components/chat-zalo/types';
const mock = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], select: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({ useQuery: (query: unknown) => query }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ organization: { id: 'org-a' } }) }));
vi.mock('@/integrations/supabase/client', () => {
  const q = { select: (columns: string) => { mock.select(columns); return q; }, eq: () => q, order: () => q, limit: () => Promise.resolve({ data: mock.rows, error: null }), then: (resolve: (value: unknown) => unknown) => Promise.resolve(resolve({ data: mock.rows, error: null })) };
  return { supabase: { from: () => q } };
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
