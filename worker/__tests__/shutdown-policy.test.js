import { describe, expect, it, vi } from 'vitest';
import { createShutdownPolicy, SHUTDOWN_DEADLINE_MS, SIGNAL_REPEAT_MS } from '../lib/shutdown-policy.js';

// Hand-rolled timers: the test owns firing, and can see unref/clear per timer.
function harness(cleanup) {
  const armed = [];
  const timers = {
    setTimeout: (fn, ms) => { const timer = { fn, ms, unref: vi.fn(), cleared: false }; armed.push(timer); return timer; },
    clearTimeout: timer => { if (timer) timer.cleared = true; },
  };
  const clock = { now: 1_000_000 };
  const work = Promise.withResolvers();
  const run = vi.fn(cleanup ?? (() => work.promise));
  const exit = vi.fn(), setExitCode = vi.fn(), logs = [];
  const policy = createShutdownPolicy({
    cleanup: run, exit, setExitCode, timers, now: () => clock.now, log: (...parts) => logs.push(parts.join(' ')),
  });
  const fireDeadline = () => armed.filter(timer => !timer.cleared).forEach(timer => timer.fn());
  return { policy, cleanup: run, exit, setExitCode, armed, clock, work, logs, fireDeadline };
}

describe('a lost lease always ends the process with a failing exit code', () => {
  it('exits 1 only after cleanup finished, so the restart policy starts a fresh process', async () => {
    const h = harness();
    const done = h.policy.onLeaseLost();
    expect(h.cleanup).toHaveBeenCalledOnce();
    expect(h.cleanup.mock.calls[0][0].reason).toBe('lease-lost');
    // Set up front: an event loop that drains by itself must not report success.
    expect(h.setExitCode).toHaveBeenCalledWith(1);
    expect(h.exit).not.toHaveBeenCalled();
    h.work.resolve(); await done;
    expect(h.exit.mock.calls).toEqual([[1]]);
  });
  it('still exits 1 when cleanup throws', async () => {
    const h = harness(async () => { throw new Error('fixture_cleanup_failed'); });
    await h.policy.onLeaseLost();
    expect(h.exit.mock.calls).toEqual([[1]]);
    expect(h.logs.join('\n')).toContain('fixture_cleanup_failed');
  });
  it('cuts a hung cleanup at the deadline with an unref\'d timer', async () => {
    const h = harness();
    h.policy.onLeaseLost();
    expect(h.armed.map(timer => timer.ms)).toEqual([SHUTDOWN_DEADLINE_MS]);
    expect(h.armed[0].unref).toHaveBeenCalledOnce();
    expect(h.exit).not.toHaveBeenCalled();
    h.fireDeadline();
    expect(h.exit.mock.calls).toEqual([[1]]);
    h.work.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(h.exit).toHaveBeenCalledOnce();
  });
});

describe('signals stop the worker cleanly and can never be swallowed', () => {
  it('exits 0 after cleanup and arms no deadline before cleanup asks for it', async () => {
    const h = harness();
    const done = h.policy.onSignal('SIGTERM');
    expect(h.cleanup.mock.calls[0][0].reason).toBe('signal');
    expect(h.armed).toEqual([]);
    h.cleanup.mock.calls[0][0].armDeadline();
    h.cleanup.mock.calls[0][0].armDeadline();
    expect(h.armed.map(timer => timer.ms)).toEqual([SHUTDOWN_DEADLINE_MS]);
    expect(h.armed[0].unref).toHaveBeenCalledOnce();
    h.work.resolve(); await done;
    expect(h.exit.mock.calls).toEqual([[0]]);
    expect(h.setExitCode).not.toHaveBeenCalled();
    expect(h.armed[0].cleared).toBe(true);
  });
  it('forces exit 1 when cleanup outlives the armed deadline', () => {
    const h = harness(({ armDeadline }) => { armDeadline(); return new Promise(() => {}); });
    h.policy.onSignal('SIGTERM');
    expect(h.exit).not.toHaveBeenCalled();
    h.fireDeadline();
    expect(h.exit.mock.calls).toEqual([[1]]);
    expect(h.logs.join('\n')).toContain('buộc thoát');
  });
  it('exits promptly on a repeated signal instead of returning silently', () => {
    const h = harness();
    h.policy.onSignal('SIGTERM');
    h.clock.now += SIGNAL_REPEAT_MS;
    h.policy.onSignal('SIGTERM');
    expect(h.exit.mock.calls).toEqual([[1]]);
    expect(h.cleanup).toHaveBeenCalledOnce();
  });
  it('treats the double delivery of one Ctrl-C as a single request', async () => {
    const h = harness();
    const done = h.policy.onSignal('SIGINT');
    h.clock.now += SIGNAL_REPEAT_MS - 1;
    h.policy.onSignal('SIGINT');
    expect(h.exit).not.toHaveBeenCalled();
    h.work.resolve(); await done;
    expect(h.exit.mock.calls).toEqual([[0]]);
    expect(h.cleanup).toHaveBeenCalledOnce();
  });
  it('exits at once when the signal arrives during a lease-loss shutdown', () => {
    const h = harness();
    h.policy.onLeaseLost();
    h.policy.onSignal('SIGTERM');
    expect(h.exit.mock.calls).toEqual([[1]]);
    expect(h.cleanup).toHaveBeenCalledOnce();
  });
  it('turns a draining signal shutdown into a bounded failing exit once the lease is lost', async () => {
    const h = harness();
    const done = h.policy.onSignal('SIGTERM');
    expect(h.armed).toEqual([]);
    h.policy.onLeaseLost();
    expect(h.cleanup).toHaveBeenCalledOnce();
    expect(h.armed.map(timer => timer.ms)).toEqual([SHUTDOWN_DEADLINE_MS]);
    h.work.resolve(); await done;
    expect(h.exit.mock.calls).toEqual([[1]]);
  });
});
