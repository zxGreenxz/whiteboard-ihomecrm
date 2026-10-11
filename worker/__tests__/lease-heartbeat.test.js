import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../lib/ctx.js', () => ({ sb: null, log: () => {} }));
import { startLeaseHeartbeat } from '../lib/lease.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
describe('lease renewal runs independently from provider jobs', () => {
  it('continues renewal while unrelated media work is unresolved', async () => {
    const heartbeat = vi.fn().mockResolvedValue(true);
    const onLost = vi.fn();
    const stop = startLeaseHeartbeat({ heartbeat, onLost });
    await vi.advanceTimersByTimeAsync(45000);
    expect(heartbeat).toHaveBeenCalledTimes(9);
    expect(onLost).not.toHaveBeenCalled();
    stop();
  });
  it('stops on takeover and never renews again', async () => {
    const heartbeat = vi.fn().mockResolvedValue(false);
    const onLost = vi.fn();
    startLeaseHeartbeat({ heartbeat, onLost });
    await vi.advanceTimersByTimeAsync(45000);
    expect(heartbeat).toHaveBeenCalledOnce();
    expect(onLost).toHaveBeenCalledOnce();
  });
  it('fails closed after its last known lease expires during DB failure', async () => {
    const heartbeat = vi.fn().mockResolvedValue(null);
    const onLost = vi.fn();
    startLeaseHeartbeat({ heartbeat, onLost });
    await vi.advanceTimersByTimeAsync(35000);
    expect(onLost).toHaveBeenCalledOnce();
  });
});
