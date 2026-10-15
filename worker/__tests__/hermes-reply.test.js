import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('zca-js', () => ({ ThreadType: { User: 0, Group: 1 } }));
import { createHermesReplyRunner, privateReplyReceipt } from '../lib/hermes-reply.js';

const id = n => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const source = { accountId: id('1'), organizationId: id('2'), instanceId: id('3'), generation: id('4'), accountOwnerId: id('5'), ownUid: '123', loginRequestedAt: null };
const DELIVERY = id('6'), COMMAND = id('7');
const scope = () => ({ deliveryId: DELIVERY, commandId: COMMAND, accountId: source.accountId, organizationId: source.organizationId, generation: source.generation });
const claim = overrides => ({ status: 'claimed', ...scope(), recipientUid: '456', text: 'PRIVATE REPLY', expiresAt: Date.now() + 60000, ...overrides });
const result = data => ({ data, error: null, status: 200 });
const provider = () => ({ message: { msgId: 123456 }, attachment: [] });
const runners = [];
function fixture(options = {}) {
  let active = true, current = { ...source };
  const rpc = vi.fn(async q => result(q.args.p.operation === 'claim' ? claim() : { status: q.args.p.operation === 'dispatch' ? 'dispatched' : q.args.p.outcome, ...scope() }));
  const sendMessage = vi.fn(async () => provider());
  const runner = createHermesReplyRunner({ getSource: () => current, isActive: () => active, rpc, sendMessage, uuid: () => DELIVERY, ...options });
  runners.push(runner);
  return { runner, rpc, sendMessage, lose: () => { active = false; }, source: value => { current = value; } };
}
afterEach(() => { for (const runner of runners.splice(0)) runner.close(); vi.clearAllTimers(); vi.useRealTimers(); });

describe('zca-js single text receipt', () => {
  it('accepts a positive safe integer or decimal-string msgId; extra keys are ignored, attachment empty or absent', () => {
    expect(privateReplyReceipt(provider())).toBe('123456');
    expect(privateReplyReceipt({ message: { msgId: Number.MAX_SAFE_INTEGER }, attachment: [] })).toBe(String(Number.MAX_SAFE_INTEGER));
    // Runtime shape seen in production: stringified ID and additional keys.
    expect(privateReplyReceipt({ message: { msgId: '7312345678901' }, attachment: [] })).toBe('7312345678901');
    expect(privateReplyReceipt({ message: { msgId: 123, cliMsgId: 8 }, attachment: [], extra: true })).toBe('123');
    expect(privateReplyReceipt({ message: { msgId: '9'.repeat(25), cliMsgId: '8' } })).toBe('9'.repeat(25));
  });
  it.each([
    null, {}, { msgId: 123 }, { message: null, attachment: [] }, { message: {}, attachment: [] },
    { message: { msgId: Number.MAX_SAFE_INTEGER + 1 }, attachment: [] },
    { message: { msgId: 0 }, attachment: [] }, { message: { msgId: -1 }, attachment: [] }, { message: { msgId: 1.5 }, attachment: [] },
    { message: { msgId: '0' }, attachment: [] }, { message: { msgId: '-1' }, attachment: [] }, { message: { msgId: '012' }, attachment: [] },
    { message: { msgId: '12a' }, attachment: [] }, { message: { msgId: '' }, attachment: [] }, { message: { msgId: '1'.repeat(26) }, attachment: [] },
    { message: { msgId: '123\n' }, attachment: [] }, { message: { msgId: [123] }, attachment: [] },
    { message: { msgId: 123 }, attachment: [{ msgId: 456 }] }, { message: { msgId: 123 }, attachment: {} },
  ])('treats unsupported provider result %j as unknown', value => expect(privateReplyReceipt(value)).toBe(null));
  it('does not execute provider getters or accept decorated empty arrays', () => {
    const get = vi.fn(() => 123), value = { message: {}, attachment: [] };
    Object.defineProperty(value.message, 'msgId', { get, enumerable: true });
    expect(privateReplyReceipt(value)).toBe(null); expect(get).not.toHaveBeenCalled();
    const decorated = provider(); decorated.attachment.extra = 'PRIVATE'; expect(privateReplyReceipt(decorated)).toBe(null);
  });
});

