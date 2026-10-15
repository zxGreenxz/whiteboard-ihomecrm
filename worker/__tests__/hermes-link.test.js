import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHermesIngress, HERMES_LINK_REDACTED, isHermesLinkMessage, prepareLiveLinkObservation, redactHermesLinkMessage } from '../lib/hermes-link.js';
import { prepareLivePrivateCommand } from '../lib/hermes-command.js';

const id = n => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const source = { accountId: id('1'), organizationId: id('2'), instanceId: id('3'), accountOwnerId: id('4'), ownUid: '123', loginRequestedAt: null };
const secret = 'hz_' + 'a'.repeat(64);
const event = () => ({ type: 0, isSelf: false, threadId: '456', data: { uidFrom: '456', idTo: '123', msgId: 'm-1', msgType: 'webchat', content: '/hermes-link ' + secret } });
const registered = () => ({ data: { status: 'registered', accountId: source.accountId, organizationId: source.organizationId, generation: id('5') }, error: null, status: 200 });
const observed = () => ({ data: { status: 'observed' }, error: null, status: 200 });
const privacyAck = status => ({ data: { status, accountId: source.accountId, organizationId: source.organizationId }, error: null, status: 200 });
const denied = () => ({ error: { code: '42501' }, status: 403 });
const nextEvent = msgId => { const m = event(); m.data.msgId = msgId; return m; };
function fixture(options = {}) {
  let active = true;
  const rpc = options.rpc ?? vi.fn(async q => q.args.p.operation === 'register' ? registered() : observed());
  const ingress = createHermesIngress({ source, rpc, isActive: () => active, ...options });
  return { ingress, rpc, expire: () => { active = false; } };
}
afterEach(() => vi.useRealTimers());

describe('private command transport on the pinned ingress', () => {
  it('exposes a frozen reply source only while the acknowledged ingress is ready and active', async () => {
    const f = fixture(); expect(f.ingress.privateReplySource()).toBe(null); await f.ingress.register();
    expect(f.ingress.privateReplySource()).toEqual({ ...source, generation: id('5') });
    expect(Object.isFrozen(f.ingress.privateReplySource())).toBe(true);
    f.expire(); expect(f.ingress.privateReplySource()).toBe(null); f.ingress.close(); expect(f.ingress.privateReplySource()).toBe(null);
  });
  const command = ingress => {
    const m=event(); m.data.content='PRIVATE_COMMAND'; m.data.ts=Date.now();
    return prepareLivePrivateCommand({event:m,source:ingress.privateCommandSource()});
  };
  const ack = (p, overrides={}) => ({ data: { status:'queued', commandId:id('6'), accountId:p.accountId,
    organizationId:p.organizationId, providerMessageId:p.providerMessageId,...overrides }, status:200 });
  it('uses a fixed private RPC and accepts only scoped queue receipts', async()=>{
    const f=fixture({rpc:vi.fn(async q=>q.args.p.operation==='register'?registered():ack(q.args.p))});
    expect(f.ingress.privateCommandSource()).toBe(null); await f.ingress.register();
    expect(Object.isFrozen(f.ingress.privateCommandSource())).toBe(true);
    expect(await f.ingress.acceptPrivateCommand(command(f.ingress))).toEqual({status:'queued',commandId:id('6')});
    expect(f.rpc.mock.calls[1][0].functionName).toBe('hermes_zalo_private_command_v1'); f.ingress.close();
  });
  it.each([{accountId:id('9')},{organizationId:id('9')},{providerMessageId:'foreign'},{status:'executed'},{text:'PRIVATE_LEAK'},{commandId:'bad'}])('rejects mismatched/extra ACK %j',async overrides=>{
    const f=fixture({rpc:async q=>q.args.p.operation==='register'?registered():ack(q.args.p,overrides)});
    await f.ingress.register(); expect(await f.ingress.acceptPrivateCommand(command(f.ingress))).toEqual({status:'outcome_unknown'}); f.ingress.close();
  });
  it('cannot change the pinned source or add caller-selected CRM authority',async()=>{
    const f=fixture(); await f.ingress.register(); const p=command(f.ingress);
    for(const change of [{generation:id('9')},{accountId:id('9')},{organizationId:id('9')},{instanceId:id('9')},{userId:id('9')},{senderUid:'123'}]) {
      expect(await f.ingress.acceptPrivateCommand({...p,...change})).toEqual({status:'inactive'});
    }
    expect(f.rpc).toHaveBeenCalledTimes(1); f.ingress.close();
    expect(f.ingress.privateCommandSource()).toBe(null); expect(await f.ingress.acceptPrivateCommand(p)).toEqual({status:'inactive'});
  });
  it('does not retry unknown writes and retains the admission slot until the transport settles',async()=>{
    vi.useFakeTimers(); let settle;
    const f=fixture({maxPending:1,timeoutMs:20,rpc:vi.fn(q=>q.args.p.operation==='register'?registered():new Promise(resolve=>{settle=resolve;}))});
    await f.ingress.register(); const p=command(f.ingress); const pending=f.ingress.acceptPrivateCommand(p);
    await vi.advanceTimersByTimeAsync(21); expect(await pending).toEqual({status:'outcome_unknown'});
    expect(await f.ingress.acceptPrivateCommand(p)).toEqual({status:'overloaded'}); expect(f.rpc).toHaveBeenCalledTimes(2);
    f.ingress.close(); settle(ack(p)); await vi.advanceTimersByTimeAsync(0); expect(f.rpc).toHaveBeenCalledTimes(2);
  });
  it('distinguishes a definite full queue from an unknown transport outcome',async()=>{
    const f=fixture({rpc:async q=>q.args.p.operation==='register'?registered():{error:{code:'PT429'},status:429}});
    await f.ingress.register(); expect(await f.ingress.acceptPrivateCommand(command(f.ingress))).toEqual({status:'overloaded'}); f.ingress.close();
  });
});

