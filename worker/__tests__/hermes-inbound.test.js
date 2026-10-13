import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('zca-js', () => ({ ThreadType: { User: 0, Group: 1 } }));
const state = vi.hoisted(() => ({ rows: [], writes: [], logs: [], fail: false, onInsert: null, active: true, rpcCalls: [], registerWait: null, rpcReply: null, privacy: 'shared', replyCalls: [], replyRpc: null }));
vi.mock('../lib/ctx.js', () => ({
  log: (...args) => state.logs.push(args), orgOf: () => '22222222-2222-4222-8222-222222222222',
  notifyPush: vi.fn(), sessions: new Map(), chunk: rows => [rows],
  sb: { rpc: (name, args) => {
    if (name === 'hermes_zalo_private_reply_v1') {
      state.replyCalls.push(args.p);
      return { abortSignal: signal => state.replyRpc ? state.replyRpc(args.p, signal) : Promise.resolve({ data: { status: 'empty' }, error: null, status: 200 }) };
    }
    if (!['hermes_zalo_ingress_v1','hermes_zalo_private_command_v1'].includes(name)) return Promise.resolve({ data: 0 });
    state.rpcCalls.push(args.p);
    return { abortSignal: signal => state.rpcReply ? state.rpcReply(args.p, signal) : state.registerWait ? state.registerWait(signal) : Promise.resolve({
      data: args.p.operation === 'register' ? { status: 'registered', accountId: args.p.accountId, organizationId: args.p.organizationId, generation: '55555555-5555-4555-8555-555555555555' }
        : args.p.operation === 'privacy' ? { status: state.privacy, accountId: args.p.accountId, organizationId: args.p.organizationId } : { status: 'observed' },
    }) };
  }, from: table => {
    let rows = [], patch;
    const q = {
      select: () => q, eq: () => q, lt: () => q, not: () => q, neq: () => q, delete: () => q,
      update: value => { patch = value; return q; },
      upsert: value => { rows = Array.isArray(value) ? value : [value]; return q; },
      maybeSingle: async () => ({ data: { id: 'conv', unread_count: 0 }, error: null }),
      then: (resolve, reject) => {
        state.writes.push({ table, rows, patch });
        if (table === 'zalo_messages' && state.fail) return Promise.resolve({ data: null, error: { message: 'fixture database error' } }).then(resolve, reject);
        const inserted = [];
        for (const row of rows) if (!state.rows.some(r => r.zalo_msg_id === row.zalo_msg_id)) {
          state.rows.push(row); inserted.push({ id: 'db-' + row.zalo_msg_id });
        }
        if (table === 'zalo_messages') state.onInsert?.();
        return Promise.resolve({ data: inserted, error: null }).then(resolve, reject);
      },
    }; return q;
  } },
}));
vi.mock('../lib/auto-reply.js', () => ({ xuLyTinDen: vi.fn(async () => {}) }));
vi.mock('../lib/lease.js', () => ({ INSTANCE_ID: '33333333-3333-4333-8333-333333333333', isLeaseActive: () => state.active }));
import { notifyPush, sessions } from '../lib/ctx.js';
import { xuLyTinDen } from '../lib/auto-reply.js';
import { attachSession, handleInbound, handleOldMessages, classifyMessage, rawSubset } from '../lib/inbound.js';
import { stopAccountSession } from '../lib/session-lifecycle.js';
import { createHermesIngress, HERMES_LINK_REDACTED } from '../lib/hermes-link.js';