describe('private reply runner', () => {
  it('claims, dispatches once, sends only DB-bound DM text, and records a fixed receipt', async () => {
    const f = fixture(); expect(await f.runner.tick()).toEqual({ status: 'sent' });
    expect(f.sendMessage).toHaveBeenCalledExactlyOnceWith({ msg: 'PRIVATE REPLY' }, '456', 0);
    expect(f.rpc.mock.calls.map(([q]) => q.functionName)).toEqual(Array(3).fill('hermes_zalo_private_reply_v1'));
    expect(f.rpc.mock.calls.map(([q]) => q.args.p)).toEqual([
      { operation: 'claim', ...source, deliveryId: DELIVERY },
      { operation: 'dispatch', ...source, deliveryId: DELIVERY },
      { operation: 'ack', ...source, deliveryId: DELIVERY, outcome: 'sent', providerMessageId: '123456' },
    ]);
    for (const [q] of f.rpc.mock.calls) { expect(Object.isFrozen(q.args.p)).toBe(true); expect(Object.isFrozen(q.args)).toBe(true); }
    expect(Object.isFrozen(f.sendMessage.mock.calls[0][0])).toBe(true);
  });
  it('starts one 5-second timer and does not poll when no ready source exists', async () => {
    vi.useFakeTimers(); const f = fixture(); f.source(null); f.runner.start(); f.runner.start();
    await vi.advanceTimersByTimeAsync(10000); expect(f.rpc).not.toHaveBeenCalled();
    f.source(source); f.rpc.mockResolvedValue(result({ status: 'empty' }));
    await vi.advanceTimersByTimeAsync(4999); expect(f.rpc).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(f.rpc).toHaveBeenCalledTimes(1);
    f.runner.close(); await vi.advanceTimersByTimeAsync(10000); expect(f.rpc).toHaveBeenCalledTimes(1);
  });
  it.each(['extra', 'missing', 'accessor', 'uuid', 'uid', 'login'])('rejects %s source without RPC or invoking a getter', async kind => {
    const get = vi.fn(() => source.generation), value = { ...source };
    if (kind === 'extra') value.userId = id('8');
    if (kind === 'missing') delete value.generation;
    if (kind === 'accessor') Object.defineProperty(value, 'generation', { get });
    if (kind === 'uuid') value.generation += '\n';
    if (kind === 'uid') value.ownUid += '\n';
    if (kind === 'login') value.loginRequestedAt = 'invalid';
    const f = fixture({ getSource: () => value }); expect(await f.runner.tick()).toEqual({ status: 'inactive' });
    expect(f.rpc).not.toHaveBeenCalled(); expect(f.sendMessage).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled();
  });
  it.each([
    { status: 'sent' }, { accountId: id('8') }, { organizationId: id('8') }, { generation: id('8') },
    { deliveryId: id('8') }, { commandId: 'bad' }, { recipientUid: '123' }, { recipientUid: '456\n' },
    { text: '' }, { text: '\0' }, { text: 'ễ'.repeat(12000) }, { expiresAt: 1 }, { userId: id('8') },
  ])('rejects malformed/cross-scope claim case %# before dispatch or send', async override => {
    const f = fixture(); f.rpc.mockResolvedValue(result(claim(override)));
    await vi.waitFor(async () => expect(await f.runner.tick()).toEqual({ status: 'outcome_unknown' }));
    expect(await f.runner.tick()).toEqual({ status: 'outcome_unknown' });
    expect(f.rpc).toHaveBeenCalledTimes(1); expect(f.sendMessage).not.toHaveBeenCalled();
  });
  it('rejects an accessor ACK without executing it', async () => {
    const get = vi.fn(() => 'PRIVATE'), ack = claim(); Object.defineProperty(ack, 'text', { get });
    const f = fixture(); f.rpc.mockResolvedValue(result(ack));
    expect(await f.runner.tick()).toEqual({ status: 'outcome_unknown' }); expect(get).not.toHaveBeenCalled(); expect(f.sendMessage).not.toHaveBeenCalled();
  });
  it.each([undefined, 201, 500])('does not interpret HTTP status %s as a definite admission', async status => {
    const f = fixture(); f.rpc.mockResolvedValue({ data: claim(), status });
    expect(await f.runner.tick()).toEqual({ status: 'outcome_unknown' }); expect(f.sendMessage).not.toHaveBeenCalled();
  });
  it('keeps definite denial separate from unknown and allows a later independent poll', async () => {
    const f = fixture(); f.rpc.mockResolvedValueOnce({ error: { code: '42501', message: 'PRIVATE' }, status: 403 });
    expect(await f.runner.tick()).toEqual({ status: 'denied' }); await Promise.resolve(); await Promise.resolve();
    expect(await f.runner.tick()).toEqual({ status: 'sent' }); expect(f.sendMessage).toHaveBeenCalledOnce();
  });
  it.each([{ status: 'already_dispatched' }, { commandId: id('8') }, { generation: id('8') }, { status: 'ready' }, { extra: true }])('does not send after dispatch ACK %j', async override => {
    const f = fixture(); f.rpc.mockResolvedValueOnce(result(claim())).mockResolvedValueOnce(result({ status: 'dispatched', ...scope(), ...override }));
    const output = await f.runner.tick(); expect(output.status).toBe(override.status === 'already_dispatched' ? 'already_dispatched' : 'outcome_unknown');
    expect(f.sendMessage).not.toHaveBeenCalled(); expect(f.rpc).toHaveBeenCalledTimes(2);
  });
  it('snapshots the claim before dispatch waits, so mutation cannot redirect content or recipient', async () => {
    const ack = claim(); let release;
    const f = fixture(); f.rpc.mockResolvedValueOnce(result(ack)).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = f.runner.tick(); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    ack.text = 'tampered'; ack.recipientUid = '789'; release(result({ status: 'dispatched', ...scope() }));
    expect(await pending).toEqual({ status: 'sent' }); expect(f.sendMessage).toHaveBeenCalledExactlyOnceWith({ msg: 'PRIVATE REPLY' }, '456', 0);
  });
  it.each(['claim', 'dispatch'])('retains a timed-out %s slot until the ignored abort settles and never retries admission', async phase => {
    vi.useFakeTimers(); let settle, signal;
    const f = fixture({ rpcTimeoutMs: 20 });
    const delay = q => { signal = q.signal; return new Promise(resolve => { settle = resolve; }); };
    if (phase === 'claim') f.rpc.mockImplementationOnce(delay);
    else f.rpc.mockResolvedValueOnce(result(claim())).mockImplementationOnce(delay);
    const pending = f.runner.tick(); await vi.advanceTimersByTimeAsync(21);
    expect(await pending).toEqual({ status: 'outcome_unknown' }); expect(signal.aborted).toBe(true);
    expect(await f.runner.tick()).toEqual({ status: 'busy' });
    settle(result(phase === 'claim' ? claim() : { status: 'dispatched', ...scope() })); await vi.advanceTimersByTimeAsync(0);
    expect(await f.runner.tick()).toEqual({ status: 'outcome_unknown' }); expect(f.sendMessage).not.toHaveBeenCalled();
    expect(f.rpc).toHaveBeenCalledTimes(phase === 'claim' ? 1 : 2);
  });
  it.each(['claim', 'dispatch'])('close aborts pending %s, ignores its late ACK, and never starts a send', async phase => {
    let settle, signal; const f = fixture();
    const delay = q => { signal = q.signal; return new Promise(resolve => { settle = resolve; }); };
    if (phase === 'claim') f.rpc.mockImplementationOnce(delay);
    else f.rpc.mockResolvedValueOnce(result(claim())).mockImplementationOnce(delay);
    const pending = f.runner.tick(); await vi.waitFor(() => expect(settle).toBeTypeOf('function'));
    f.runner.close(); expect(signal.aborted).toBe(true); expect(await pending).toEqual({ status: 'outcome_unknown' });
    settle(result(phase === 'claim' ? claim() : { status: 'dispatched', ...scope() }));
    expect(f.sendMessage).not.toHaveBeenCalled();
  });
  it.each(['generation', 'lease'])('source %s loss after a definite dispatch records unknown without calling the provider', async change => {
    const f = fixture(); f.rpc.mockResolvedValueOnce(result(claim())).mockImplementationOnce(() => {
      if (change === 'generation') f.source({ ...source, generation: id('8') }); else f.lose();
      return result({ status: 'dispatched', ...scope() });
    });
    expect(await f.runner.tick()).toEqual({ status: 'unknown' }); expect(f.sendMessage).not.toHaveBeenCalled();
    expect(f.rpc.mock.calls[2][0].args.p).toEqual({ operation: 'ack', ...source, deliveryId: DELIVERY, outcome: 'unknown', providerMessageId: null });
  });
  it('losing source after claim cancels metadata without dispatch or provider use', async () => {
    const f = fixture(); f.rpc.mockImplementationOnce(() => { f.source(null); return result(claim()); });
    expect(await f.runner.tick()).toEqual({ status: 'cancelled' }); expect(f.sendMessage).not.toHaveBeenCalled();
    expect(f.rpc.mock.calls.map(([q]) => q.args.p.operation)).toEqual(['claim', 'ack']);
  });
  it('closing after provider invocation permits settlement of only the old receipt', async () => {
    let settle; const f = fixture(); f.sendMessage.mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
    const pending = f.runner.tick(); await vi.waitFor(() => expect(settle).toBeTypeOf('function'));
    f.runner.close(); f.source({ ...source, generation: id('8') }); settle(provider());
    expect(await pending).toEqual({ status: 'sent' }); expect(f.sendMessage).toHaveBeenCalledOnce();
    expect(f.rpc.mock.calls[2][0].args.p.generation).toBe(source.generation);
    await Promise.resolve(); await Promise.resolve(); expect(await f.runner.tick()).toEqual({ status: 'inactive' });
  });
  it('holds a timed-out provider slot until real settlement and never resends a late success', async () => {
    vi.useFakeTimers(); let settle; const f = fixture({ providerTimeoutMs: 20 });
    f.sendMessage.mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
    const pending = f.runner.tick(); await vi.advanceTimersByTimeAsync(21);
    expect(await pending).toEqual({ status: 'unknown' }); expect(await f.runner.tick()).toEqual({ status: 'busy' });
    expect(f.rpc.mock.calls[2][0].args.p.outcome).toBe('unknown'); settle(provider()); await vi.advanceTimersByTimeAsync(0);
    f.rpc.mockResolvedValueOnce(result({ status: 'empty' })); expect(await f.runner.tick()).toEqual({ status: 'empty' });
    expect(f.sendMessage).toHaveBeenCalledOnce(); expect(f.rpc.mock.calls.filter(([q]) => q.args.p.operation === 'ack')).toHaveLength(1);
  });
  it.each(['throw', 'reject', 'unsupported'])('provider %s yields unknown without exposing raw failure or retrying', async kind => {
    const f = fixture();
    if (kind === 'throw') f.sendMessage.mockImplementationOnce(() => { throw new Error('PRIVATE credential text'); });
    if (kind === 'reject') f.sendMessage.mockRejectedValueOnce(new Error('PRIVATE credential text'));
    if (kind === 'unsupported') f.sendMessage.mockResolvedValueOnce({ msgId: '123' });
    expect(await f.runner.tick()).toEqual({ status: 'unknown' }); expect(f.sendMessage).toHaveBeenCalledOnce();
    expect(f.rpc.mock.calls.at(-1)[0].args.p).toMatchObject({ outcome: 'unknown', providerMessageId: null });
  });
  it('records a stringified runtime msgId as sent and reports an unrecognized receipt only as a redacted shape', async () => {
    const faults = [], f = fixture({ onFault: code => faults.push(code) });
    f.sendMessage.mockResolvedValueOnce({ message: { msgId: '7312345678901', cliMsgId: 'x' }, attachment: [] });
    expect(await f.runner.tick()).toEqual({ status: 'sent' });
    expect(f.rpc.mock.calls.at(-1)[0].args.p).toMatchObject({ outcome: 'sent', providerMessageId: '7312345678901' });
    expect(faults).toEqual([]);
    const g = fixture({ onFault: code => faults.push(code) });
    g.sendMessage.mockResolvedValueOnce({ message: { msgId: 'PRIVATE TEXT 0912345678', body: 'PRIVATE REPLY' }, attachment: [] });
    expect(await g.runner.tick()).toEqual({ status: 'unknown' });
    expect(faults).toEqual(['private_reply_receipt_unrecognized {message:{msgId:string,body:string},attachment:array(0)}']);
    expect(faults.join()).not.toMatch(/PRIVATE|0912/);
  });
  it('ack timeout never causes another send and close does not abort receipt recording', async () => {
    vi.useFakeTimers(); let settle, signal; const f = fixture({ rpcTimeoutMs: 20 });
    f.rpc.mockResolvedValueOnce(result(claim())).mockResolvedValueOnce(result({ status: 'dispatched', ...scope() }))
      .mockImplementationOnce(q => { signal = q.signal; return new Promise(resolve => { settle = resolve; }); });
    const pending = f.runner.tick(); await vi.advanceTimersByTimeAsync(0); f.runner.close(); expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(21); expect(await pending).toEqual({ status: 'outcome_unknown' });
    expect(await f.runner.tick()).toEqual({ status: 'busy' }); settle(result({ status: 'sent', ...scope() })); await vi.advanceTimersByTimeAsync(0);
    expect(f.sendMessage).toHaveBeenCalledOnce(); expect(f.rpc).toHaveBeenCalledTimes(3);
  });
  it.each([{ status: 'unknown' }, { commandId: id('8') }, { accountId: id('8') }, { extra: true }])('rejects a mismatched receipt ACK %j without retry', async override => {
    const f = fixture(); f.rpc.mockResolvedValueOnce(result(claim())).mockResolvedValueOnce(result({ status: 'dispatched', ...scope() }))
      .mockResolvedValueOnce(result({ status: 'sent', ...scope(), ...override }));
    expect(await f.runner.tick()).toEqual({ status: 'outcome_unknown' }); expect(f.sendMessage).toHaveBeenCalledOnce();
  });
});
