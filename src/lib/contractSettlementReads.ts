import { fetchAllRows, type PagedQueryBuilder } from './supabaseFetchAll';

/** PostgREST resolves an aborted request as an error object. Keep intentional
 * cancellation out of fetchAllRows' data-error logging and null-result path. */
export function fetchSettlementRows<T>(build: PagedQueryBuilder, opts: { signal: AbortSignal; label?: string }) {
  return fetchAllRows<T>(async (from, to) => {
    if (opts.signal.aborted) throw new DOMException('Settlement read cancelled', 'AbortError');
    const result = await build(from, to);
    if (opts.signal.aborted) throw new DOMException('Settlement read cancelled', 'AbortError');
    return result;
  }, { label: opts.label });
}

/** Shared by list + modal readers in one QueryClient; stores no business data. */
export interface SettlementReadLimiter {
  run<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T>;
}

const limiters = new WeakMap<object, SettlementReadLimiter>();

export function settlementReadLimiter(client: object): SettlementReadLimiter {
  const existing = limiters.get(client);
  if (existing) return existing;
  let active = 0;
  const queue: (() => void)[] = [];
  const abortError = () => new DOMException('Settlement read cancelled', 'AbortError');
  const acquire = (signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const start = () => {
      signal.removeEventListener('abort', cancel);
      active++;
      resolve();
    };
    const cancel = () => {
      const index = queue.indexOf(start);
      if (index !== -1) queue.splice(index, 1);
      signal.removeEventListener('abort', cancel);
      reject(abortError());
    };
    if (active < 4) start();
    else {
      queue.push(start);
      signal.addEventListener('abort', cancel, { once: true });
    }
  });
  const limiter: SettlementReadLimiter = {
    async run(signal, read) {
      await acquire(signal);
      try {
        if (signal.aborted) throw abortError();
        return await read();
      } finally {
        active--;
        queue.shift()?.();
      }
    },
  };
  limiters.set(client, limiter);
  return limiter;
}

/** Bounded PostgREST URLs, without truncating the result set. */
export function settlementIdBatches(ids: readonly string[]): string[][] {
  const batches: string[][] = [];
  for (let start = 0; start < ids.length; start += 50) batches.push(ids.slice(start, start + 50));
  return batches;
}
