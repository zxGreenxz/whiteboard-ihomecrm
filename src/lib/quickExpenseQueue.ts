interface QuickExpenseAttachmentSource {
  organization_id?: string | null;
  attachments?: readonly string[] | null;
}

/** Match adoption's literal storage object identity, including query-string aliases. */
export function quickExpenseAttachmentKeys(voucher: QuickExpenseAttachmentSource): string[] {
  const prefix = '/storage/v1/object/public/';
  return [...new Set((voucher.attachments ?? []).map(url => {
    const offset = url.indexOf(prefix);
    const source = offset < 0 ? url : url.slice(offset + prefix.length).split('?')[0];
    return JSON.stringify([voucher.organization_id, source]);
  }))];
}

interface QuickExpenseQueueOptions<T> {
  concurrency: number;
  attachmentKeys: (target: T) => readonly string[];
  shouldStop: () => boolean;
  /** True only after the money writer returns a confirmed success. */
  run: (target: T, index: number) => Promise<boolean>;
  skip: (target: T, index: number) => void;
}

/**
 * Limit work while reserving shared originals until the first confirmed posting.
 * Later uses must still adopt their own evidence: ATTACHED originals are copied.
 * Stopping never cancels an in-flight write or resolves before its result arrives.
 */
export async function runQuickExpenseQueue<T>(
  targets: readonly T[],
  options: QuickExpenseQueueOptions<NoInfer<T>>,
): Promise<void> {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 3) {
    throw new RangeError('Chi nhanh chỉ xử lý đồng thời từ 1 đến 3 phiếu.');
  }
  const pending = targets.map((target, index) => ({
    target, index, keys: [...new Set(options.attachmentKeys(target))],
  }));
  const active = new Map<number, Promise<void>>();
  const reserved = new Set<string>();
  const consumed = new Set<string>();
  let failed = false;
  let firstError: unknown;
  const fail = (error: unknown) => {
    if (!failed) firstError = error;
    failed = true;
  };

  while (pending.length || active.size) {
    let stopped = failed;
    try { stopped ||= options.shouldStop(); }
    catch (error) { fail(error); stopped = true; }
    if (stopped) {
      for (const { target, index } of pending.splice(0)) {
        try { options.skip(target, index); }
        catch (error) { fail(error); }
      }
    } else {
      while (active.size < options.concurrency) {
        const next = pending.findIndex(item => item.keys.every(key => !reserved.has(key)));
        if (next < 0) break;
        const [item] = pending.splice(next, 1);
        const claims = item.keys.filter(key => !consumed.has(key));
        claims.forEach(key => reserved.add(key));
        // Defer callbacks until the active entry exists, including synchronous throws.
        const task = Promise.resolve().then(() => options.run(item.target, item.index))
          .then(success => {
            if (success) item.keys.forEach(key => consumed.add(key));
          }, fail)
          .finally(() => {
            claims.forEach(key => reserved.delete(key));
            active.delete(item.index);
          });
        active.set(item.index, task);
      }
    }
    if (active.size) await Promise.race(active.values());
  }
  if (failed) throw firstError;
}
