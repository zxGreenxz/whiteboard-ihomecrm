import { describe, expect, it, vi } from 'vitest';
import { quickExpenseAttachmentKeys, runQuickExpenseQueue } from '../quickExpenseQueue';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

describe('runQuickExpenseQueue', () => {
  it('runs distinct sources concurrently and never exceeds three active vouchers', async () => {
    const work = Array.from({ length: 7 }, () => deferred<boolean>());
    const started: number[] = [];
    let active = 0;
    let maximum = 0;
    const queued = runQuickExpenseQueue(work, {
      concurrency: 3, attachmentKeys: item => [String(work.indexOf(item))],
      shouldStop: () => false, skip: vi.fn(),
      run: async (item, index) => {
        started.push(index); active++; maximum = Math.max(maximum, active);
        try { return await item.promise; } finally { active--; }
      },
    });
    await flush();
    expect(started).toEqual([0, 1, 2]);
    work[1].resolve(true);
    await flush();
    expect(started).toEqual([0, 1, 2, 3]);
    work.forEach(item => item.resolve(true));
    await queued;
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(maximum).toBe(3);
  });

  it('waits for the first shared original, then permits concurrent independent copies', async () => {
    const work = Array.from({ length: 5 }, () => deferred<boolean>());
    const started: number[] = [];
    const queued = runQuickExpenseQueue(work, {
      concurrency: 3, attachmentKeys: () => ['shared'], shouldStop: () => false, skip: vi.fn(),
      run: (item, index) => { started.push(index); return item.promise; },
    });
    await flush();
    expect(started).toEqual([0]);
    work[0].resolve(true);
    await flush();
    expect(started).toEqual([0, 1, 2, 3]);
    work.forEach(item => item.resolve(true));
    await queued;
    expect(started).toEqual([0, 1, 2, 3, 4]);
  });

  it('keeps overlapping sources reserved through the writer and does not consume on rejection', async () => {
    const work = Array.from({ length: 4 }, () => deferred<boolean>());
    const keys = [['one', 'two'], ['two'], ['other'], ['one']];
    const targets = work.map((item, index) => ({ item, keys: keys[index] }));
    const started: number[] = [];
    const queued = runQuickExpenseQueue(targets, {
      concurrency: 3, attachmentKeys: target => target.keys, shouldStop: () => false, skip: vi.fn(),
      run: (target, index) => { started.push(index); return target.item.promise; },
    });
    await flush();
    expect(started).toEqual([0, 2]);
    work[2].resolve(true);
    await flush();
    expect(started).toEqual([0, 2]);
    work[0].resolve(false);
    await flush();
    expect(started).toEqual([0, 2, 1, 3]);
    work.forEach(item => item.resolve(true));
    await queued;
  });

  it('after a known failure does not reuse an unconsumed shared original concurrently', async () => {
    const work = Array.from({ length: 3 }, () => deferred<boolean>());
    const started: number[] = [];
    const queued = runQuickExpenseQueue(work, {
      concurrency: 3, attachmentKeys: () => ['shared'], shouldStop: () => false, skip: vi.fn(),
      run: (item, index) => { started.push(index); return item.promise; },
    });
    await flush();
    work[0].resolve(false);
    await flush();
    expect(started).toEqual([0, 1]);
    work[1].resolve(true);
    await flush();
    expect(started).toEqual([0, 1, 2]);
    work[2].resolve(true);
    await queued;
  });

  it('stops new work and skips pending items while draining in-flight outcomes', async () => {
    const work = Array.from({ length: 6 }, () => deferred<boolean>());
    const started: number[] = [];
    const finished: number[] = [];
    let stopped = false;
    let settled = false;
    const skip = vi.fn();
    const queued = runQuickExpenseQueue(work, {
      concurrency: 3, attachmentKeys: () => [], shouldStop: () => stopped, skip,
      run: async (item, index) => {
        started.push(index);
        const result = await item.promise;
        finished.push(index);
        if (!result) stopped = true;
        return result;
      },
    }).then(() => { settled = true; });
    await flush();
    work[1].resolve(false);
    await flush();
    expect(started).toEqual([0, 1, 2]);
    expect(skip.mock.calls.map(call => call[1])).toEqual([3, 4, 5]);
    expect(settled).toBe(false);
    work[0].resolve(true);
    await flush();
    expect(settled).toBe(false);
    work[2].resolve(true);
    await queued;
    expect(finished).toEqual([1, 0, 2]);
  });

  it('drains all in-flight work before throwing the first unexpected rejection', async () => {
    const work = Array.from({ length: 5 }, () => deferred<boolean>());
    const started: number[] = [];
    const failure = new Error('Unexpected writer rejection');
    const skip = vi.fn();
    let settled = false;
    const queued = runQuickExpenseQueue(work, {
      concurrency: 3, attachmentKeys: () => [], shouldStop: () => false, skip,
      run: (item, index) => { started.push(index); return item.promise; },
    });
    const checked = expect(queued).rejects.toBe(failure);
    void queued.then(() => { settled = true; }, () => { settled = true; });
    await flush();
    work[0].reject(failure);
    await flush();
    expect(started).toEqual([0, 1, 2]);
    expect(skip.mock.calls.map(call => call[1])).toEqual([3, 4]);
    expect(settled).toBe(false);
    work[1].reject(new Error('Second failure'));
    work[2].resolve(true);
    await checked;
    expect(settled).toBe(true);
  });

  it('handles a synchronous callback throw without retaining an active entry', async () => {
    const failure = new Error('Synchronous failure');
    const skip = vi.fn();
    await expect(runQuickExpenseQueue([1, 2], {
      concurrency: 1, attachmentKeys: () => [], shouldStop: () => false, skip,
      run: () => { throw failure; },
    })).rejects.toBe(failure);
    expect(skip).toHaveBeenCalledWith(2, 1);
  });

  it('honors an already stopped run and rejects unbounded concurrency', async () => {
    const run = vi.fn();
    const skip = vi.fn();
    const options = { concurrency: 3, attachmentKeys: () => [], shouldStop: () => true, run, skip };
    await runQuickExpenseQueue([1, 2], options);
    expect(run).not.toHaveBeenCalled();
    expect(skip.mock.calls.map(call => call[0])).toEqual([1, 2]);
    await expect(runQuickExpenseQueue([], { ...options, concurrency: 4 })).rejects.toBeInstanceOf(RangeError);
  });
});