const account = '11111111-1111-4111-8111-111111111111', owner = '44444444-4444-4444-8444-444444444444';
const org = '22222222-2222-4222-8222-222222222222', instance = '33333333-3333-4333-8333-333333333333';
const secret = 'hz_' + 'a'.repeat(64);
const message = () => ({ type: 0, isSelf: false, threadId: '456', data: { uidFrom: '456', idTo: '123', msgId: 'm1', msgType: 'webchat', content: '/hermes-link ' + secret, ts: Date.now() } });
beforeEach(() => { state.rows = []; state.writes = []; state.logs = []; state.fail = false; state.onInsert = null; state.active = true; state.rpcCalls = []; state.registerWait = null; state.rpcReply = null; state.privacy = 'shared'; state.replyCalls = []; state.replyRpc = null; vi.clearAllMocks(); });
afterEach(() => { for (const key of sessions.keys()) stopAccountSession(key, sessions); vi.clearAllTimers(); vi.useRealTimers(); });
async function fixture() {
  let active = true;
  const rpc = vi.fn(async q => q.args.p.operation === 'register'
    ? { data: { status: 'registered', accountId: account, organizationId: org, generation: '55555555-5555-4555-8555-555555555555' } }
    : { data: { status: 'observed' } });
  const ingress = createHermesIngress({ source: { accountId: account, organizationId: org, instanceId: instance, accountOwnerId: owner, ownUid: '123', loginRequestedAt: null }, rpc, isActive: () => active });
  await ingress.register();
  return { ingress, rpc, expire: () => { active = false; }, receive: m => handleInbound(account, owner, m, null, { ingress, ticket: ingress.capture(m) }) };
}

describe('worker Hermes handshake integration', () => {
  it('persists a redacted identity row before observing and suppresses push/auto-reply', async () => {
    const f = await fixture(); let persistedAtObserve = false;
    f.rpc.mockImplementationOnce(async () => { persistedAtObserve = state.rows.length === 1; return { data: { status: 'observed' } }; });
    await f.receive(message());
    expect(persistedAtObserve).toBe(true); expect(f.rpc).toHaveBeenCalledTimes(2);
    expect(state.rows[0]).toMatchObject({ body: HERMES_LINK_REDACTED, zalo_raw: { uidFrom: '456', idTo: '123', msgType: 'webchat' } });
    expect(JSON.stringify([state.rows, state.writes, state.logs])).not.toContain(secret);
    expect(notifyPush).not.toHaveBeenCalled(); expect(xuLyTinDen).not.toHaveBeenCalled(); f.ingress.close();
  });
  it('cannot observe duplicate delivery or a persistence failure', async () => {
    const f = await fixture(); await f.receive(message()); await f.receive(message());
    expect(f.rpc).toHaveBeenCalledTimes(2);
    state.fail = true; const next = message(); next.data.msgId = 'm2'; await f.receive(next);
    expect(f.rpc).toHaveBeenCalledTimes(2); expect(xuLyTinDen).not.toHaveBeenCalled(); f.ingress.close();
  });
  it('rechecks the live lease after an asynchronous database insert', async () => {
    const f = await fixture(); state.onInsert = f.expire; await f.receive(message());
    expect(f.rpc).toHaveBeenCalledTimes(1); expect(xuLyTinDen).not.toHaveBeenCalled(); f.ingress.close();
  });
  it.each(['group', 'self', 'forward', 'malformed'])('redacts ineligible %s but never observes it', async kind => {
    const f = await fixture(), m = message();
    if (kind === 'group') m.type = 1;
    if (kind === 'self') m.isSelf = true;
    if (kind === 'forward') m.data.quote = { content: secret };
    if (kind === 'malformed') m.data.content += ' extra';
    await f.receive(m);
    expect(f.rpc).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([state.rows, state.writes, state.logs])).not.toContain(secret);
    expect(xuLyTinDen).not.toHaveBeenCalled(); f.ingress.close();
  });
  it('redacts offline/history backfills and never treats them as live ingress', async () => {
    await handleOldMessages(account, owner, [message()], 0);
    expect(state.rows).toHaveLength(1); expect(state.rows[0].body).toBe(HERMES_LINK_REDACTED);
    expect(JSON.stringify([state.rows, state.writes, state.logs])).not.toContain(secret);
    expect(xuLyTinDen).not.toHaveBeenCalled(); expect(notifyPush).not.toHaveBeenCalled();
  });
  it('classifier and raw projection cannot bypass redaction of quoted/caption codes', () => {
    const m = message(); m.data.content = { title: secret, href: 'https://invalid.test/' + secret }; m.data.msgType = 'chat.photo';
    expect(classifyMessage(m).body).toBe(HERMES_LINK_REDACTED);
    expect(JSON.stringify([classifyMessage(m), rawSubset(m)])).not.toContain(secret);
  });
  it('continues normal inbound notifications and auto-replies for ordinary messages', async () => {
    const m = message(); m.data.content = 'Hello'; await handleInbound(account, owner, m, null, { ingress: { privacy: async () => ({ status: 'shared' }) } });
    expect(state.rows[0].body).toBe('Hello'); expect(notifyPush).toHaveBeenCalledTimes(1); expect(xuLyTinDen).toHaveBeenCalledTimes(1);
  });
});

