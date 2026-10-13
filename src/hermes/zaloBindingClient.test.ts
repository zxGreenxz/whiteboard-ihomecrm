import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHermesZaloClient } from './zaloBindingClient';
vi.mock('@/integrations/supabase/client', () => ({ supabase: { auth: { getSession: vi.fn() } } }));
const USER = '11111111-1111-4111-8111-111111111111', ORG = '22222222-2222-4222-8222-222222222222';
const CONNECTION = '33333333-3333-4333-8333-333333333333', BOT = '44444444-4444-4444-8444-444444444444', CHALLENGE = '55555555-5555-4555-8555-555555555555';
const secret = 'hz_' + 'a'.repeat(64), input = { connectionId: CONNECTION, accountId: BOT, expectedConnectionEpoch: 2 };
const json = (value: unknown, status = 200) => Response.json(value, { status });
const challenge = () => ({ userId: USER, organizationId: ORG, status: 'waiting', challengeId: CHALLENGE, challenge: secret, accountId: BOT, connectionId: CONNECTION, expiresAt: Date.now() + 300000 });
function fixture(timeoutMs = 30000) {
  const scope = { userId: USER, organizationId: ORG, generation: 0 };
  const fetch = vi.fn<typeof globalThis.fetch>(async () => json(challenge()));
  const getSession = vi.fn(async () => ({ data: { session: { user: { id: USER }, access_token: 'fixture.browser.jwt' } }, error: null }));
  const client = createHermesZaloClient({ userId: USER, organizationId: ORG, currentScope: () => scope, fetch, getSession, timeoutMs });
  return { client, scope, fetch, getSession };
}
afterEach(() => vi.useRealTimers());
describe('Zalo linking browser transport', () => {
  it('configures only an explicit bot/version and treats an unbound or lost acknowledgement as unknown', async () => {
    const f = fixture(), request = { accountId: BOT, expectedVersion: 0, enabled: true };
    const result = { userId: USER, organizationId: ORG, status: 'configured', accountId: BOT, version: 1, enabled: true };
    f.fetch.mockResolvedValueOnce(json(result)); expect((await f.client.setBot(request)).version).toBe(1);
    expect(JSON.parse(f.fetch.mock.calls[0][1]!.body as string)).toEqual({ ...request, organizationId: ORG });
    for (const patch of [{ accountId: CONNECTION }, { version: 2 }, { enabled: false }]) {
      f.fetch.mockResolvedValueOnce(json({ ...result, ...patch }));
      await expect(f.client.setBot(request)).rejects.toMatchObject({ code: 'invalid_response', outcomeUnknown: true });
    }
    f.fetch.mockRejectedValueOnce(new Error('PRIVATE'));
    await expect(f.client.setBot(request)).rejects.toMatchObject({ code: 'binding_outcome_unknown', outcomeUnknown: true });
    expect(f.fetch).toHaveBeenCalledTimes(5);
  });
  it('keeps admin directory failures distinct from empty configuration and accepts a disconnected configured bot', async () => {
    const f = fixture(); f.fetch.mockResolvedValueOnce(json({ error: 'forbidden' }, 403));
    await expect(f.client.manageBots({ afterAccountId: null })).rejects.toMatchObject({ code: 'forbidden', outcomeUnknown: false });
    f.fetch.mockResolvedValueOnce(json({ userId: USER, organizationId: ORG, status: 'listed', nextCursor: null,
      bots: [{ accountId: BOT, name: 'Secondary', zaloUid: null, connected: false, enabled: true, version: 2 }] }));
    expect((await f.client.manageBots({ afterAccountId: null })).bots[0].enabled).toBe(true);
    await expect(f.client.setBot({ accountId: BOT, expectedVersion: -1, enabled: true })).rejects.toMatchObject({ code: 'invalid_request', outcomeUnknown: false });
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it('uses only the fixed same-origin caller-JWT endpoint and validates its owner', async () => {
    const f = fixture(); expect((await f.client.begin(input)).challenge).toBe(secret);
    expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.getSession).toHaveBeenCalledTimes(2);
    expect(f.fetch).toHaveBeenCalledWith('/api/hermes/zalo/begin', expect.objectContaining({ method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', mode: 'same-origin',
      headers: { authorization: 'Bearer fixture.browser.jwt', 'content-type': 'application/json', accept: 'application/json' } }));
    expect(JSON.parse(f.fetch.mock.calls[0][1]!.body as string)).toEqual({ ...input, organizationId: ORG });
  });
  it.each(['userId', 'organizationId', 'generation'] as const)('withholds a write reply when %s changes, without retrying', async field => {
    const f = fixture(); f.fetch.mockImplementationOnce(async () => {
      if (field === 'generation') f.scope.generation += 2; else f.scope[field] = BOT;
      return json(challenge());
    });
    await expect(f.client.begin(input)).rejects.toMatchObject({ code: 'context_changed', outcomeUnknown: true });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['foreign-owner', 'foreign-org', 'extra-secret', 'wrong-bot', 'expired-code'])('rejects %s in a successful-looking reply', async kind => {
    const f = fixture(), body = challenge();
    if (kind === 'foreign-owner') body.userId = BOT;
    if (kind === 'foreign-org') body.organizationId = BOT;
    if (kind === 'wrong-bot') body.accountId = CHALLENGE;
    if (kind === 'expired-code') body.expiresAt = Date.now() - 1;
    f.fetch.mockResolvedValueOnce(json(kind === 'extra-secret' ? { ...body, refreshToken: 'PRIVATE' } : body));
    await expect(f.client.begin(input)).rejects.toMatchObject({ code: 'invalid_response', outcomeUnknown: true });
  });
  it('separates known rejections from transport uncertainty and rejects status/code mismatch', async () => {
    const f = fixture(); f.fetch.mockResolvedValueOnce(json({ error: 'forbidden' }, 403));
    await expect(f.client.begin(input)).rejects.toMatchObject({ code: 'forbidden', outcomeUnknown: false });
    f.fetch.mockResolvedValueOnce(json({ error: 'forbidden' }, 503));
    await expect(f.client.begin(input)).rejects.toMatchObject({ code: 'invalid_response', outcomeUnknown: true });
    f.fetch.mockRejectedValueOnce(new Error('PRIVATE-JWT'));
    await expect(f.client.begin(input)).rejects.toMatchObject({ code: 'binding_outcome_unknown', message: 'binding_outcome_unknown', outcomeUnknown: true });
    expect(f.fetch).toHaveBeenCalledTimes(3);
  });
  it('rejects forged cursors, duplicate rows and returning an earlier page', async () => {
    const f = fixture(), row = { accountId: BOT, name: 'Company bot', zaloUid: '12345' };
    for (const [rows, after, next] of [[[row,row],null,null],[[row],BOT,null],[[row],null,CHALLENGE]] as const) {
      f.fetch.mockResolvedValueOnce(json({ userId: USER, organizationId: ORG, status: 'listed', bots: rows, nextCursor: next }));
      await expect(f.client.bots({ afterAccountId: after })).rejects.toMatchObject({ code: 'invalid_response', outcomeUnknown: false });
    }
  });
  it('rejects malformed request before any Auth/HTTP and handles cancellation before dispatch', async () => {
    const f = fixture(); await expect(f.client.begin({ ...input, expectedConnectionEpoch: 0 })).rejects.toMatchObject({ code: 'invalid_request', outcomeUnknown: false });
    const controller = new AbortController(); controller.abort();
    await expect(f.client.begin(input, { signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled', outcomeUnknown: false });
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.getSession).not.toHaveBeenCalled();
  });
  it('timeout cancels the transport and never accepts its late successful write', async () => {
    vi.useFakeTimers(); const f = fixture(20); let resolve!: (value: Response) => void;
    f.fetch.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = f.client.begin(input); const assertion = expect(pending).rejects.toMatchObject({ code: 'binding_outcome_unknown', outcomeUnknown: true });
    await vi.advanceTimersByTimeAsync(21); await assertion;
    expect(f.fetch.mock.calls[0][1]!.signal!.aborted).toBe(true);
    resolve(json(challenge())); await vi.advanceTimersByTimeAsync(1); expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects oversized replies and raw server diagnostics', async () => {
    const f = fixture(); f.fetch.mockResolvedValueOnce(new Response('x'.repeat(65537), { headers: { 'content-type': 'application/json' } }));
    await expect(f.client.begin(input)).rejects.toMatchObject({ code: 'binding_outcome_unknown' });
  });
});
