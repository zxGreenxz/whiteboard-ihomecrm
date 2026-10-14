import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { supabase } from '@/integrations/supabase/client';
import { createHermesConnectionClient, HermesConnectionClientError, type HermesCallerScope } from './connectionClient';

vi.mock('@/integrations/supabase/client', () => ({ supabase: { auth: { getSession: vi.fn() } } }));
const USER = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const CONNECTION = '33333333-3333-4333-8333-333333333333';
const ASSISTANT = '44444444-4444-4444-8444-444444444444';
const SCOPE = '55555555-5555-4555-8555-555555555555';
const OTHER = '66666666-6666-4666-8666-666666666666';
const JWT = 'browser.session.signature';
const OPAQUE = `hc_${'a'.repeat(43)}`;
const limits = () => ({ read: ['assistant.context.read'], action: [] as string[] });
const metadata = () => ({ id: CONNECTION, assistantId: ASSISTANT, organizationId: ORG, userId: USER,
  state: 'active' as const, epoch: 2, restrictions: limits(), scopeIds: [SCOPE] });
const details = () => ({ ...metadata(), membershipId: OTHER, authorizationVersion: 1, isSuperadmin: false,
  policyVersion: 1, companyCeilings: limits(), effective: limits() });
const newConnection = () => ({ status: 'active', connection: metadata(), token: OPAQUE, tokenExpiresAt: 2_000_000_000_000 });
const connectInput = () => ({ email: 'fixture@example.invalid', password: 'ephemeral-only', restrictions: limits(), scopeIds: [SCOPE] });
const mutationInput = () => ({ connectionId: CONNECTION, expectedEpoch: 2 });
const sessionResult = (userId = USER) => ({ data: { session: { access_token: JWT, user: { id: userId } } }, error: null });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const pending = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
function setup(timeoutMs = 30_000) {
  const scope: HermesCallerScope = { userId: USER, organizationId: ORG, generation: 0 };
  const fetch = vi.fn<typeof globalThis.fetch>(async () => json({ connections: [metadata()] }));
  const getSession = vi.fn(async () => sessionResult());
  const config = { userId: USER, organizationId: ORG, currentScope: () => scope, getSession, fetch, timeoutMs };
  return { scope, fetch, getSession, config, client: createHermesConnectionClient(config) };
}
beforeEach(() => { vi.mocked(supabase.auth.getSession).mockReset(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Hermes connection browser boundary', () => {
  it('uses the CRM getSession bearer by default, a fixed same-origin POST, and no cookies/cache/redirect fallback', async () => {
    const { config, fetch } = setup();
    vi.mocked(supabase.auth.getSession).mockResolvedValue(sessionResult() as never);
    const client = createHermesConnectionClient({ ...config, getSession: undefined });
    const result = await client.list();
    expect(result.connections[0].state).toBe('active'); // Metadata only, no invented runtime health field.
    expect(supabase.auth.getSession).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('/api/hermes/connections/list', expect.objectContaining({
      method: 'POST', mode: 'same-origin', credentials: 'omit', redirect: 'error', cache: 'no-store',
      headers: { authorization: `Bearer ${JWT}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ organizationId: ORG }), signal: expect.any(AbortSignal),
    }));
  });

  it('projects all five protocols and returns the connect opaque only in that one result', async () => {
    const { client, fetch } = setup();
    const connected = newConnection();
    fetch.mockResolvedValueOnce(json(connected));
    await expect(client.connect(connectInput())).resolves.toEqual(connected);
    fetch.mockResolvedValueOnce(json({ context: details() }));
    await expect(client.context({ connectionId: CONNECTION })).resolves.toEqual({ context: details() });
    fetch.mockResolvedValueOnce(json({ ok: true, connection: { ...metadata(), epoch: 3 } }));
    await expect(client.restrict({ ...mutationInput(), restrictions: limits(), scopeIds: [SCOPE] })).resolves.toMatchObject({ ok: true, connection: { epoch: 3 } });
    fetch.mockResolvedValueOnce(json({ ok: true, status: 'revoked', connectionId: CONNECTION }));
    await expect(client.revoke(mutationInput())).resolves.toEqual({ ok: true, status: 'revoked', connectionId: CONNECTION });
    await expect(client.list()).resolves.toEqual({ connections: [metadata()] });
    expect(fetch.mock.calls.map(([path]) => path)).toEqual(['connect', 'context', 'restrict', 'revoke', 'list'].map(op => `/api/hermes/connections/${op}`));
    expect(JSON.stringify(fetch.mock.calls.slice(1))).not.toContain('ephemeral-only');
    expect(JSON.stringify(fetch.mock.calls)).not.toContain(OPAQUE);
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it.each(['user', 'organization', 'generation'] as const)('rejects a %s switch while waiting for a response', async kind => {
    const { client, fetch, scope } = setup();
    fetch.mockImplementationOnce(async () => {
      if (kind === 'user') scope.userId = OTHER;
      if (kind === 'organization') scope.organizationId = OTHER;
      if (kind === 'generation') scope.generation += 2; // Covers A -> B -> A with the same final IDs.
      return json({ connections: [metadata()] });
    });
    await expect(client.list()).rejects.toMatchObject({ code: 'context_changed', outcomeUnknown: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch for a switched scope, missing session, Auth error, foreign user, or malformed bearer', async () => {
    const { client, getSession, fetch, scope } = setup();
    scope.organizationId = OTHER;
    await expect(client.list()).rejects.toMatchObject({ code: 'context_changed', outcome: 'not_dispatched' });
    expect(getSession).not.toHaveBeenCalled();
    scope.organizationId = ORG;
    for (const value of [
      { data: { session: null }, error: null },
      { ...sessionResult(), error: new Error('private-provider-error') },
      sessionResult(OTHER),
      { data: { session: { user: { id: USER }, access_token: 'not a bearer' } }, error: null },
    ]) {
      getSession.mockResolvedValueOnce(value as ReturnType<typeof sessionResult>);
      await expect(client.connect(connectInput())).rejects.toMatchObject({ code: 'reauthentication_required', outcome: 'not_dispatched' });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fences a switch during initial and final session reads, including the final awaited step', async () => {
    const first = setup();
    first.getSession.mockImplementationOnce(async () => { first.scope.generation++; return sessionResult(); });
    await expect(first.client.list()).rejects.toMatchObject({ code: 'context_changed' });
    expect(first.fetch).not.toHaveBeenCalled();
    const last = setup();
    last.getSession.mockResolvedValueOnce(sessionResult()).mockImplementationOnce(async () => {
      last.scope.organizationId = OTHER; return sessionResult();
    });
    await expect(last.client.list()).rejects.toMatchObject({ code: 'context_changed' });
    expect(last.fetch).toHaveBeenCalledTimes(1);
  });

  it('drops old-user responses even if the UI scope ref has not yet updated, but allows a same-user token refresh', async () => {
    const { client, getSession } = setup();
    getSession.mockResolvedValueOnce(sessionResult()).mockResolvedValueOnce(sessionResult(OTHER));
    await expect(client.list()).rejects.toMatchObject({ code: 'reauthentication_required' });
    getSession.mockResolvedValueOnce(sessionResult()).mockResolvedValueOnce({ ...sessionResult(), data: {
      session: { ...sessionResult().data.session, access_token: 'refreshed.session.signature' },
    } });
    await expect(client.list()).resolves.toHaveProperty('connections');
  });

  it('discards an opaque result after a scope switch and retains only a locally bound unknown receipt', async () => {
    const { client, fetch, scope } = setup();
    fetch.mockImplementationOnce(async () => { scope.generation++; return json(newConnection()); });
    const error = await client.connect(connectInput()).catch(value => value);
    expect(error).toMatchObject({ code: 'context_changed', outcome: 'unknown', receipt: { operation: 'connect', userId: USER, organizationId: ORG } });
    expect(JSON.stringify(error)).not.toContain(OPAQUE);
    expect(JSON.stringify(error)).not.toContain('ephemeral-only');
  });

  it('snapshots a mutation before awaits, so caller mutation cannot widen the request or its response fence', async () => {
    const { client, getSession, fetch } = setup();
    const input = { ...mutationInput(), restrictions: limits(), scopeIds: [SCOPE] };
    getSession.mockImplementationOnce(async () => { input.restrictions.read.push('rooms.view'); input.scopeIds[0] = OTHER; return sessionResult(); });
    fetch.mockResolvedValueOnce(json({ ok: true, connection: { ...metadata(), epoch: 3 } }));
    await expect(client.restrict(input)).resolves.toHaveProperty('ok', true);
    const sent = JSON.parse(fetch.mock.calls[0][1]!.body as string);
    expect(sent.scopeIds).toEqual([SCOPE]);
    expect(sent.restrictions).toEqual(limits());
  });

  it.each([
    () => ({ connections: [{ ...metadata(), userId: OTHER }] }),
    () => ({ connections: [{ ...metadata(), organizationId: OTHER }] }),
    () => ({ connections: [metadata(), metadata()] }),
    () => ({ connections: [{ ...metadata(), refresh_token: 'provider-secret' }] }),
    () => ({ connections: [metadata()], debug: { access_token: 'provider-secret' } }),
    () => ({ connections: [{ ...metadata(), restrictions: { ...limits(), debug: true } }] }),
    () => ({ connections: [{ ...metadata(), scopeIds: [SCOPE, SCOPE] }] }),
  ])('rejects foreign, duplicate or unprojected list data', async payload => {
    const { client, fetch } = setup(); fetch.mockResolvedValueOnce(json(payload()));
    const error = await client.list().catch(value => value);
    expect(error).toBeInstanceOf(HermesConnectionClientError);
    expect(error.code).toBe('invalid_response');
    expect(JSON.stringify(error)).not.toContain('provider-secret');
  });

  it('rejects context effective rights outside either connection or company ceilings', async () => {
    const { client, fetch } = setup();
    for (const data of [
      { ...details(), effective: { read: ['rooms.view'], action: [] } },
      { ...details(), companyCeilings: { read: [], action: [] } },
      { ...details(), id: OTHER },
      { ...details(), state: 'revoked' },
    ]) {
      fetch.mockResolvedValueOnce(json({ context: data }));
      await expect(client.context({ connectionId: CONNECTION })).rejects.toMatchObject({ code: 'invalid_response' });
    }
  });

  it('cannot accept a wider or wrong-epoch mutation acknowledgement, or any provider secret in a connect result', async () => {
    const { client, fetch } = setup();
    for (const connection of [metadata(), { ...metadata(), epoch: 3, scopeIds: [OTHER] }, { ...metadata(), epoch: 3, id: OTHER }]) {
      fetch.mockResolvedValueOnce(json({ ok: true, connection }));
      await expect(client.restrict({ ...mutationInput(), restrictions: limits(), scopeIds: [SCOPE] })).rejects.toMatchObject({ code: 'operation_outcome_unknown', outcomeUnknown: true });
    }
    fetch.mockResolvedValueOnce(json({ ...newConnection(), refresh_token: 'provider-secret' }));
    await expect(client.connect(connectInput())).rejects.toMatchObject({ code: 'operation_outcome_unknown' });
    fetch.mockResolvedValueOnce(json({ ...newConnection(), token: JWT }));
    await expect(client.connect(connectInput())).rejects.toMatchObject({ code: 'operation_outcome_unknown' });
  });

  it.each([
    () => new Response('<html>proxy failure provider-secret</html>', { status: 502 }),
    () => new Response('{not-json provider-secret', { headers: { 'content-type': 'application/json' } }),
    () => json({ error: 'forbidden' }),
    () => new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } }),
  ])('treats malformed/non-JSON write responses as unknown without retry or raw diagnostics', async response => {
    const { client, fetch } = setup(); fetch.mockResolvedValueOnce(response());
    const error = await client.revoke(mutationInput()).catch(value => value);
    expect(error).toMatchObject({ code: 'operation_outcome_unknown', outcome: 'unknown', receipt: { operation: 'revoke', connectionId: CONNECTION, expectedEpoch: 2 } });
    expect(JSON.stringify(error)).not.toContain('provider-secret');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('caps declared and actual response bytes without silently truncating a result', async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValueOnce(new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '1048577' } }));
    await expect(client.list()).rejects.toMatchObject({ code: 'invalid_response' });
    fetch.mockResolvedValueOnce(new Response(' '.repeat(1_048_577), { headers: { 'content-type': 'application/json' } }));
    await expect(client.revoke(mutationInput())).rejects.toMatchObject({ code: 'operation_outcome_unknown' });
    fetch.mockResolvedValueOnce(new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '-1' } }));
    await expect(client.list()).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('distinguishes explicit backend denial from uncertain writes, validating status and safe receipts', async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValueOnce(json({ error: 'forbidden' }, 403));
    await expect(client.revoke(mutationInput())).rejects.toMatchObject({ code: 'forbidden', outcome: 'rejected', outcomeUnknown: false });
    fetch.mockResolvedValueOnce(json({ error: 'operation_outcome_unknown', receipt: { ...mutationInput(), operation: 'revoke' } }, 503));
    await expect(client.revoke(mutationInput())).rejects.toMatchObject({ code: 'operation_outcome_unknown', outcome: 'unknown' });
    fetch.mockResolvedValueOnce(json({ error: 'forbidden' }, 503));
    await expect(client.revoke(mutationInput())).rejects.toMatchObject({ code: 'operation_outcome_unknown' });
    fetch.mockResolvedValueOnce(json({ error: 'operation_outcome_unknown', receipt: { ...mutationInput(), connectionId: OTHER, operation: 'revoke' } }, 503));
    const error = await client.revoke(mutationInput()).catch(value => value);
    expect(error.receipt.connectionId).toBe(CONNECTION);
    expect(JSON.stringify(error)).not.toContain(OTHER);
  });

  it('rejects extra error diagnostics and never exposes an unbound connect receipt', async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValueOnce(json({ error: 'forbidden', message: 'provider-secret' }, 403));
    const error = await client.connect(connectInput()).catch(value => value);
    expect(error).toMatchObject({ code: 'operation_outcome_unknown', outcomeUnknown: true });
    expect(JSON.stringify(error)).not.toContain('provider-secret');
    fetch.mockResolvedValueOnce(json({ error: 'activation_outcome_unknown', receipt: { connectionId: OTHER, operationId: SCOPE } }, 503));
    const unknown = await client.connect(connectInput()).catch(value => value);
    expect(unknown).toMatchObject({ code: 'activation_outcome_unknown', outcome: 'unknown' });
    expect(unknown.receipt).toEqual({ operation: 'connect', userId: USER, organizationId: ORG });
  });

  it('does not send input fields that would bypass server ownership or choose arbitrary endpoints', async () => {
    const { client, config, fetch, getSession } = setup();
    expect(() => createHermesConnectionClient({ ...config, url: 'https://elsewhere.invalid' } as never)).toThrow('invalid_hermes_client_config');
    for (const extra of [{ userId: OTHER }, { organizationId: OTHER }, { url: '/anything' }, { browserAccessToken: JWT }]) {
      await expect(client.connect({ ...connectInput(), ...extra } as never)).rejects.toMatchObject({ code: 'invalid_request', outcome: 'not_dispatched' });
    }
    await expect(client.connect({ ...connectInput(), password: 'a'.repeat(4097) })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(client.connect({ ...connectInput(), restrictions: { read: ['future.unsupported_read'], action: [] } })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(client.context({ connectionId: CONNECTION.toUpperCase() + '/' })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetch).not.toHaveBeenCalled(); expect(getSession).not.toHaveBeenCalled();
  });

  it('caps the whole serialized request even when individual arrays meet their caps', async () => {
    const { client, fetch } = setup();
    const rights = Array.from({ length: 256 }, (_, i) => `x${String(i).padStart(3, '0')}${'a'.repeat(124)}`);
    await expect(client.restrict({ ...mutationInput(), restrictions: { read: rights, action: rights }, scopeIds: [] })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not expose a throwing input accessor or invoke HTTP for that invalid request', async () => {
    const { client, fetch } = setup();
    const input = { ...connectInput(), get password(): string { throw new Error('private-password-diagnostic'); } };
    const error = await client.connect(input).catch(value => value);
    expect(error).toMatchObject({ code: 'invalid_request', outcome: 'not_dispatched' });
    expect(JSON.stringify(error)).not.toContain('private-password-diagnostic');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('never retries a lost write acknowledgement or a thrown fetch error, and keeps secrets out of errors', async () => {
    const { client, fetch } = setup(); fetch.mockRejectedValueOnce(new Error('network provider-secret ephemeral-only'));
    const error = await client.connect(connectInput()).catch(value => value);
    expect(error).toMatchObject({ code: 'operation_outcome_unknown', outcome: 'unknown' });
    expect(error.cause).toBeUndefined(); expect(error.message).toBe('operation_outcome_unknown');
    expect(JSON.stringify(error)).not.toMatch(/provider-secret|ephemeral-only/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('pre-abort sends nothing, while cancellation after dispatch remains unknown and aborts the native request signal', async () => {
    const { client, fetch, getSession } = setup(); const cancelled = new AbortController(); cancelled.abort();
    await expect(client.connect(connectInput(), { signal: cancelled.signal })).rejects.toMatchObject({ code: 'cancelled', outcome: 'not_dispatched' });
    expect(getSession).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    const controller = new AbortController(); let transportSignal: AbortSignal | undefined;
    const sent = pending<void>();
    fetch.mockImplementationOnce(async (_path, init) => { transportSignal = init!.signal as AbortSignal; sent.resolve(); return new Promise<Response>(() => {}); });
    const result = client.connect(connectInput(), { signal: controller.signal }).catch(value => value);
    await sent.promise; controller.abort();
    expect(await result).toMatchObject({ code: 'operation_outcome_unknown', outcome: 'unknown' });
    expect(transportSignal?.aborted).toBe(true); expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('times out a hanging initial getSession without ever dispatching after a late session resolution', async () => {
    vi.useFakeTimers(); const { client, getSession, fetch } = setup(25); const delayed = pending<ReturnType<typeof sessionResult>>();
    getSession.mockReturnValueOnce(delayed.promise);
    const result = client.connect(connectInput()).catch(value => value);
    await vi.advanceTimersByTimeAsync(26);
    expect(await result).toMatchObject({ code: 'timeout', outcome: 'not_dispatched' });
    delayed.resolve(sessionResult()); await Promise.resolve(); await Promise.resolve();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('bounds a fetch that ignores abort and cannot accept its late successful opaque response', async () => {
    vi.useFakeTimers(); const { client, fetch } = setup(25); const delayed = pending<Response>();
    fetch.mockReturnValueOnce(delayed.promise);
    const result = client.connect(connectInput()).catch(value => value);
    await vi.advanceTimersByTimeAsync(26);
    expect(await result).toMatchObject({ code: 'operation_outcome_unknown', outcome: 'unknown' });
    delayed.resolve(json(newConnection())); await Promise.resolve(); await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('cancels a stalled response stream and removes the caller abort listener after settling', async () => {
    const { client, fetch } = setup(); const controller = new AbortController();
    const entered = pending<void>(); const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ pull() { entered.resolve(); }, cancel }, { highWaterMark: 0 });
    fetch.mockResolvedValueOnce(new Response(stream, { headers: { 'content-type': 'application/json' } }));
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const result = client.revoke(mutationInput(), { signal: controller.signal }).catch(value => value);
    await entered.promise; await Promise.resolve(); controller.abort();
    expect(await result).toMatchObject({ outcome: 'unknown' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});

describe('self-owned grant choices and implemented room enrollment', () => {
  const options = () => ({ userId: USER, organizationId: ORG, membershipId: OTHER, authorizationVersion: 1, isSuperadmin: false,
    policyVersion: 2, enabled: true, read: ['assistant.context.read', 'rooms.view'], action: [],
    scopes: [{ scopeId: SCOPE, scopeType: 'BUILDING', label: 'Nhà A', buildingId: ASSISTANT, areaId: null, cashbookId: null }] });
  it('uses fixed options route and checks the returned owner/company with no credential in the result', async () => {
    const { client, fetch } = setup(); fetch.mockResolvedValue(json({ options: options() }));
    await expect(client.options()).resolves.toEqual({ options: options() });
    expect(fetch).toHaveBeenCalledWith('/api/hermes/connections/options', expect.objectContaining({ body: JSON.stringify({ organizationId: ORG }) }));
  });
  it.each([
    { userId: OTHER }, { organizationId: OTHER }, { read: ['future.unsupported_read'] }, { action: ['rooms.edit'] },
    { token: OPAQUE }, { scopes: [] }, { policyVersion: -1 },
  ])('rejects malformed or foreign choices %j', async delta => {
    const { client, fetch } = setup(); fetch.mockResolvedValue(json({ options: { ...options(), ...delta } }));
    await expect(client.options()).rejects.toBeInstanceOf(HermesConnectionClientError);
  });
  it('accepts neutral version-zero options without writing organization policy', async () => {
    const { client, fetch } = setup(); const neutral = { ...options(), policyVersion: 0 };
    fetch.mockResolvedValue(json({ options: neutral }));
    await expect(client.options()).resolves.toEqual({ options: neutral });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('accepts domain-only building scope choices from the shared capability catalog', async () => {
    const { client, fetch } = setup(); const value = { ...options(), read: ['contracts.view'], action: ['assistant.memory.write','chat_zalo.manage_automation'] };
    fetch.mockResolvedValue(json({ options: value }));await expect(client.options()).resolves.toEqual({ options: value });
    fetch.mockResolvedValue(json({ options: { ...value, scopes: [] } }));await expect(client.options()).rejects.toBeInstanceOf(HermesConnectionClientError);
  });
  it('can enroll rooms read in selected scope but retains no ability to submit action grants', async () => {
    const { client, fetch } = setup(), restrictions = { read: ['assistant.context.read', 'rooms.view'], action: [] };
    const result = { ...newConnection(), connection: { ...metadata(), restrictions } };
    fetch.mockResolvedValue(json(result));
    await expect(client.connect({ ...connectInput(), restrictions })).resolves.toEqual(result);
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toMatchObject({ restrictions, scopeIds: [SCOPE] });
    await expect(client.connect({ ...connectInput(), restrictions: { ...restrictions, action: ['rooms.edit'] } })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('fixed group action enrollment',()=>{
 it('accepts group read without room scope or action and preserves independent enrollment',async()=>{
  const {client,fetch}=setup();
  const options={userId:USER,organizationId:ORG,membershipId:OTHER,authorizationVersion:1,isSuperadmin:false,policyVersion:1,enabled:true,read:['chat_zalo.view'],action:[],scopes:[]};
  fetch.mockResolvedValueOnce(json({options}));expect((await client.options()).options).toEqual(options);
  const input={...connectInput(),restrictions:{read:['chat_zalo.view'],action:[]},scopeIds:[]};
  const connected=newConnection();connected.connection.restrictions=input.restrictions;connected.connection.scopeIds=[];
  fetch.mockResolvedValueOnce(json(connected));await expect(client.connect(input)).resolves.toEqual(connected);
  expect(JSON.parse(fetch.mock.calls[1][1]!.body as string).restrictions).toEqual({read:['chat_zalo.view'],action:[]});
 });
 it('accepts only the server-listed fixed action in options and preserves it in explicit connect',async()=>{
  const {client,fetch}=setup();const options={userId:USER,organizationId:ORG,membershipId:OTHER,authorizationVersion:1,isSuperadmin:false,policyVersion:1,enabled:true,read:[],action:['chat_zalo.send'],scopes:[]};
  fetch.mockResolvedValueOnce(json({options}));expect((await client.options()).options.action).toEqual(['chat_zalo.send']);
  const input=connectInput();input.restrictions.action=['chat_zalo.send'];const connected=newConnection();connected.connection.restrictions.action=['chat_zalo.send'];fetch.mockResolvedValueOnce(json(connected));await expect(client.connect(input)).resolves.toEqual(connected);expect(JSON.parse(fetch.mock.calls[1][1]!.body as string).restrictions.action).toEqual(['chat_zalo.send']);
 });
 it.each([['rooms.edit'],['chat_zalo.send','chat_zalo.send']])('rejects invalid/duplicate action %j before dispatch',async(...action)=>{
  const {client,fetch}=setup(),input=connectInput();input.restrictions.action=action;await expect(client.connect(input)).rejects.toMatchObject({code:'invalid_request'});expect(fetch).not.toHaveBeenCalled();
 });
 it('rejects action presented by a disabled options response',async()=>{
  const {client,fetch}=setup();fetch.mockResolvedValueOnce(json({options:{userId:USER,organizationId:ORG,membershipId:OTHER,authorizationVersion:1,isSuperadmin:false,policyVersion:1,enabled:false,read:[],action:['chat_zalo.send'],scopes:[]}}));await expect(client.options()).rejects.toMatchObject({code:'invalid_response'});
 });
});

describe('room-pass Action building scope without Read',()=>{
 it('accepts the offered Action and requires scope choices even with no Read keys',async()=>{
  const {client,fetch}=setup();const options={userId:USER,organizationId:ORG,membershipId:OTHER,authorizationVersion:1,isSuperadmin:false,policyVersion:1,enabled:true,
    read:[],action:['sale_phong.manage_pass_listings'],scopes:[{scopeId:SCOPE,scopeType:'BUILDING',label:'Toà: Nhà A',buildingId:ASSISTANT,areaId:null,cashbookId:null}]};
  fetch.mockResolvedValueOnce(json({options}));await expect(client.options()).resolves.toEqual({options});
  fetch.mockResolvedValueOnce(json({options:{...options,scopes:[]}}));await expect(client.options()).rejects.toMatchObject({code:'invalid_response'});
  const input={...connectInput(),restrictions:{read:[],action:['sale_phong.manage_pass_listings']},scopeIds:[SCOPE]};
  const connected=newConnection();connected.connection.restrictions=input.restrictions;connected.connection.scopeIds=[SCOPE];
  fetch.mockResolvedValueOnce(json(connected));await expect(client.connect(input)).resolves.toEqual(connected);
  expect(JSON.parse(fetch.mock.calls[2][1]!.body as string)).toMatchObject({restrictions:input.restrictions,scopeIds:[SCOPE]});
 });
});

describe('task-create Action building scope without Read',()=>{
 it('accepts the offered Action and requires scope choices even with no Read keys',async()=>{
  const {client,fetch}=setup();const options={userId:USER,organizationId:ORG,membershipId:OTHER,authorizationVersion:1,isSuperadmin:false,policyVersion:1,enabled:true,
    read:[],action:['tasks.create'],scopes:[{scopeId:SCOPE,scopeType:'BUILDING',label:'Toà: Nhà A',buildingId:ASSISTANT,areaId:null,cashbookId:null}]};
  fetch.mockResolvedValueOnce(json({options}));await expect(client.options()).resolves.toEqual({options});
  fetch.mockResolvedValueOnce(json({options:{...options,scopes:[]}}));await expect(client.options()).rejects.toMatchObject({code:'invalid_response'});
  const input={...connectInput(),restrictions:{read:[],action:['tasks.create']},scopeIds:[SCOPE]};
  const connected=newConnection();connected.connection.restrictions=input.restrictions;connected.connection.scopeIds=[SCOPE];
  fetch.mockResolvedValueOnce(json(connected));await expect(client.connect(input)).resolves.toEqual(connected);
  expect(JSON.parse(fetch.mock.calls[2][1]!.body as string)).toMatchObject({restrictions:input.restrictions,scopeIds:[SCOPE]});
 });
});