describe('Hermes link content protection', () => {
  it.each(['text', 'caption', 'quote', 'metadata', 'malformed', 'self', 'group'])('redacts %s without keeping the secret in raw metadata', kind => {
    const m = event();
    if (kind === 'caption') m.data.content = { title: 'attachment', description: secret };
    if (kind === 'quote') { m.data.quote = { content: secret }; m.data.content = 'reply'; }
    if (kind === 'metadata') { m.data.propertyExt = { log: secret }; m.data.content = 'reply'; }
    if (kind === 'malformed') m.data.content += ' org=another';
    if (kind === 'self') m.isSelf = true;
    if (kind === 'group') m.type = 1;
    expect(isHermesLinkMessage(m)).toBe(true);
    const redacted = redactHermesLinkMessage(m);
    expect(redacted.data.content).toBe(HERMES_LINK_REDACTED);
    expect(redacted.data).toMatchObject({ uidFrom: '456', idTo: '123', msgId: 'm-1' });
    expect(JSON.stringify(redacted)).not.toContain(secret);
    expect(redacted).not.toBe(m);
  });
  it('keeps ordinary messages and never executes nested accessors or follows cycles forever', () => {
    const m = event(); m.data.content = 'Rooms available'; m.data.loop = m.data;
    Object.defineProperty(m.data, 'danger', { get() { throw new Error('executed'); } });
    expect(redactHermesLinkMessage(m)).toBe(m);
  });
});

