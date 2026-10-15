import test from 'node:test';
import assert from 'node:assert/strict';
import { createDependencyScope } from './dependency-scope.mjs';
import { createStoreTransport } from './store-transport.mjs';
import { createSupabaseDurableAuthAdapter } from './supabase-durable-auth-adapter.mjs';
import { createSupabaseRoomReads } from './room-read-service.mjs';
import { createModelRelay } from './model-relay.mjs';

const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = 1_800_000_000_000;
const jwt = `header.${Buffer.from(JSON.stringify({ sub: id(1), role: 'authenticated', session_id: id(2), exp: now / 1000 + 3600 })).toString('base64url')}.signature`;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(done => setImmediate(done));
const upstream = { url: 'https://fixture.supabase.co', publishableKey: 'sb_publishable_fixture' };

test('store timeout destroys client but scope still awaits the actual query settlement', async () => {
  const scope = createDependencyScope(), query = deferred(), started = deferred(), releases = [];
  let count = 0;
  const transport = createStoreTransport({ expectedRole: 'hermes_store_test', dependencyScope: scope,
    pool: { async connect() { return { query() { count++; started.resolve(); return query.promise; }, release(v) { releases.push(v); } }; } } });
  const controller = new AbortController();
  const task = scope.begin(() => transport.call('readConnection', {}, { signal: controller.signal }));
  await started.promise; controller.abort();
  await assert.rejects(task.result, /store_cancelled/);
  let drained = false; void task.drained.then(() => { drained = true; });
  await tick(); assert.equal(drained, false); assert.deepEqual(releases, [true]);
  query.resolve({ rows: [] }); await task.drained; await scope.close(); assert.equal(count, 1);
});

for (const kind of ['auth', 'rooms']) test(`${kind} abort keeps late fetch and response cancellation inside its dependency scope`, async () => {
  const scope = createDependencyScope(), received = deferred(), fetchResult = deferred(), cancelled = deferred(), cancelStarted = deferred();
  const options = { ...upstream, dependencyScope: scope, clock: () => now, fetch() { received.resolve(); return fetchResult.promise; } };
  const controller = new AbortController();
  const port = kind === 'auth' ? createSupabaseDurableAuthAdapter(options) : createSupabaseRoomReads(options);
  const task = scope.begin(() => kind === 'auth'
    ? port.verifySession({ accessToken: jwt, signal: controller.signal })
    : port.availableRooms({ accessToken: jwt, organizationId: id(3) }, { signal: controller.signal }));
  await received.promise; controller.abort(); await assert.rejects(task.result);
  let drained = false; void task.drained.then(() => { drained = true; });
  await tick(); assert.equal(drained, false);
  fetchResult.resolve(new Response(new ReadableStream({ cancel() { cancelStarted.resolve(); return cancelled.promise; } }),
    { headers: { 'content-type': 'application/json' } }));
  await cancelStarted.promise; await tick(); assert.equal(drained, false);
  cancelled.resolve(); await task.drained; await scope.close();
});

test('relay separates bounded result from actual fetch/body drain and never retries a lost response', async () => {
  const received = deferred(), fetchResult = deferred(), cancelled = deferred(), cancelStarted = deferred(); let count = 0;
  const relay = createModelRelay({ supabaseUrl: upstream.url, publishableKey: upstream.publishableKey,
    allowedModels: ['openai:fixture'], fetch() { count++; received.resolve(); return fetchResult.promise; } });
  const controller = new AbortController();
  const handle = relay.beginCompletion({ accessToken: jwt, organizationId: id(3), requestId: id(4), signal: controller.signal,
    body: { model: 'openai:fixture', messages: [{ role: 'user', content: 'Fixture' }], max_tokens: 128 } });
  await received.promise; controller.abort(); await assert.rejects(handle.result, /cancelled/);
  let drained = false; void handle.drained.then(() => { drained = true; }); await tick(); assert.equal(drained, false);
  fetchResult.resolve(new Response(new ReadableStream({ cancel() { cancelStarted.resolve(); return cancelled.promise; } })));
  await cancelStarted.promise; await tick(); assert.equal(drained, false);
  cancelled.resolve(); assert.equal(await handle.drained, undefined); assert.equal(count, 1);
});

test('relay validation denial drains without issuing transport', async () => {
  let count = 0;
  const relay = createModelRelay({ supabaseUrl: upstream.url, publishableKey: upstream.publishableKey, fetch() { count++; } });
  const handle = relay.beginCompletion({});
  await assert.rejects(handle.result, /invalid_context/); assert.equal(await handle.drained, undefined); assert.equal(count, 0);
});
