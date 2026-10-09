import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bankEventService } from '../service';
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
  it('accepts revoked sources without an active credential', async () => {
    const revoked = { ...fixtureSource, enabled: false, revokedAt: fixtureSource.createdAt, credentialFingerprint: null, credentialCreatedAt: null };
    calls.invoke.mockResolvedValue({ data: { ok: true, data: { sources: [revoked] } }, error: null });
    await expect(bankEventService(fixtureActor).sources()).resolves.toEqual({ sources: [revoked] });
  });
});