function listenerFixture() {
  const handlers = new Map();
  const api = {
    getOwnId: async () => '123', getAllFriends: async () => [], getAllGroups: async () => ({ gridVerMap: {} }), getLabels: async () => ({ labelData: [] }),
    sendMessage: vi.fn(async () => ({ message: { msgId: 987654 }, attachment: [] })),
    listener: { on: (kind, handler) => handlers.set(kind, handler), start: vi.fn(), stop: vi.fn(), requestOldMessages: vi.fn() },
  };
  return { api, emit: (kind, ...args) => handlers.get(kind)?.(...args) };
}
describe('actual attached Zalo listener boundary', () => {
  it('polls private replies with the existing API and suppresses provider self echo before shared writes', async () => {
    vi.useFakeTimers(); const f = listenerFixture(); state.privacy = 'private';
    const commandId = '66666666-6666-4666-8666-666666666666';
    state.replyRpc = p => ({ error: null, status: 200, data: {
      status: p.operation === 'claim' ? 'claimed' : p.operation === 'dispatch' ? 'dispatched' : p.outcome,
      deliveryId: p.deliveryId, commandId, accountId: p.accountId, organizationId: p.organizationId, generation: p.generation,
      ...(p.operation === 'claim' ? { recipientUid: '456', text: 'PRIVATE_HERMES_RESULT', expiresAt: Date.now() + 60000 } : {}),
    } });
    await attachSession(account, owner, f.api, { loginRequestedAt: '2026-10-12T17:00:00Z' });
    expect(f.api.sendMessage).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(5000);
    expect(f.api.sendMessage).toHaveBeenCalledExactlyOnceWith({ msg: 'PRIVATE_HERMES_RESULT' }, '456', 0);
    expect(state.replyCalls.map(p => p.operation)).toEqual(['claim', 'dispatch', 'ack']);
    expect(state.replyCalls[0]).toMatchObject({ accountId: account, organizationId: org, instanceId: instance, accountOwnerId: owner, ownUid: '123', loginRequestedAt: '2026-10-12T17:00:00Z' });
    const echo = message(); echo.isSelf = true; echo.data.uidFrom = '123'; echo.data.idTo = '456'; echo.data.content = 'PRIVATE_HERMES_RESULT'; echo.data.msgId = '987654';
    await f.emit('message', echo);
    expect(state.rows).toHaveLength(0); expect(state.writes.filter(w => ['zalo_messages','zalo_send_queue'].includes(w.table))).toHaveLength(0);
    expect(JSON.stringify(state.logs)).not.toContain('PRIVATE_HERMES_RESULT'); expect(notifyPush).not.toHaveBeenCalled(); expect(xuLyTinDen).not.toHaveBeenCalled();
  });
  it('closes the prior reply runner on replacement, listener errors and explicit teardown', async () => {
    vi.useFakeTimers(); const old = listenerFixture(), next = listenerFixture();
    await attachSession(account, owner, old.api); const oldRunner = sessions.get(account).hermesReply;
    await attachSession(account, owner, next.api); expect(await oldRunner.tick()).toEqual({ status: 'inactive' });
    await vi.advanceTimersByTimeAsync(5000); expect(state.replyCalls).toHaveLength(1);
    const currentRunner = sessions.get(account).hermesReply;
    await next.emit('error', new Error('transport closed')); expect(await currentRunner.tick()).toEqual({ status: 'inactive' });
    await vi.advanceTimersByTimeAsync(10000); expect(state.replyCalls).toHaveLength(1);
    stopAccountSession(account, sessions); expect(await currentRunner.tick()).toEqual({ status: 'inactive' });
  });
  it('logs only a fixed safe code for attached listener errors containing private text', async () => {
    vi.useFakeTimers(); const f = listenerFixture(), onClosed = vi.fn();
    await attachSession(account, owner, f.api, { onClosed });
    const runner = sessions.get(account).hermesReply;
    await f.emit('error', new Error('PRIVATE_PROVIDER_BODY: requested room and customer details'));
    expect(state.logs).toContainEqual(['listener error', account, 'transport_error']);
    expect(JSON.stringify(state.logs)).not.toContain('PRIVATE_PROVIDER_BODY');
    expect(onClosed).toHaveBeenCalledExactlyOnceWith(1006);
    expect(await runner.tick()).toEqual({ status: 'inactive' });
  });
  it('does not poll replies before denied registration recovers or after lease loss', async () => {
    vi.useFakeTimers(); const f = listenerFixture(); state.rpcReply = () => ({ error: { code: '42501' }, status: 403 });
    await attachSession(account, owner, f.api); await vi.advanceTimersByTimeAsync(5000); expect(state.replyCalls).toHaveLength(0);
    state.rpcReply = p => ({ data: p.operation === 'register' ? { status: 'registered', accountId: account, organizationId: org, generation: '55555555-5555-4555-8555-555555555555' } : { status: 'observed' } });
    await f.emit('message', message()); await vi.advanceTimersByTimeAsync(5000); expect(state.replyCalls).toHaveLength(1);
    state.active = false; await vi.advanceTimersByTimeAsync(10000); expect(state.replyCalls).toHaveLength(1); expect(f.api.sendMessage).not.toHaveBeenCalled();
  });
  it('queues a live private text with DB-derived authority without writing to the shared inbox or logging its text', async () => {
    const f = listenerFixture(); state.privacy = 'private';
    state.rpcReply = p => ({ data: p.operation === 'register'
      ? { status: 'registered', accountId: account, organizationId: org, generation: '55555555-5555-4555-8555-555555555555' }
      : p.operation === 'privacy' ? { status: 'private', accountId: account, organizationId: org }
        : { status: 'queued', commandId: '66666666-6666-4666-8666-666666666666', accountId: account, organizationId: org, providerMessageId: p.providerMessageId } });
    await attachSession(account, owner, f.api);
    const m = message(); m.data.content = 'PRIVATE_REQUEST: phòng trống';
    await f.emit('message', m);
    expect(state.rpcCalls.map(p => p.operation)).toEqual(['register','privacy','acceptPrivateCommand']);
    expect(state.rpcCalls[2]).toEqual({ operation: 'acceptPrivateCommand', accountId: account, organizationId: org, instanceId: instance,
      generation: '55555555-5555-4555-8555-555555555555', senderUid: '456', providerMessageId: 'm1', sentAt: m.data.ts, text: m.data.content });
    expect(state.rows).toHaveLength(0);
    expect(state.writes.filter(w => w.table === 'zalo_messages' || w.rows.length || Object.hasOwn(w.patch || {}, 'last_message_text'))).toEqual([]);
    expect(JSON.stringify(state.logs)).not.toContain('PRIVATE_REQUEST'); expect(state.logs).toContainEqual(['hermes private ingress','queued']);
    expect(notifyPush).not.toHaveBeenCalled(); expect(xuLyTinDen).not.toHaveBeenCalled();
  });
  it.each(['history','self','media','quote','invalid timestamp'])('never queues %s as a private command', async kind => {
    const f = listenerFixture(); state.privacy = 'private'; await attachSession(account, owner, f.api);
    const m = message(); m.data.content = 'PRIVATE_REJECT';
    if (kind === 'self') m.isSelf = true;
    if (kind === 'media') m.data.msgType = 'chat.photo';
    if (kind === 'quote') m.data.quote = { content: 'PRIVATE_QUOTE' };
    if (kind === 'invalid timestamp') m.data.ts = 'bad';
    await f.emit(kind === 'history' ? 'old_messages' : 'message', kind === 'history' ? [m] : m, 0);
    expect(state.rpcCalls.some(p => p.operation === 'acceptPrivateCommand')).toBe(false);
    expect(state.rows).toHaveLength(0); expect(JSON.stringify(state.logs)).not.toContain('PRIVATE_REJECT');
  });
  it('snapshots text before awaiting privacy, and fails closed on an intake transport error', async () => {
    const f = listenerFixture(); let settle;
    state.rpcReply = p => p.operation === 'register'
      ? { data: { status: 'registered', accountId: account, organizationId: org, generation: '55555555-5555-4555-8555-555555555555' } }
      : p.operation === 'privacy' ? new Promise(resolve => { settle = resolve; }) : Promise.reject(new Error('PRIVATE_TRANSPORT_BODY'));
    await attachSession(account, owner, f.api);
    const m = message(); m.data.content = 'PRIVATE_ORIGINAL';
    const pending = f.emit('message', m);
    await vi.waitFor(() => expect(settle).toBeTypeOf('function'));
    m.data.content = 'PRIVATE_MUTATED';
    settle({ data: { status: 'private', accountId: account, organizationId: org } }); await pending;
    expect(state.rpcCalls.find(p => p.operation === 'acceptPrivateCommand')?.text).toBe('PRIVATE_ORIGINAL');
    expect(state.rows).toHaveLength(0); expect(JSON.stringify(state.logs)).not.toContain('PRIVATE_');
    expect(state.logs).toContainEqual(['hermes private ingress','outcome_unknown']);
    expect(notifyPush).not.toHaveBeenCalled(); expect(xuLyTinDen).not.toHaveBeenCalled();
  });
  it('persists all nine ordinary DMs on an unconfigured account using one delayed privacy RPC, then reads the next batch afresh', async () => {
    vi.useFakeTimers(); const f = listenerFixture(); let settle;
    state.rpcReply = p => p.operation === 'register'
      ? { error: { code: '42501' }, status: 403 }
      : new Promise(resolve => { settle = resolve; });
    await attachSession(account, owner, f.api);
    const burst = Array.from({ length: 9 }, (_, i) => {
      const m = message(); m.data.msgId = `ordinary-${i}`; m.data.content = `Ordinary DM ${i}`;
      return f.emit('message', m);
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.rows).toHaveLength(0);
    expect(state.rpcCalls.map(p => p.operation)).toEqual(['register', 'privacy']);
    settle({ data: { status: 'shared', accountId: account, organizationId: org } });
    await Promise.all(burst);
    expect(state.rows.map(row => row.zalo_msg_id).sort()).toEqual(Array.from({ length: 9 }, (_, i) => `ordinary-${i}`));
    expect(notifyPush).toHaveBeenCalledTimes(9); expect(xuLyTinDen).toHaveBeenCalledTimes(9);
    const next = message(); next.data.msgId = 'next-batch'; next.data.content = 'PRIVATE_NEXT_BATCH';
    const pending = f.emit('message', next); await vi.advanceTimersByTimeAsync(0);
    expect(state.rpcCalls.map(p => p.operation)).toEqual(['register', 'privacy', 'privacy']);
    settle({ data: { status: 'private', accountId: account, organizationId: org } });
    await pending;
    expect(state.rows).toHaveLength(9);
    expect(JSON.stringify([state.rows, state.writes, state.logs])).not.toContain('PRIVATE_NEXT_BATCH');
  });
  it('links on the next eligible live handshake after bot enable without reattaching', async () => {
    vi.useFakeTimers(); const f = listenerFixture(); let enabled = false, settle;
    state.rpcReply = p => p.operation === 'register'
      ? enabled ? new Promise(resolve => { settle = resolve; }) : { error: { code: '42501' }, status: 403 }
      : { data: { status: 'observed' } };
    await attachSession(account, owner, f.api);
    enabled = true;
    const history = message(); history.data.msgId = 'history';
    await f.emit('old_messages', [history], 0);
    const forwarded = message(); forwarded.data.msgId = 'forwarded'; forwarded.data.forward = true;
    await f.emit('message', forwarded);
    expect(state.rpcCalls.map(p => p.operation)).toEqual(['register']);
    const pending = f.emit('message', message()); await vi.advanceTimersByTimeAsync(0);
    expect(state.rpcCalls.map(p => p.operation)).toEqual(['register', 'register']);
    expect(state.rows.map(row => row.zalo_msg_id)).not.toContain('m1');
    settle({ data: { status: 'registered', accountId: account, organizationId: org, generation: '66666666-6666-4666-8666-666666666666' } });
    await pending;
    expect(state.rpcCalls.map(p => p.operation)).toEqual(['register', 'register', 'observe']);
    expect(state.rpcCalls[2]).toMatchObject({ generation: '66666666-6666-4666-8666-666666666666', providerMessageId: 'm1' });
    expect(state.rows.find(row => row.zalo_msg_id === 'm1')?.body).toBe(HERMES_LINK_REDACTED);
    expect(f.api.listener.start).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([state.rows, state.writes, state.logs, state.rpcCalls])).not.toContain(secret);
    expect(notifyPush).not.toHaveBeenCalled(); expect(xuLyTinDen).not.toHaveBeenCalled();
  });
  it('keeps processing new handshakes after a fake valid-format challenge is rejected', async () => {
    vi.useFakeTimers(); const f = listenerFixture(); await attachSession(account, owner, f.api);
    let attempts = 0;
    state.rpcReply = () => ++attempts === 1 ? { error: { code: 'PT409' }, status: 409 } : { data: { status: 'observed' } };
    await f.emit('message', message());
    await f.emit('message', message());
    const next = message(); next.data.msgId = 'valid-next'; next.data.content = '/hermes-link hz_' + 'b'.repeat(64);
    await f.emit('message', next);
    expect(state.rpcCalls.map(p => p.operation)).toEqual(['register', 'observe', 'observe']);
    expect(state.rpcCalls[2]).toMatchObject({ generation: '55555555-5555-4555-8555-555555555555', providerMessageId: 'valid-next' });
    expect(state.rows).toHaveLength(2);
  });
  it.each(['lease lost', 'session closed'])('does not persist from the listener after %s during denied-registration recovery', async kind => {
    vi.useFakeTimers(); const f = listenerFixture(); let settle;
    state.rpcReply = () => ({ error: { code: '42501' }, status: 403 });
    await attachSession(account, owner, f.api);
    state.rpcReply = () => new Promise(resolve => { settle = resolve; });
    const pending = f.emit('message', message()); await vi.advanceTimersByTimeAsync(0);
    expect(state.rpcCalls).toHaveLength(2);
    if (kind === 'lease lost') state.active = false; else stopAccountSession(account, sessions);
    settle({ data: { status: 'registered', accountId: account, organizationId: org, generation: '55555555-5555-4555-8555-555555555555' } });
    await pending;
    expect(state.rows).toHaveLength(0);
    expect(state.rpcCalls.map(p => p.operation)).toEqual(['register', 'register']);
  });
  it.each(['text', 'self', 'media', 'quote'])('keeps private %s out of shared storage, preview, logs, push and auto-reply', async kind => {
    vi.useFakeTimers(); state.privacy = 'private'; const f = listenerFixture();
    await attachSession(account, owner, f.api);
    const m = message(); m.data.content = 'PRIVATE_COMMAND_CONTENT';
    if (kind === 'self') m.isSelf = true;
    if (kind === 'media') { m.data.msgType = 'chat.photo'; m.data.content = { title: 'PRIVATE_COMMAND_CONTENT', href: 'https://invalid.test/PRIVATE_COMMAND_CONTENT' }; }
    if (kind === 'quote') m.data.quote = { content: 'PRIVATE_COMMAND_CONTENT' };
    await f.emit('message', m);
    expect(state.rpcCalls.map(p => p.operation)).toEqual(kind === 'text' ? ['register', 'privacy', 'acceptPrivateCommand'] : ['register', 'privacy']);
    expect(state.rows).toHaveLength(0);
    // Login label sync can write independently; content and previews cannot.
    expect(state.writes.filter(w => w.table === 'zalo_messages' || w.rows.length || Object.hasOwn(w.patch || {}, 'last_message_text'))).toEqual([]);
    expect(JSON.stringify([state.rows, state.writes, state.logs, state.rpcCalls.filter(p => p.operation !== 'acceptPrivateCommand')])).not.toContain('PRIVATE_COMMAND_CONTENT');
    expect(notifyPush).not.toHaveBeenCalled(); expect(xuLyTinDen).not.toHaveBeenCalled();
  });
  it.each(['outcome_unknown','denied','overloaded','inactive','missing','throw'])('never falls back to the shared inbox on %s privacy', async status => {
    const ingress = status === 'missing' ? undefined : { privacy: async () => {
      if (status === 'throw') throw new Error('PRIVATE_COMMAND_CONTENT');
      return { status };
    } };
    const m = message(); m.data.content = 'PRIVATE_COMMAND_CONTENT';
    await handleInbound(account, owner, m, null, { ingress });
    expect(state.rows).toHaveLength(0); expect(state.writes).toHaveLength(0);
    expect(JSON.stringify(state.logs)).not.toContain('PRIVATE_COMMAND_CONTENT');
    expect(notifyPush).not.toHaveBeenCalled(); expect(xuLyTinDen).not.toHaveBeenCalled();
  });
  it('protects mixed historical DMs while still allowing the redacted linking identity row', async () => {
    vi.useFakeTimers(); state.privacy = 'private'; const f = listenerFixture();
    await attachSession(account, owner, f.api);
    const privateHistory = message(); privateHistory.data.msgId = 'private-history'; privateHistory.data.content = 'PRIVATE_HISTORY_CONTENT';
    const selfHistory = { ...privateHistory, isSelf: true, data: { ...privateHistory.data, msgId: 'private-self' } };
    await f.emit('old_messages', [privateHistory, message(), selfHistory], 0);
    expect(state.rows).toHaveLength(1); expect(state.rows[0].body).toBe(HERMES_LINK_REDACTED);
    expect(state.rpcCalls.map(p => p.operation)).toEqual(['register', 'privacy']);
    expect(JSON.stringify([state.rows, state.writes, state.logs, state.rpcCalls])).not.toContain('PRIVATE_HISTORY_CONTENT');
    expect(notifyPush).not.toHaveBeenCalled(); expect(xuLyTinDen).not.toHaveBeenCalled();
  });
  it('retains ordinary DMs only after a scoped shared decision, and leaves group ingestion independent', async () => {
    vi.useFakeTimers(); const f = listenerFixture(); await attachSession(account, owner, f.api);
    const dm = message(); dm.data.content = 'Ordinary DM'; await f.emit('message', dm);
    expect(state.rows[0].body).toBe('Ordinary DM'); expect(xuLyTinDen).toHaveBeenCalledTimes(1);
    state.privacy = 'private'; const group = message(); group.type = 1; group.data.msgId = 'group'; group.data.content = 'Group update';
    await f.emit('message', group);
    expect(state.rows.at(-1).body).toBe('Group update');
    expect(state.rpcCalls.filter(p => p.operation === 'privacy')).toHaveLength(1);
  });
  it('registers the login snapshot and only new live messages reach observe', async () => {
    vi.useFakeTimers(); const f = listenerFixture();
    await attachSession(account, owner, f.api, { loginRequestedAt: '2026-10-12T17:00:00Z' });
    expect(state.rpcCalls[0]).toEqual({ operation: 'register', accountId: account, organizationId: org, instanceId: instance, accountOwnerId: owner, ownUid: '123', loginRequestedAt: '2026-10-12T17:00:00Z' });
    const history = message(); history.data.msgId = 'history';
    await f.emit('old_messages', [history], 0); expect(state.rpcCalls).toHaveLength(1);
    await f.emit('message', history); expect(state.rpcCalls).toHaveLength(1);
    await f.emit('message', message()); expect(state.rpcCalls.map(p => p.operation)).toEqual(['register', 'observe']);
    expect(JSON.stringify([state.rows, state.writes, state.logs])).not.toContain(secret);
  });
  it('blocks old listeners after replacement and stops receiving after lease loss', async () => {
    vi.useFakeTimers(); const old = listenerFixture(), next = listenerFixture();
    await attachSession(account, owner, old.api); await attachSession(account, owner, next.api);
    await old.emit('message', message()); expect(state.rows).toHaveLength(0);
    state.active = false; await next.emit('message', message()); expect(state.rows).toHaveLength(0);
    expect(state.rpcCalls.map(p => p.operation)).toEqual(['register', 'register']);
  });
  it('teardown aborts registration and a late acknowledgment cannot start its listener', async () => {
    vi.useFakeTimers(); const f = listenerFixture(); let signal, settle;
    state.registerWait = s => { signal = s; return new Promise(resolve => { settle = resolve; }); };
    const pending = attachSession(account, owner, f.api);
    await vi.advanceTimersByTimeAsync(0); expect(signal).toBeDefined();
    stopAccountSession(account, sessions); await pending; expect(signal.aborted).toBe(true);
    settle({ data: { status: 'registered', accountId: account, organizationId: org, generation: '55555555-5555-4555-8555-555555555555' } });
    await vi.advanceTimersByTimeAsync(0); expect(f.api.listener.start).not.toHaveBeenCalled();
  });
});
