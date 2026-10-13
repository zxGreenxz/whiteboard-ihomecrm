import { AsyncLocalStorage } from 'node:async_hooks';

/** Host-only lifetime accounting. track() must wrap the real dependency work,
 * inside any deadline race, including response-body cancellation. A caller's
 * timeout/result is deliberately separate from the evidence that work drained.
 * This observes promises; it does not prove remote rollback or provider refund.
 */
export function createDependencyScope() {
  const context = new AsyncLocalStorage(), global = new Set();
  let closing = false, closePromise;
  const collect = (set, promise) => {
    set.add(promise);
    void promise.then(() => set.delete(promise), () => set.delete(promise));
    return promise;
  };
  const drain = async set => {
    // A settling dependency can enqueue its next dependency in a continuation.
    // Keep accounting open until those continuations have run too.
    do { await Promise.allSettled([...set]); await Promise.resolve(); } while (set.size);
  };
  const track = work => {
    if (typeof work !== 'function') throw new TypeError('invalid_dependency_work');
    const scope = context.getStore();
    if (scope?.done || (closing && !scope)) throw new Error('dependency_scope_closed');
    const promise = Promise.resolve().then(work);
    collect(global, promise);
    if (scope) collect(scope.pending, promise);
    return promise;
  };
  const begin = work => {
    if (closing) throw new Error('dependency_scope_closed');
    if (typeof work !== 'function') throw new TypeError('invalid_dependency_work');
    const parent = context.getStore(), scope = { pending: new Set(), done: false };
    if (parent?.done) throw new Error('dependency_scope_closed');
    const result = context.run(scope, () => track(work));
    const drained = (async () => {
      await drain(scope.pending);
      scope.done = true;
    })();
    collect(global, drained);
    if (parent) collect(parent.pending, drained);
    return Object.freeze({ result, drained });
  };
  return Object.freeze({ begin, track, close() {
    if (!closePromise) { closing = true; closePromise = drain(global); }
    return closePromise;
  } });
}
