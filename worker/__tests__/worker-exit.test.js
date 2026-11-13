// Boots the real worker/index.js against stubbed collaborators: the exit policy
// is only worth its tests if the bootstrap actually routes lease loss and
// signals through it (production hang 12→13/11/2026).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHUTDOWN_DEADLINE_MS } from '../lib/shutdown-policy.js';

const state = vi.hoisted(() => ({ onLost: null, release: null, bridge: null, sessions: new Map() }));
vi.mock('../lib/ctx.js', () => {
  // Every PostgREST chain of tick() resolves to an empty page without error.
  const query = new Proxy({}, { get: (_, key) => (key === 'then' ? resolve => resolve({ data: [], error: null }) : () => query) });
  return {
    sb: { from: () => query }, log: () => {}, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    POLL_MS: 2000, ORG_FILTER: [], SUPABASE_URL: 'http://fixture.invalid', SUPABASE_SERVICE_ROLE_KEY: 'fixture',
    sessions: state.sessions, orgCache: new Map(),
  };
});
vi.mock('../lib/session-store.js', () => ({ sessionKeyReady: () => true }));
vi.mock('../lib/lease.js', () => ({
  INSTANCE_ID: 'fixture-instance', claimLease: async () => true, releaseLease: () => state.release(),
  startLeaseHeartbeat: ({ onLost }) => { state.onLost = onLost; return () => {}; },
}));
vi.mock('../lib/login.js', () => ({ startLoginQR: vi.fn(), tryRelogin: vi.fn(), shouldRelogin: () => false }));
vi.mock('../lib/watchdog.js', () => ({ watchdogTick: vi.fn(), WATCHDOG_MS: 90_000 }));
vi.mock('../lib/queue.js', () => ({ processJob: vi.fn(), recoverInterruptedJobs: async () => ({}) }));
vi.mock('../lib/automation.js', () => ({ tickTuDongHoa: async () => {}, AUTOMATION_MS: 60_000 }));
vi.mock('../lib/hermes-native-bridge.js', () => ({ startNativeBridge: async () => state.bridge }));

const never = () => new Promise(() => {});
const signals = {};
let exit, exitCodeBefore;

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  Object.assign(state, { onLost: null, bridge: null, release: vi.fn(async () => {}) });
  state.sessions.clear();
  exitCodeBefore = process.exitCode;
  exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined);
  const on = process.on.bind(process);
  vi.spyOn(process, 'on').mockImplementation((event, listener) => {
    if (event !== 'SIGTERM' && event !== 'SIGINT') return on(event, listener);
    signals[event] = listener; return process;
  });
});
afterEach(() => { process.exitCode = exitCodeBefore; vi.restoreAllMocks(); vi.useRealTimers(); });

async function boot() {
  await import('../index.js');
  await vi.advanceTimersByTimeAsync(0);
  expect(state.onLost).toBeTypeOf('function');
  expect(vi.getTimerCount()).toBe(3); // tick + watchdog + automation: main() reached steady state
}

describe('worker process exit', () => {
  it('exits 1 after stopping sessions and releasing when the lease is lost', async () => {
    await boot();
    const stop = vi.fn();
    state.sessions.set('account', { api: { listener: { stop } } });
    await state.onLost();
    expect(stop).toHaveBeenCalledOnce();
    expect(state.release).toHaveBeenCalledOnce();
    expect(exit.mock.calls).toEqual([[1]]);
    expect(state.release.mock.invocationCallOrder[0]).toBeLessThan(exit.mock.invocationCallOrder[0]);
    expect(process.exitCode).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cuts a lease-loss shutdown that never finishes at the deadline', async () => {
    state.release = vi.fn(never);
    await boot();
    state.onLost();
    await vi.advanceTimersByTimeAsync(SHUTDOWN_DEADLINE_MS - 1);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit.mock.calls).toEqual([[1]]);
  });
  it('keeps a healthy SIGTERM a clean exit 0', async () => {
    await boot();
    await signals.SIGTERM();
    expect(state.release).toHaveBeenCalledOnce();
    expect(exit.mock.calls).toEqual([[0]]);
    expect(process.exitCode).toBe(exitCodeBefore);
  });
  it('does not ignore SIGTERM while a lease-loss shutdown is still running', async () => {
    state.release = vi.fn(never);
    await boot();
    state.onLost();
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).not.toHaveBeenCalled();
    signals.SIGTERM();
    expect(exit.mock.calls).toEqual([[1]]);
  });
  it('lets the first signal wait for the native provider drain, then bounds the rest', async () => {
    const drain = Promise.withResolvers();
    state.bridge = { close: () => drain.promise };
    state.release = vi.fn(never);
    await boot();
    signals.SIGINT();
    await vi.advanceTimersByTimeAsync(SHUTDOWN_DEADLINE_MS * 4);
    // Native runbook: no timeout may stand in for a provider that has not settled.
    expect(exit).not.toHaveBeenCalled();
    drain.resolve();
    await vi.advanceTimersByTimeAsync(SHUTDOWN_DEADLINE_MS);
    expect(exit.mock.calls).toEqual([[1]]);
  });
});
