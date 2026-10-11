import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('zca-js', () => ({ ThreadType: { User: 0, Group: 1 } }));

const state = vi.hoisted(() => ({ messages: [] }));
vi.mock('../lib/ctx.js', () => ({
  log: () => {}, orgOf: () => 'org', notifyPush: vi.fn(), sessions: new Map(), chunk: rows => [rows],
  sb: { from: table => {
    const filters = [];
    let patch;
    let inserted;
    const matches = row => filters.every(([key, value]) => row[key] === value);
    const q = {
      select: () => q, order: () => q, limit: () => q, gte: () => q,
      eq: (key, value) => { filters.push([key, value]); return q; },
      is: (key, value) => { filters.push([key, value]); return q; },
      update: value => { patch = value; return q; },
      upsert: (row, options) => {
        const existing = state.messages.find(message => message.zalo_msg_id === row.zalo_msg_id);
        inserted = existing ? null : { id: `echo-${row.zalo_msg_id}`, ...row };
        if (inserted) state.messages.push(inserted);
        else if (!options.ignoreDuplicates) Object.assign(existing, row);
        return q;
      },
      maybeSingle: async () => ({ data: table === 'zalo_conversations'
        ? { id: 'conv', unread_count: 0 } : state.messages.find(matches), error: null }),
      then: (resolve, reject) => {
        if (patch && table === 'zalo_messages') state.messages.filter(matches).forEach(row => Object.assign(row, patch));
        return Promise.resolve({ data: inserted ? [{ id: inserted.id }] : [], error: null }).then(resolve, reject);
      },
    };
    return q;
  } },
}));
vi.mock('../lib/auto-reply.js', () => ({ xuLyTinDen: vi.fn() }));
import { handleInbound } from '../lib/inbound.js';

const pending = (id, extra = {}) => ({
  id, account_id: 'account', organization_id: 'org', conversation_id: 'conv',
  direction: 'out', status: 'pending', msg_type: 'image', zalo_msg_id: null,
  created_at: new Date().toISOString(), media_url: `https://storage.test/${id}`, ...extra,
});
beforeEach(() => { state.messages.length = 0; });

describe('self-listen echoes use exact provider identity', () => {
  it('does not attach the second album echo to the oldest pending image', async () => {
    state.messages.push(pending('first'), pending('second'));
    await handleInbound('account', 'owner', { isSelf: true, threadId: 'thread', data: {
      msgId: 'provider-second', msgType: 'chat.photo', content: { href: 'https://cdn.test/second' },
    } });
    expect(state.messages.find(row => row.id === 'first')).toMatchObject({ status: 'pending', zalo_msg_id: null, media_url: 'https://storage.test/first' });
    expect(state.messages.find(row => row.id === 'second')).toMatchObject({ status: 'pending', zalo_msg_id: null });
    expect(state.messages.find(row => row.zalo_msg_id === 'provider-second')).toMatchObject({ id: 'echo-provider-second', status: 'sent' });
  });
  it('does not claim a phone message with the same text as a pending web send', async () => {
    state.messages.push(pending('web', { msg_type: 'text', body: 'Cùng nội dung' }));
    const echo = { isSelf: true, threadId: 'thread', data: { msgId: 'phone-id', msgType: 'webchat', content: 'Cùng nội dung' } };
    await handleInbound('account', 'owner', echo);
    await handleInbound('account', 'owner', echo);
    expect(state.messages.find(row => row.id === 'web')).toMatchObject({ status: 'pending', zalo_msg_id: null });
    expect(state.messages.filter(row => row.zalo_msg_id === 'phone-id')).toHaveLength(1);
    expect(state.messages.find(row => row.zalo_msg_id === 'phone-id').id).toBe('echo-phone-id');
  });
});
