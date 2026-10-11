import { describe, expect, it, vi } from 'vitest';
import { isCurrentLogin, reconcileAccountSessions, stopAccountSession } from '../lib/session-lifecycle.js';

describe('account sessions follow the latest user intent', () => {
  it('stops disconnected/removed/reconnecting sessions while retaining connected ones', () => {
    const sessions = new Map(['off', 'gone', 'qr', 'on'].map(id => [id, { api: { listener: { stop: vi.fn() } } }]));
    const old = new Map(sessions);
    expect(reconcileAccountSessions([
      { id: 'off', status: 'disconnected' }, { id: 'qr', status: 'connecting' }, { id: 'on', status: 'connected' },
    ], sessions)).toEqual(['off', 'gone', 'qr']);
    expect([...sessions.keys()]).toEqual(['on']);
    for (const id of ['off', 'gone', 'qr']) expect(old.get(id).api.listener.stop).toHaveBeenCalledOnce();
  });
  it('removes an old session before stop emits its close event', () => {
    const sessions = new Map();
    const stop = vi.fn(() => { expect(sessions.has('a')).toBe(false); });
    sessions.set('a', { api: { listener: { stop } } });
    expect(stopAccountSession('a', sessions)).toBe(true);
    expect(stopAccountSession('a', sessions)).toBe(false);
    expect(stop).toHaveBeenCalledOnce();
  });
  it('rejects QR/relogin completion after disconnect or a newer QR request', () => {
    const account = { id: 'a', organization_id: 'o', login_requested_at: 'request-1' };
    expect(isCurrentLogin(account, { ...account, status: 'waiting_scan' }, true)).toBe(true);
    expect(isCurrentLogin(account, { ...account, status: 'disconnected' }, true)).toBe(false);
    expect(isCurrentLogin(account, { ...account, status: 'waiting_scan', login_requested_at: 'request-2' }, true)).toBe(false);
    expect(isCurrentLogin(account, { ...account, status: 'connecting' })).toBe(false);
  });
});