describe('Hermes ingress session lifecycle', () => {
  it('checks privacy using only pinned session identity even if bot registration is denied', async () => {
    const rpc = vi.fn(async q => q.args.p.operation === 'register' ? denied()
      : { data: { status: 'private', accountId: source.accountId, organizationId: source.organizationId } });
    const f = fixture({ rpc });
    expect(await f.ingress.register()).toEqual({ status: 'denied' });
    expect(await f.ingress.privacy()).toEqual({ status: 'private' });
    expect(rpc.mock.calls[1][0].args).toEqual({ p: { operation: 'privacy', ...source } });
    expect(f.ingress.capture(event())).toBe(null);
    f.ingress.close();
  });
  it.each(['shared','private'])('accepts only a current scoped %s privacy acknowledgment', async status => {
    const f = fixture({ rpc: async () => ({ data: { status, accountId: source.accountId, organizationId: source.organizationId } }) });
    expect(await f.ingress.privacy()).toEqual({ status });
    f.expire(); expect(await f.ingress.privacy()).toEqual({ status: 'inactive' });
    f.ingress.close();
  });
  it.each(['account', 'organization', 'extra', 'missing', 'unknown'])('cannot release a DM on a %s privacy response', async kind => {
    const data = { status: 'shared', accountId: source.accountId, organizationId: source.organizationId };
    if (kind === 'account') data.accountId = id('9');
    if (kind === 'organization') data.organizationId = id('9');
    if (kind === 'extra') data.body = 'PRIVATE_TEXT';
    if (kind === 'missing') delete data.accountId;
    if (kind === 'unknown') data.status = 'unavailable';
    const f = fixture({ rpc: async () => ({ data }) });
    expect(await f.ingress.privacy()).toEqual({ status: 'outcome_unknown' });
    f.ingress.close();
  });
  it('holds timed-out privacy admission and discards a late shared decision after session close', async () => {
    vi.useFakeTimers(); let settle;
    const rpc = vi.fn(() => new Promise(resolve => { settle = resolve; }));
    const f = fixture({ maxPending: 1, timeoutMs: 20, rpc });
    const pending = f.ingress.privacy(); await vi.advanceTimersByTimeAsync(21);
    expect(await pending).toEqual({ status: 'outcome_unknown' });
    expect(await f.ingress.privacy()).toEqual({ status: 'outcome_unknown' });
    expect(rpc).toHaveBeenCalledTimes(1);
    f.ingress.close();
    settle({ data: { status: 'shared', accountId: source.accountId, organizationId: source.organizationId } });
    await vi.advanceTimersByTimeAsync(1);
    expect(await f.ingress.privacy()).toEqual({ status: 'inactive' });
  });
  it('coalesces a privacy burst per pinned ingress and reads again after it settles', async () => {
    let settle;
    const rpc = vi.fn().mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }))
      .mockResolvedValue(privacyAck('private'));
    const f = fixture({ rpc });
    const burst = Array.from({ length: 9 }, () => f.ingress.privacy());
    await Promise.resolve();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0].args.p).toEqual({ operation: 'privacy', ...source });
    const other = fixture({ source: { ...source, accountId: id('9') }, rpc: vi.fn(async () => privacyAck('shared')) });
    expect(await other.ingress.privacy()).toEqual({ status: 'outcome_unknown' });
    expect(other.rpc).toHaveBeenCalledTimes(1);
    settle(privacyAck('shared'));
    expect(await Promise.all(burst)).toEqual(Array(9).fill({ status: 'shared' }));
    expect(await f.ingress.privacy()).toEqual({ status: 'private' });
    expect(rpc).toHaveBeenCalledTimes(2);
    f.ingress.close(); other.ingress.close();
  });
  it('keeps a timed-out privacy RPC admitted until settlement, then releases the slot for a fresh read', async () => {
    vi.useFakeTimers(); let settle;
    const rpc = vi.fn().mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }))
      .mockResolvedValue(privacyAck('private'));
    const f = fixture({ rpc, maxPending: 1, timeoutMs: 20 });
    const burst = Array.from({ length: 9 }, () => f.ingress.privacy());
    await vi.advanceTimersByTimeAsync(21);
    expect(await Promise.all(burst)).toEqual(Array(9).fill({ status: 'outcome_unknown' }));
    expect(await f.ingress.register()).toEqual({ status: 'overloaded' });
    expect(await f.ingress.privacy()).toEqual({ status: 'outcome_unknown' });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0].signal.aborted).toBe(true);
    settle(privacyAck('shared'));
    await vi.advanceTimersByTimeAsync(0);
    expect(await f.ingress.privacy()).toEqual({ status: 'private' });
    expect(rpc).toHaveBeenCalledTimes(2);
    f.ingress.close();
  });
  it.each(['lease lost', 'session closed'])('does not release any shared answer to a waiting burst after %s', async kind => {
    let settle;
    const f = fixture({ rpc: vi.fn(() => new Promise(resolve => { settle = resolve; })) });
    const burst = Array.from({ length: 9 }, () => f.ingress.privacy());
    await Promise.resolve();
    if (kind === 'lease lost') f.expire(); else f.ingress.close();
    settle(privacyAck('shared'));
    expect(await Promise.all(burst)).toEqual(Array(9).fill({ status: 'outcome_unknown' }));
    expect(await f.ingress.privacy()).toEqual({ status: 'inactive' });
    expect(f.rpc).toHaveBeenCalledTimes(1);
    f.ingress.close();
  });
  it('registers the pinned login once and observes a one-use ticket without plaintext', async () => {
    const f = fixture(); expect(f.ingress.capture(event())).toBe(null);
    expect(await f.ingress.register()).toEqual({ status: 'registered' });
    const ticket = f.ingress.capture(event());
    expect(await f.ingress.observe(ticket)).toEqual({ status: 'observed' });
    expect(await f.ingress.observe(ticket)).toEqual({ status: 'inactive' });
    expect(await f.ingress.observe({})).toEqual({ status: 'inactive' });
    expect(await f.ingress.register()).toEqual({ status: 'inactive' });
    expect(f.rpc).toHaveBeenCalledTimes(2);
    expect(f.rpc.mock.calls[1][0]).toMatchObject({ functionName: 'hermes_zalo_ingress_v1', args: { p: { generation: id('5'), senderUid: '456', providerMessageId: 'm-1' } } });
    expect(JSON.stringify(f.rpc.mock.calls)).not.toContain(secret);
    f.ingress.close();
  });
  it('pins configuration and rejects cross-company/malformed registration acknowledgments', async () => {
    const mutable = { ...source }; const f = fixture({ source: mutable }); mutable.organizationId = id('9');
    expect(await f.ingress.register()).toEqual({ status: 'registered' });
    expect(f.rpc.mock.calls[0][0].args.p.organizationId).toBe(source.organizationId);
    f.ingress.close();
    const rpc = vi.fn(async () => ({ ...registered(), data: { ...registered().data, organizationId: id('9') } }));
    const g = fixture({ rpc }); expect(await g.ingress.register()).toEqual({ status: 'outcome_unknown' });
    expect(g.ingress.capture(event())).toBe(null); expect(await g.ingress.register()).toEqual({ status: 'inactive' });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it.each(['lease lost', 'session closed'])('cannot observe after %s between persistence and dispatch', async kind => {
    const f = fixture(); await f.ingress.register(); const ticket = f.ingress.capture(event());
    if (kind === 'lease lost') f.expire(); else f.ingress.close();
    expect(await f.ingress.observe(ticket)).toEqual({ status: 'inactive' });
    expect(f.rpc).toHaveBeenCalledTimes(1); expect(f.ingress.capture(event())).toBe(null);
  });
  it('rejects a stale ticket even if its owning listener is still live', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.ingress.register(); const ticket = f.ingress.capture(event());
    await vi.advanceTimersByTimeAsync(30001);
    expect(await f.ingress.observe(ticket)).toEqual({ status: 'inactive' }); expect(f.rpc).toHaveBeenCalledTimes(1);
  });
  it('close aborts a pending registration and ignores its late acknowledgment', async () => {
    let settle; const rpc = vi.fn(() => new Promise(resolve => { settle = resolve; }));
    const f = fixture({ rpc }); const pending = f.ingress.register(); await Promise.resolve();
    f.ingress.close(); expect(await pending).toEqual({ status: 'inactive' });
    expect(rpc.mock.calls[0][0].signal.aborted).toBe(true);
    settle(registered()); await Promise.resolve(); expect(f.ingress.capture(event())).toBe(null);
  });
  it('a timed-out write retains admission until the dependency settles and is never retried', async () => {
    vi.useFakeTimers(); let settle;
    const rpc = vi.fn(q => q.args.p.operation === 'register' ? registered() : new Promise(resolve => { settle = resolve; }));
    const f = fixture({ rpc, timeoutMs: 20, maxPending: 1 }); await f.ingress.register();
    const ticket = f.ingress.capture(event());
    const pending = f.ingress.observe(ticket); await vi.advanceTimersByTimeAsync(21);
    expect(await pending).toEqual({ status: 'outcome_unknown' });
    expect(await f.ingress.observe(ticket)).toEqual({ status: 'inactive' });
    expect(await f.ingress.observe(f.ingress.capture(nextEvent('m-2')))).toEqual({ status: 'overloaded' });
    expect(rpc).toHaveBeenCalledTimes(2); expect(rpc.mock.calls[1][0].signal.aborted).toBe(true);
    settle(observed()); await vi.advanceTimersByTimeAsync(1);
    rpc.mockResolvedValueOnce(observed());
    expect(await f.ingress.observe(f.ingress.capture(nextEvent('m-3')))).toEqual({ status: 'observed' });
    expect(rpc.mock.calls.filter(([q]) => q.args.p.operation === 'observe').map(([q]) => q.args.p.providerMessageId)).toEqual(['m-1', 'm-3']);
    f.ingress.close();
  });
  it.each(['42501', 'PT409'])('rejects only the ticket on %s and validates every new observation with SQL', async code => {
    const f = fixture(); await f.ingress.register();
    const ticket = f.ingress.capture(event());
    f.rpc.mockResolvedValueOnce({ error: { code, message: secret }, status: code === 'PT409' ? 409 : 403 });
    expect(await f.ingress.observe(ticket)).toEqual({ status: code === 'PT409' ? 'context_changed' : 'denied' });
    expect(await f.ingress.observe(ticket)).toEqual({ status: 'inactive' });
    const next = nextEvent('m-2'); next.data.content = '/hermes-link hz_' + 'b'.repeat(64);
    expect(await f.ingress.observe(f.ingress.capture(next))).toEqual({ status: 'observed' });
    expect(f.rpc.mock.calls.map(([q]) => q.args.p.operation)).toEqual(['register', 'observe', 'observe']);
    expect(f.rpc.mock.calls[2][0].args.p).toMatchObject({ generation: id('5'), providerMessageId: 'm-2' });
    f.ingress.close();
  });
  it('suppresses raw transport exceptions and does not retry an uncertain registration', async () => {
    const rpc = vi.fn(() => { throw new Error(secret); }); const f = fixture({ rpc });
    expect(await f.ingress.register()).toEqual({ status: 'outcome_unknown' });
    expect(await f.ingress.register()).toEqual({ status: 'inactive' });
    expect(await f.ingress.captureLive(event())).toBe(null); expect(rpc).toHaveBeenCalledTimes(1);
  });
});

