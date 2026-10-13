import test from 'node:test';
import assert from 'node:assert/strict';
import { createDependencyScope } from './dependency-scope.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(done => setImmediate(done));

test('result timeout does not drain the underlying dependency or allow close to finish', async () => {
  const scope = createDependencyScope(), late = deferred(), timeout = deferred();
  const handle = scope.begin(() => Promise.race([scope.track(() => late.promise), timeout.promise]));
  let drained = false, closed = false;
  void handle.drained.then(() => { drained = true; });
  timeout.resolve('timeout'); assert.equal(await handle.result, 'timeout');
  const closing = scope.close().then(() => { closed = true; });
  await tick(); assert.equal(drained, false); assert.equal(closed, false);
  late.resolve(); await handle.drained; await closing;
  assert.equal(drained, true); assert.equal(closed, true);
  assert.throws(() => scope.begin(() => {}), /closed/);
  assert.throws(() => scope.track(() => {}), /closed/);
});

test('independent profiles drain separately while shutdown waits for both', async () => {
  const scope = createDependencyScope(), a = deferred(), b = deferred();
  const first = scope.begin(() => scope.track(() => a.promise));
  const second = scope.begin(() => scope.track(() => b.promise));
  let secondDrained = false; void second.drained.then(() => { secondDrained = true; });
  a.resolve(); await first.drained; assert.equal(secondDrained, false);
  b.resolve(); await second.drained; await scope.close();
});

test('nested scopes propagate actual drain, including late continuation after outer result', async () => {
  const scope = createDependencyScope(), first = deferred(), second = deferred();
  let entered = false;
  const outer = scope.begin(() => {
    const inner = scope.begin(async () => {
      await scope.track(() => first.promise);
      entered = true;
      await scope.track(() => second.promise);
    });
    void inner.result.catch(() => {});
    return 'early';
  });
  assert.equal(await outer.result, 'early');
  let drained = false; void outer.drained.then(() => { drained = true; });
  const closing = scope.close();
  first.resolve(); await tick(); assert(entered); assert.equal(drained, false);
  second.resolve(); await outer.drained; await closing;
});

test('rejection is preserved on result while drained is metadata-only and idempotent close owns no retry', async () => {
  const scope = createDependencyScope(); let calls = 0;
  const handle = scope.begin(() => scope.track(() => { calls++; throw new Error('private fixture error'); }));
  await assert.rejects(handle.result, /private fixture error/); assert.equal(await handle.drained, undefined);
  const closed = scope.close(); assert.equal(closed, scope.close()); await closed; assert.equal(calls, 1);
});

test('unscoped tracked transport is still drained by backend close', async () => {
  const scope = createDependencyScope(), deferredWork = deferred();
  const work = scope.track(() => deferredWork.promise);
  let closed = false; const closing = scope.close().then(() => { closed = true; });
  await tick(); assert.equal(closed, false);
  deferredWork.resolve(); await work; await closing;
});