describe('quickExpenseAttachmentKeys', () => {
  it('uses the adoption storage identity, strips query aliases and keeps tenant scope', () => {
    const prefix = 'https://test.supabase.co/storage/v1/object/public/';
    const keys = (organization_id: string, attachments: string[]) =>
      quickExpenseAttachmentKeys({ organization_id, attachments });
    expect(keys('org-a', [`${prefix}payment-receipts/a.jpg?x=1`, `${prefix}payment-receipts/a.jpg?x=2`]))
      .toHaveLength(1);
    expect(keys('org-a', [`${prefix}payment-receipts/a.jpg`]))
      .not.toEqual(keys('org-b', [`${prefix}payment-receipts/a.jpg`]));
    expect(keys('org-a', [`${prefix}payment-receipts/a%20b.jpg`]))
      .not.toEqual(keys('org-a', [`${prefix}payment-receipts/a b.jpg`]));
    expect(keys('org-a', [`${prefix}payment-receipts/a/../b.jpg`]))
      .not.toEqual(keys('org-a', [`${prefix}payment-receipts/b.jpg`]));
    expect(keys('org-a', ['invalid?literal'])).toEqual([JSON.stringify(['org-a', 'invalid?literal'])]);
    expect(quickExpenseAttachmentKeys({ organization_id: 'org-a' })).toEqual([]);
  });
});
