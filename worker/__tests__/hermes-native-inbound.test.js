import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
vi.mock('zca-js', () => ({ ThreadType: { User: 0, Group: 1 } }));
const state = vi.hoisted(() => ({ active: true, writes: [], rpc: [], logs: [], allowLink: false }));
vi.mock('../lib/ctx.js', () => ({
  sessions: new Map(), orgOf: () => '33333333-3333-4333-8333-333333333333', chunk: rows => [rows],
  notifyPush: vi.fn(), log: (...args) => state.logs.push(args),
  sb: { rpc: (name, args) => { if (!args.p) return Promise.resolve({ data: 0 }); state.rpc.push([name, args]); return { abortSignal: () => Promise.resolve(state.allowLink
    ? { data: args.p.operation === 'register' ? { status: 'registered', accountId: args.p.accountId,
      organizationId: args.p.organizationId, generation: '66666666-6666-4666-8666-666666666666' } : { status: 'observed' }, error: null }
    : { error: { code: '42501' }, status: 403 }) }; },
    from: table => { const q = { select: () => q, eq: () => q, neq: () => q,
      update: patch => { state.writes.push({ table, patch }); return q; },
      upsert: rows => { state.writes.push({ table, rows }); return q; },
      maybeSingle: async () => ({ data: { id: 'conv', unread_count: 0 }, error: null }),
      then: resolve => Promise.resolve({ data: table === 'zalo_messages' ? [{ id: 'message-fixture' }] : [], error: null }).then(resolve) }; return q; } },
}));
vi.mock('../lib/auto-reply.js', () => ({ xuLyTinDen: vi.fn(async () => {}) }));
vi.mock('../lib/lease.js', () => ({ INSTANCE_ID: '44444444-4444-4444-8444-444444444444', isLeaseActive: () => state.active }));
import { startNativeBridge } from '../lib/hermes-native-bridge.js';
import { attachSession } from '../lib/inbound.js';
import { stopAccountSession } from '../lib/session-lifecycle.js';
import { sessions, notifyPush } from '../lib/ctx.js';
import { xuLyTinDen } from '../lib/auto-reply.js';

const accountId = '11111111-1111-4111-8111-111111111111';
const generation = '22222222-2222-4222-8222-222222222222';
afterEach(() => { for (const id of sessions.keys()) stopAccountSession(id, sessions); vi.clearAllTimers(); vi.useRealTimers(); });

it('actual listener uses native grant despite denied CRM, suppresses personal history/echo and closes on lease/session loss', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-native-caller-'));
  const token = 'hzn_' + 'c'.repeat(64), tokenFile = path.join(root, 'token');
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  // Reserve an ephemeral port first to avoid hard-coded developer ports.
  const http = await import('node:http'); const reserve = http.createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ version: 1, stateRoot: root, listenPort: port,
    channels: [{ accountId, generation, ownUid: '100', pairedUid: '200', mainUid: '200', profile: 'fixture-native', tokenFile }] }), { mode: 0o600 });
  const previous = process.env.HERMES_ZALO_NATIVE_CONFIG;
  process.env.HERMES_ZALO_NATIVE_CONFIG = configFile;
  const bridge = await startNativeBridge();
  async function request(route, body) {
    return (await fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) })).json();
  }
  try {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const handlers = new Map();
    const api = { getOwnId: async () => '100', getAllFriends: async () => [], getAllGroups: async () => ({ gridVerMap: {} }), getLabels: async () => ({ labelData: [] }),
      sendMessage: vi.fn(async () => ({ message: { msgId: 987654 }, attachment: [] })),
      listener: { on: (kind, handler) => handlers.set(kind, handler), start: vi.fn(), stop: vi.fn(), requestOldMessages: vi.fn() } };
    await attachSession(accountId, '55555555-5555-4555-8555-555555555555', api);
    expect(api.listener.start).toHaveBeenCalledTimes(1);
    expect(sessions.get(accountId).hermesReply).toBeUndefined();
    await sessions.get(accountId).hermesIngress.register();
    const m = { type: 0, isSelf: false, threadId: '200', data: { uidFrom: '200', idTo: '100', msgType: 'webchat', msgId: 'native1', content: 'PERSONAL_PRIVATE', ts: Date.now() } };
    const rpcBefore = state.rpc.length;
    await handlers.get('message')(m);
    vi.useRealTimers();
    expect((await request('/v1/receive', { generation })).event.text).toBe('PERSONAL_PRIVATE');
    expect((await request('/v1/send', { generation, requestId: 'native-reply', text: 'PERSONAL_REPLY' })).status).toBe('sent');
    expect(api.sendMessage).toHaveBeenCalledExactlyOnceWith({ msg: 'PERSONAL_REPLY' }, '200', 0);
    await handlers.get('old_messages')([m], 0);
    await handlers.get('message')({ ...m, isSelf: true, data: { ...m.data, uidFrom: '100', idTo: '200', content: 'PERSONAL_REPLY' } });
    expect(state.rpc.length).toBe(rpcBefore);
    expect(state.writes.filter(row => ['zalo_messages', 'zalo_send_queue'].includes(row.table))).toEqual([]);
    expect(JSON.stringify(state.writes)).not.toContain('PERSONAL');
    expect(JSON.stringify(state.logs)).not.toContain('PERSONAL');
    expect(notifyPush).not.toHaveBeenCalled(); expect(xuLyTinDen).not.toHaveBeenCalled();
    // A later CRM linking request must recover registration and persist only
    // redacted identity rows, while personal history remains outside the CRM.
    state.allowLink = true;
    const link = { ...m, data: { ...m.data, msgId: 'link-live', content: '/hermes-link hz_' + 'd'.repeat(64) } };
    await handlers.get('message')(link);
    expect(state.rpc.filter(([, args]) => args.p.operation === 'observe')).toHaveLength(1);
    expect((await request('/v1/receive', { generation })).status).toBe('empty');
    await handlers.get('old_messages')([m, { ...link, data: { ...link.data, msgId: 'link-history' } }], 0);
    const stored = state.writes.filter(row => row.table === 'zalo_messages').flatMap(row => row.rows);
    expect(stored).toHaveLength(2);
    expect(stored.every(row => row.body === '[Hermes link - hidden]')).toBe(true);
    expect(JSON.stringify([state.writes, state.logs])).not.toContain('hz_');
    expect(JSON.stringify(state.writes)).not.toContain('PERSONAL');
    expect(state.rpc.filter(([, args]) => args.p.operation === 'observe')).toHaveLength(1);
    state.active = false;
    await handlers.get('message')({ ...m, data: { ...m.data, msgId: 'after-lease-loss' } });
    expect((await request('/v1/send', { generation, requestId: 'late-reply', text: 'late' })).status).toBe('unavailable');
    stopAccountSession(accountId, sessions);
    expect((await request('/v1/channel', {})).connected).toBe(false);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  } finally {
    await bridge.close();
    if (previous === undefined) delete process.env.HERMES_ZALO_NATIVE_CONFIG; else process.env.HERMES_ZALO_NATIVE_CONFIG = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