describe('Hermes denied registration recovery', () => {
  it('coalesces recovery for eligible live messages and uses only the acknowledged generation and captured identity', async () => {
    let settle;
    const rpc = vi.fn().mockResolvedValueOnce(denied())
      .mockImplementationOnce(() => new Promise(resolve => { settle = resolve; })).mockResolvedValue(observed());
    const f = fixture({ rpc });
    expect(await f.ingress.register()).toEqual({ status: 'denied' });
    const m = event();
    const pending = [f.ingress.captureLive(m), f.ingress.captureLive(nextEvent('m-2'))];
    await Promise.resolve();
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(f.ingress.capture(event())).toBe(null);
    expect(rpc.mock.calls[1][0].args.p).toEqual({ operation: 'register', ...source });
    m.data.msgId = 'tampered'; m.data.uidFrom = '999'; m.data.content = 'ordinary';
    settle({ ...registered(), data: { ...registered().data, generation: id('6') } });
    const tickets = await Promise.all(pending);
    for (const ticket of tickets) expect(await f.ingress.observe(ticket)).toEqual({ status: 'observed' });
    expect(rpc.mock.calls.slice(2).map(([q]) => q.args.p)).toEqual([
      expect.objectContaining({ generation: id('6'), providerMessageId: 'm-1', senderUid: '456' }),
      expect.objectContaining({ generation: id('6'), providerMessageId: 'm-2', senderUid: '456' }),
    ]);
    expect(await f.ingress.observe(tickets[0])).toEqual({ status: 'inactive' });
    expect(rpc).toHaveBeenCalledTimes(4);
    f.ingress.close();
  });
  it('shares the initial in-flight registration instead of starting another write', async () => {
    let settle;
    const f = fixture({ rpc: vi.fn(() => new Promise(resolve => { settle = resolve; })) });
    const first = f.ingress.register(), second = f.ingress.register();
    const pending = f.ingress.captureLive(event());
    await Promise.resolve(); expect(f.rpc).toHaveBeenCalledTimes(1);
    settle(registered());
    expect(await first).toEqual({ status: 'registered' }); expect(await second).toEqual({ status: 'registered' });
    expect(await pending).not.toBe(null);
    f.ingress.close();
  });
  it.each(['ordinary', 'group', 'self', 'sender', 'recipient', 'forward', 'accessor', 'malformed', 'newline', 'message-id'])('does not register again for an ineligible %s event', async kind => {
    const f = fixture({ rpc: vi.fn(async () => denied()) }); await f.ingress.register();
    const m = event();
    if (kind === 'ordinary') m.data.content = 'Hello';
    if (kind === 'group') m.type = 1;
    if (kind === 'self') m.isSelf = true;
    if (kind === 'sender') m.threadId = '789';
    if (kind === 'recipient') m.data.idTo = '789';
    if (kind === 'forward') m.data.forward = true;
    if (kind === 'accessor') Object.defineProperty(m.data, 'forward', { get() { throw new Error('must not execute'); } });
    if (kind === 'malformed') m.data.content += ' extra';
    if (kind === 'newline') m.data.content += '\n';
    if (kind === 'message-id') m.data.msgId += '\n';
    expect(await f.ingress.captureLive(m)).toBe(null);
    expect(f.rpc).toHaveBeenCalledTimes(1); f.ingress.close();
  });
  it.each([
    ['missing HTTP status', { error: { code: '42501' } }, 'outcome_unknown'],
    ['wrong HTTP status', { error: { code: '42501' }, status: 500 }, 'outcome_unknown'],
    ['wrong error code', { error: { code: '08006' }, status: 403 }, 'outcome_unknown'],
    ['contradictory denial and data', { ...denied(), data: registered().data }, 'outcome_unknown'],
    ['contradictory HTTP acknowledgment', { ...registered(), status: 500 }, 'outcome_unknown'],
    ['context mismatch', { error: { code: 'PT409' }, status: 409 }, 'context_changed'],
    ['malformed acknowledgment', { data: { ...registered().data, extra: true } }, 'outcome_unknown'],
    ['wrong account', { data: { ...registered().data, accountId: id('9') } }, 'outcome_unknown'],
    ['malformed generation', { data: { ...registered().data, generation: id('5') + '\n' } }, 'outcome_unknown'],
  ])('never repeats a recovery write after %s', async (_kind, response, status) => {
    const f = fixture({ rpc: vi.fn().mockResolvedValueOnce(denied()).mockResolvedValueOnce(response).mockResolvedValue(registered()) });
    await f.ingress.register();
    expect(await f.ingress.captureLive(event())).toBe(null);
    expect(await f.ingress.register()).toEqual({ status: 'inactive' });
    expect(await f.ingress.captureLive(nextEvent('m-2'))).toBe(null);
    expect(f.rpc).toHaveBeenCalledTimes(2);
    const initial = fixture({ rpc: vi.fn(async () => response) });
    expect(await initial.ingress.register()).toEqual({ status });
    expect(await initial.ingress.captureLive(event())).toBe(null);
    expect(initial.rpc).toHaveBeenCalledTimes(1);
    f.ingress.close(); initial.ingress.close();
  });
  it('never repeats a timed-out recovery or accepts its late generation', async () => {
    vi.useFakeTimers(); let settle;
    const f = fixture({ timeoutMs: 20, rpc: vi.fn().mockResolvedValueOnce(denied())
      .mockImplementationOnce(() => new Promise(resolve => { settle = resolve; })).mockResolvedValue(registered()) });
    await f.ingress.register();
    const pending = f.ingress.captureLive(event()); await vi.advanceTimersByTimeAsync(21);
    expect(await pending).toBe(null);
    expect(await f.ingress.captureLive(nextEvent('m-2'))).toBe(null);
    settle(registered()); await vi.advanceTimersByTimeAsync(0);
    expect(await f.ingress.register()).toEqual({ status: 'inactive' });
    expect(await f.ingress.captureLive(nextEvent('m-3'))).toBe(null);
    expect(f.rpc).toHaveBeenCalledTimes(2); f.ingress.close();
  });
  it.each(['lease lost', 'session closed'])('cannot capture a recovered ticket after %s while awaiting registration', async kind => {
    let settle;
    const f = fixture({ rpc: vi.fn().mockResolvedValueOnce(denied())
      .mockImplementationOnce(() => new Promise(resolve => { settle = resolve; })) });
    await f.ingress.register(); const pending = f.ingress.captureLive(event()); await Promise.resolve();
    if (kind === 'lease lost') f.expire(); else f.ingress.close();
    settle(registered()); expect(await pending).toBe(null);
    expect(await f.ingress.captureLive(nextEvent('m-2'))).toBe(null);
    expect(f.rpc).toHaveBeenCalledTimes(2); f.ingress.close();
  });
  it('requires a fresh attachment after privacy proves the pinned context has changed', async () => {
    const f = fixture({ rpc: vi.fn().mockResolvedValueOnce(denied())
      .mockResolvedValueOnce({ error: { code: 'PT409' }, status: 409 }).mockResolvedValue(registered()) });
    await f.ingress.register();
    expect(await f.ingress.privacy()).toEqual({ status: 'context_changed' });
    expect(await f.ingress.captureLive(event())).toBe(null);
    expect(await f.ingress.register()).toEqual({ status: 'inactive' });
    expect(f.rpc).toHaveBeenCalledTimes(2); f.ingress.close();
  });
  it('does not revive recovery when a registration ACK arrives after a known privacy context mismatch', async () => {
    let settle;
    const rpc = vi.fn().mockResolvedValueOnce(denied()).mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }))
      .mockResolvedValueOnce({ error: { code: 'PT409' }, status: 409 });
    const f = fixture({ rpc }); await f.ingress.register();
    const pending = f.ingress.captureLive(event()); await Promise.resolve();
    expect(await f.ingress.privacy()).toEqual({ status: 'context_changed' });
    settle(registered()); expect(await pending).toBe(null);
    expect(await f.ingress.register()).toEqual({ status: 'inactive' });
    expect(await f.ingress.captureLive(nextEvent('m-2'))).toBe(null);
    expect(rpc).toHaveBeenCalledTimes(3); f.ingress.close();
  });
});

describe('live link source exactness', () => {
  const observationSource = () => ({ accountId: source.accountId, organizationId: source.organizationId,
    instanceId: source.instanceId, generation: id('5'), ownUid: source.ownUid, eventKind: 'message' });
  it.each(['extra', 'missing', 'accessor', 'generation', 'uid', 'history'])('rejects a %s source without fabricating identity or executing accessors', kind => {
    const s = observationSource();
    if (kind === 'extra') s.extra = true;
    if (kind === 'missing') delete s.generation;
    if (kind === 'accessor') Object.defineProperty(s, 'generation', { get() { throw new Error('must not execute'); } });
    if (kind === 'generation') s.generation += '\n';
    if (kind === 'uid') s.ownUid += '\n';
    if (kind === 'history') s.eventKind = 'old_messages';
    expect(() => prepareLiveLinkObservation({ event: event(), source: s })).toThrowError('invalid_source');
  });
  it('reads source descriptors instead of proxy value traps', () => {
    const s = new Proxy(observationSource(), { get() { throw new Error('must not execute'); } });
    expect(prepareLiveLinkObservation({ event: event(), source: s })).toMatchObject({ generation: id('5'), senderUid: '456' });
  });
});
