import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bankEventService, isGmailHeartbeat } from '../service';
import { fixtureActor, fixtureEvent, fixtureSource } from './fixtures';
const calls = vi.hoisted(() => ({ session: vi.fn(), invoke: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { auth: { getSession: calls.session }, functions: { invoke: calls.invoke } } }));
beforeEach(() => { vi.clearAllMocks(); calls.session.mockResolvedValue({ data: { session: { user: { id: fixtureActor }, access_token: 'fixture-jwt' } }, error: null }); });
describe('bank admin transport boundary', () => {
  it('pins the caller JWT and parses only metadata in event lists', async () => {
    calls.invoke.mockResolvedValue({ data: { ok: true, data: { events: [{ ...fixtureEvent, body: 'must not enter list cache' }], nextCursor: null } }, error: null });
    const result = await bankEventService(fixtureActor).events({ sourceId: fixtureSource.id, limit: 25 });
    expect(calls.invoke).toHaveBeenCalledWith('bank-event-admin', expect.objectContaining({ headers: { Authorization: 'Bearer fixture-jwt' }, body: { action: 'list_events', sourceId: fixtureSource.id, limit: 25 } }));
    expect(result.events[0]).not.toHaveProperty('body');
  });
  it('rejects a stale actor before making any request', async () => {
    await expect(bankEventService('another-actor').sources()).rejects.toThrow('Phiên đăng nhập');
    expect(calls.invoke).not.toHaveBeenCalled();
  });
  it('discards results when the user switches during the request', async () => {
    calls.session.mockResolvedValueOnce({ data: { session: { user: { id: fixtureActor }, access_token: 'fixture-jwt' } }, error: null }).mockResolvedValueOnce({ data: { session: { user: { id: 'another-actor' } } }, error: null });
    calls.invoke.mockResolvedValue({ data: { ok: true, data: { sources: [fixtureSource] } }, error: null });
    await expect(bankEventService(fixtureActor).sources()).rejects.toThrow('Phiên đăng nhập');
  });
  it('rejects malformed envelopes instead of treating them as empty results', async () => {
    calls.invoke.mockResolvedValue({ data: { ok: true, data: { events: [{ id: 'incomplete' }], nextCursor: null } }, error: null });
    await expect(bankEventService(fixtureActor).events({})).rejects.toThrow('chưa hợp lệ');
  });
  it('does not repeat mutations or expose backend secrets on unknown outcomes', async () => {
    calls.invoke.mockResolvedValue({ data: null, error: new Error('private payload and credential') });
    await expect(bankEventService(fixtureActor).rotate(fixtureSource.id)).rejects.toMatchObject({ outcomeUnknown: true, message: expect.not.stringContaining('private payload') });
    expect(calls.invoke).toHaveBeenCalledOnce();
  });
  it('sanitizes rejected transport promises as well as returned errors', async () => {
    calls.invoke.mockRejectedValue(new Error('raw private SMS and token'));
    await expect(bankEventService(fixtureActor).create('Nguồn thử')).rejects.toMatchObject({ outcomeUnknown: true, message: expect.not.stringContaining('private') });
    expect(calls.invoke).toHaveBeenCalledOnce();
  });
  it('keeps parsed money summaries but never raw text in the list', async () => {
    const summary = { direction: 'in', amount: 1500000, balance: -20000, account: '••5847', description: 'NGUYEN VAN A CHUYEN TIEN', bank: 'ACB', transactedAt: '2026-10-09T10:20:30+07:00' };
    calls.invoke.mockResolvedValue({ data: { ok: true, data: { events: [{ ...fixtureEvent, eventType: 'email.received', summary, summaryStatus: 'parsed', body: 'raw' }, { ...fixtureEvent, id: 'second', summary: null, summaryStatus: 'unavailable' }], nextCursor: null } }, error: null });
    const result = await bankEventService(fixtureActor).events({ eventType: 'email.received' });
    expect(result.events[0]).toMatchObject({ eventType: 'email.received', summary, summaryStatus: 'parsed' });
    expect(result.events[0]).not.toHaveProperty('body');
    expect(result.events[1]).toMatchObject({ summary: null, summaryStatus: 'unavailable' });
  });
  it('rejects a malformed summary instead of showing a wrong amount', async () => {
    calls.invoke.mockResolvedValue({ data: { ok: true, data: { events: [{ ...fixtureEvent, summary: { direction: 'sideways', amount: '1.000' } }], nextCursor: null } }, error: null });
    await expect(bankEventService(fixtureActor).events({})).rejects.toThrow('chưa hợp lệ');
  });
  it('creates gmail sources and reads gmail heartbeats; legacy rows default to android', async () => {
    const gmail = { ...fixtureSource, kind: 'gmail', heartbeat: { channel: 'gmail', appVersion: 'gmail-script-1', schedule: 'night-10m', usedSecondsToday: 600, receivedAt: '2026-10-09T02:00:00Z' } };
    calls.invoke.mockResolvedValueOnce({ data: { ok: true, data: { source: gmail, token: 'a'.repeat(64) } }, error: null });
    const created = await bankEventService(fixtureActor).create('Gmail chủ', 'gmail');
    expect(calls.invoke).toHaveBeenCalledWith('bank-event-admin', expect.objectContaining({ body: { action: 'create_source', name: 'Gmail chủ', kind: 'gmail' } }));
    expect(created.source.kind).toBe('gmail');
    expect(isGmailHeartbeat(created.source.heartbeat!)).toBe(true);
    const { kind: _kind, ...legacy } = fixtureSource;
    calls.invoke.mockResolvedValueOnce({ data: { ok: true, data: { sources: [legacy] } }, error: null });
    const listed = await bankEventService(fixtureActor).sources();
    expect(listed.sources[0].kind).toBe('android');
    expect(isGmailHeartbeat(listed.sources[0].heartbeat!)).toBe(false);
  });
  it('accepts revoked sources without an active credential', async () => {
    const revoked = { ...fixtureSource, enabled: false, revokedAt: fixtureSource.createdAt, credentialFingerprint: null, credentialCreatedAt: null };
    calls.invoke.mockResolvedValue({ data: { ok: true, data: { sources: [revoked] } }, error: null });
    await expect(bankEventService(fixtureActor).sources()).resolves.toEqual({ sources: [revoked] });
  });
});
