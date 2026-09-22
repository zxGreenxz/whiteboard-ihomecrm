import { describe, expect, it, vi } from 'vitest';
import { fetchSettlementRows, settlementIdBatches, settlementReadLimiter } from '@/lib/contractSettlementReads';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('settlement read scheduling', () => {
  it('treats a cancelled PostgREST page as cancellation, without logging a data error', async () => {
    const abort = new AbortController();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = fetchSettlementRows(async () => {
      abort.abort();
      return { data: null, error: { message: 'AbortError' } };
    }, { signal: abort.signal });
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
  });
  it('shares four slots between independent readers using the same QueryClient', async () => {
    const client = {};
    const list = settlementReadLimiter(client);
    const modal = settlementReadLimiter(client);
    let active = 0, peak = 0;
    const done = Array.from({ length: 8 }, deferred);
    const started: number[] = [];
    const jobs = done.map((d, index) => (index % 2 ? list : modal).run(new AbortController().signal, async () => {
      active++; peak = Math.max(peak, active); started.push(index);
      await d.promise;
      active--;
    }));
    await vi.waitFor(() => expect(started).toHaveLength(4));
    expect(active).toBe(4);
    for (let index = 0; index < done.length; index++) {
      await vi.waitFor(() => expect(started).toContain(index));
      done[index].resolve();
    }
    await Promise.all(jobs);
    expect(peak).toBe(4);
    expect(active).toBe(0);
  });

  it('removes aborted queued jobs and leaves every slot usable by a later reader', async () => {
    const client = {};
    const limiter = settlementReadLimiter(client);
    const done = Array.from({ length: 4 }, deferred);
    const started = vi.fn();
    const held = done.map(d => limiter.run(new AbortController().signal, async () => { started(); await d.promise; }));
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(4));
    const signal = new AbortController();
    const cancelledRead = vi.fn();
    const queued = Array.from({ length: 12 }, () => limiter.run(signal.signal, cancelledRead));
    const cancelled = Promise.allSettled(queued);
    signal.abort();
    expect((await cancelled).every(result => result.status === 'rejected' && result.reason.name === 'AbortError')).toBe(true);
    done.forEach(d => d.resolve());
    await Promise.all(held);
    const later = vi.fn(async () => 'loaded');
    expect(await Promise.all(Array.from({ length: 4 }, () => settlementReadLimiter(client).run(new AbortController().signal, later))))
      .toEqual(['loaded', 'loaded', 'loaded', 'loaded']);
    expect(cancelledRead).not.toHaveBeenCalled();
  });

  it('releases rejected reads and never starts a pre-aborted request', async () => {
    const limiter = settlementReadLimiter({});
    const abort = new AbortController(); abort.abort();
    const read = vi.fn();
    await expect(limiter.run(abort.signal, read)).rejects.toMatchObject({ name: 'AbortError' });
    expect(read).not.toHaveBeenCalled();
    await Promise.all(Array.from({ length: 4 }, () =>
      expect(limiter.run(new AbortController().signal, async () => { throw new Error('offline'); })).rejects.toThrow('offline')));
    expect(await limiter.run(new AbortController().signal, async () => 'recovered')).toBe('recovered');
  });

  it('batches every ID exactly once without creating an empty final request', () => {
    const ids = Array.from({ length: 151 }, (_, i) => `id-${i}`);
    expect(settlementIdBatches(ids).map(b => b.length)).toEqual([50, 50, 50, 1]);
    expect(settlementIdBatches(ids).flat()).toEqual(ids);
    expect(settlementIdBatches(ids.slice(0, 100)).map(b => b.length)).toEqual([50, 50]);
    expect(settlementIdBatches([])).toEqual([]);
  });
});
