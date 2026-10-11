import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ rows: new Map() }));
vi.mock('../lib/ctx.js', () => ({
  log: () => {}, orgOf: () => 'org', notifyPush: vi.fn(), sessions: new Map(),
  chunk: (rows) => [rows],
  sb: { from: (table) => {
    if (table === 'zalo_messages') return { upsert: async (rows, options) => {
      for (const row of rows) {
        if (!state.rows.has(row.zalo_msg_id) || !options.ignoreDuplicates) state.rows.set(row.zalo_msg_id, row);
      }
      return { error: null };
    } };
    const query = { select: () => query, eq: () => query, lt: () => query,
      update: () => query, then: resolve => Promise.resolve({ error: null }).then(resolve),
      maybeSingle: async () => ({ data: { id: 'conv' }, error: null }) };
    return query;
  } },
}));
vi.mock('../lib/auto-reply.js', () => ({ xuLyTinDen: vi.fn() }));
import { upsertMessagesForThread } from '../lib/inbound.js';

beforeEach(() => state.rows.clear());
describe('history sync', () => {
  it('retains hosted media and seen status when the same Zalo id is replayed', async () => {
    const existing = { zalo_msg_id: 'z1', status: 'seen', media_url: 'https://storage.test/owned', media_meta: { bucket: 'zalo-media', path: 'account/owned' } };
    state.rows.set('z1', existing);
    await upsertMessagesForThread('account', 'owner', 'thread', 'user', [{
      isSelf: true, data: { msgId: 'z1', ts: 1000, msgType: 'chat.photo', content: { href: 'https://cdn.test/expiring' } },
    }]);
    expect(state.rows.get('z1')).toEqual(existing);
  });
  it('still inserts a previously unseen historical message', async () => {
    await upsertMessagesForThread('account', 'owner', 'thread', 'user', [{
      isSelf: false, data: { msgId: 'new', ts: 1000, msgType: 'webchat', content: 'hello' },
    }]);
    expect(state.rows.get('new')).toMatchObject({ body: 'hello', direction: 'in', status: 'delivered' });
  });
});
