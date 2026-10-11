import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  latest: null, sessions: new Map(), loggingIn: new Set(), relogin: new Map(),
  login: vi.fn(), saved: vi.fn(), attached: vi.fn(), active: true,
}));
vi.mock('zca-js', () => ({ Zalo: class { loginQR(...args) { return state.login(...args); } } }));
vi.mock('qrcode', () => ({ default: { toDataURL: async () => 'data:qr' } }));
vi.mock('../lib/lease.js', () => ({ isLeaseActive: () => state.active }));
vi.mock('../lib/session-store.js', () => ({ saveSession: state.saved, loadSession: () => null }));
vi.mock('../lib/inbound.js', () => ({ attachSession: state.attached }));
vi.mock('../lib/ctx.js', () => ({
  sessions: state.sessions, loggingIn: state.loggingIn, reloginState: state.relogin, log: () => {}, uaFor: () => 'fixture-agent',
  sb: { from: () => {
    let patch;
    const filters = [];
    const q = {
      update: value => { patch = value; return q; }, select: () => q,
      eq: (key, value) => { filters.push(row => row[key] === value); return q; },
      is: (key, value) => { filters.push(row => (row[key] ?? null) === value); return q; },
      in: (key, values) => { filters.push(row => values.includes(row[key])); return q; },
      maybeSingle: async () => ({ data: state.latest, error: null }),
      then: (resolve, reject) => {
        const matches = state.latest && filters.every(filter => filter(state.latest));
        if (matches && patch) Object.assign(state.latest, patch);
        return Promise.resolve({ data: matches ? [{ id: state.latest.id }] : [], error: null }).then(resolve, reject);
      },
    };
    return q;
  } },
}));
import { startLoginQR } from '../lib/login.js';
const account = { id: 'account', organization_id: 'org', user_id: 'owner', status: 'connecting', login_requested_at: 'request-1' };
const api = () => ({ getOwnId: async () => 'zalo-uid', fetchAccountInfo: async () => ({}),
  getContext: () => ({ cookie: {}, imei: 'fixture' }), listener: { stop: vi.fn() } });
beforeEach(() => {
  state.latest = { ...account }; state.active = true;
  state.sessions.clear(); state.loggingIn.clear(); state.relogin.clear();
  state.login.mockReset(); state.saved.mockClear(); state.attached.mockClear();
});
describe('late QR callbacks respect cancellation', () => {
  it('cannot restore waiting_scan or attach after user disconnects', async () => {
    let resolveLogin, callback;
    state.login.mockImplementation((_, cb) => { callback = cb; return new Promise(resolve => { resolveLogin = resolve; }); });
    const work = startLoginQR(account);
    state.latest.status = 'disconnected';
    await callback({ type: 'qr', data: { image: 'fixture' } });
    const loggedIn = api(); resolveLogin(loggedIn);
    await work;
    expect(state.latest.status).toBe('disconnected');
    expect(state.saved).not.toHaveBeenCalled();
    expect(state.attached).not.toHaveBeenCalled();
    expect(loggedIn.listener.stop).toHaveBeenCalledOnce();
  });
  it('cannot attach a stale QR response to a newer connection request', async () => {
    const loggedIn = api();
    state.login.mockImplementation(async () => {
      state.latest.login_requested_at = 'request-2';
      return loggedIn;
    });
    await startLoginQR(account);
    expect(state.latest.status).toBe('connecting');
    expect(state.attached).not.toHaveBeenCalled();
    expect(state.saved).not.toHaveBeenCalled();
  });
  it('attaches the current successful QR request normally', async () => {
    state.login.mockResolvedValue(api());
    await startLoginQR(account);
    expect(state.latest.status).toBe('connected');
    expect(state.saved).toHaveBeenCalledOnce();
    expect(state.attached).toHaveBeenCalledOnce();
  });
  it('does not start provider login after worker lease has stopped', async () => {
    state.active = false;
    await startLoginQR(account);
    expect(state.login).not.toHaveBeenCalled();
  });
});
