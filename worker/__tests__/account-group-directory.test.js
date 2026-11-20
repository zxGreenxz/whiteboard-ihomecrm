import { beforeEach, expect, it, vi } from 'vitest';
import { syncAccountGroups } from '../lib/inbound.js';

const { upsert } = vi.hoisted(() => ({ upsert: vi.fn() }));
vi.mock('zca-js', () => ({ ThreadType: { User: 0, Group: 1 } }));
vi.mock('../lib/ctx.js', () => ({
  sessions: new Map(), orgOf: () => 'org', log: vi.fn(), notifyPush: vi.fn(),
  chunk: (rows, n) => Array.from({ length: Math.ceil(rows.length / n) }, (_, i) => rows.slice(n * i, n * (i + 1))),
  sb: { from: table => { expect(table).toBe('zalo_conversations'); return { upsert }; } },
}));
vi.mock('../lib/auto-reply.js', () => ({ xuLyTinDen: vi.fn() }));

beforeEach(() => {
  upsert.mockReset().mockImplementation(rows => ({
    select: async () => ({ data: rows.map(row => ({ id: 'conv-' + row.thread_id, thread_id: row.thread_id })) }),
  }));
});

it('imports every group in batches for this account without a conversation or message', async () => {
  const ids = Array.from({ length: 123 }, (_, i) => String(i + 1));
  const api = {
    getAllGroups: async () => ({ gridVerMap: Object.fromEntries(ids.map(id => [id, 1])) }),
    getGroupInfo: vi.fn(async batch => ({ gridInfoMap: Object.fromEntries(batch.map(id => [id, { groupId: id, name: 'Nhóm ' + id }])) })),
  };
  await expect(syncAccountGroups(api, 'nick-a', 'owner', 'org')).resolves.toBe(123);
  expect(api.getGroupInfo.mock.calls.map(([batch]) => batch.length)).toEqual([50, 50, 23]);
  expect(upsert.mock.calls.flatMap(([rows]) => rows.map(row => row.thread_id))).toEqual(ids);
  for (const [rows, options] of upsert.mock.calls) {
    expect(options.onConflict).toBe('account_id,thread_id');
    for (const row of rows) {
      expect(row).toMatchObject({ organization_id: 'org', account_id: 'nick-a', user_id: 'owner', thread_type: 'group' });
      expect(row).not.toHaveProperty('last_message_at');
      expect(row).not.toHaveProperty('is_sale_partner');
    }
  }
});

it('reports a partial listing or failed write instead of a completed sync', async () => {
  const api = {
    getAllGroups: async () => ({ gridVerMap: { g1: 1, g2: 1 } }),
    getGroupInfo: async () => ({ gridInfoMap: { g1: { name: 'Nhóm 1' } } }),
  };
  await expect(syncAccountGroups(api, 'nick-a', 'owner', 'org')).rejects.toThrow('1/2 nhóm');
  upsert.mockReturnValue({ select: async () => ({ error: { message: 'offline' } }) });
  await expect(syncAccountGroups(api, 'nick-a', 'owner', 'org')).rejects.toThrow('offline');
  await expect(syncAccountGroups({ getAllGroups: async () => ({}) }, 'nick-a', 'owner', 'org')).rejects.toThrow('Zalo chưa trả về');
  await expect(syncAccountGroups({ getAllGroups: async () => ({ gridVerMap: {} }) }, 'nick-a', 'owner', 'org')).resolves.toBe(0);
});

it('keeps loading later batches when Zalo temporarily fails a batch', async () => {
  const ids = Array.from({ length: 51 }, (_, i) => String(i + 1));
  const api = {
    getAllGroups: async () => ({ gridVerMap: Object.fromEntries(ids.map(id => [id, 1])) }),
    getGroupInfo: vi.fn().mockRejectedValueOnce(new Error('busy')).mockResolvedValue({ gridInfoMap: { 51: { name: 'Last group' } } }),
  };
  await expect(syncAccountGroups(api, 'nick-a', 'owner', 'org')).rejects.toThrow('1/51 nhóm');
  expect(upsert.mock.calls[0][0][0].thread_id).toBe('51');
});
