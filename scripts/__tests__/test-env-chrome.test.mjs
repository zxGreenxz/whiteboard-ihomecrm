import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';

import * as chrome from '../test-env/chrome.mjs';
const TEST_REF = 'hzulujxgonszuleqticb';
const TEST_ORIGIN = `https://${TEST_REF}.supabase.co`;
const LOCAL = 'http://127.0.0.1:43210';
const SHA = 'a'.repeat(40);

test('network guard refuses production, third party, credentials, ports and lookalike hosts', () => {
  assert.equal(typeof chrome.networkAllowed, 'function', 'network guard must exist');
  for (const url of [
    'https://tryymsxyyckgbrmmvozx.supabase.co/rest/v1/buildings',
    'https://files.ihomecrm.vn/private.jpg',
    `${TEST_ORIGIN}.evil.test/auth/v1/token`,
    `${TEST_ORIGIN}:8443/rest/v1/buildings`,
    'http://127.0.0.1:43211/',
    'https://person:password@hzulujxgonszuleqticb.supabase.co/rest/v1/',
    'file:///C:/Users/secrets',
  ]) assert.equal(chrome.networkAllowed(url, { localOrigin: LOCAL, testOrigin: TEST_ORIGIN }), false, url);
  for (const url of [`${LOCAL}/login`, `${TEST_ORIGIN}/auth/v1/token`, `${TEST_ORIGIN}/storage/v1/object/public/a`]) {
    assert.equal(chrome.networkAllowed(url, { localOrigin: LOCAL, testOrigin: TEST_ORIGIN }), true, url);
  }
  assert.equal(chrome.networkAllowed(`wss://${TEST_REF}.supabase.co/realtime/v1/websocket`, { localOrigin: LOCAL, testOrigin: TEST_ORIGIN }), true);
});

test('guard rejects production configured as TEST and non-loopback local origin', () => {
  assert.equal(typeof chrome.validateChromeTarget, 'function');
  for (const ref of ['tryymsxyyckgbrmmvozx', '', 'not-a-ref']) {
    assert.throws(() => chrome.validateChromeTarget({ testRef: ref, testPublishableKey: 'sb_publishable_public' }, SHA), /TEST/);
  }
  assert.throws(() => chrome.networkAllowed(`${TEST_ORIGIN}/`, { localOrigin: 'https://ihomecrm.vn', testOrigin: TEST_ORIGIN }), /loopback/);
});

test('build env pins TEST and SHA without inheriting frontend overrides or vault secrets', () => {
  assert.equal(typeof chrome.chromeBuildEnv, 'function');
  const env = chrome.chromeBuildEnv({ testRef: TEST_REF, testPublishableKey: 'sb_publishable_public' }, SHA, {
    PATH: 'safe-path', VITE_SUPABASE_URL: 'https://production.supabase.co',
    VITE_ANY_SECRET: 'private-value', TEST_SUPABASE_SECRET_KEY: 'secret-value', SUPABASE_PAT: 'private-token',
  });
  assert.equal(env.PATH, 'safe-path');
  assert.equal(env.VITE_SUPABASE_URL, TEST_ORIGIN);
  assert.equal(env.VITE_SUPABASE_PUBLISHABLE_KEY, 'sb_publishable_public');
  assert.equal(env.VITE_APP_ENV, 'test');
  assert.equal(env.VITE_BUILD_SHA, SHA);
  assert.equal(env.VITE_ANY_SECRET, undefined);
  assert.equal(env.TEST_SUPABASE_SECRET_KEY, undefined);
  assert.equal(env.SUPABASE_PAT, undefined);
});

test('build refuses secret/service key, missing public key and malformed SHA', () => {
  assert.equal(typeof chrome.validateChromeTarget, 'function');
  const serviceJwt = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from('{"role":"service_role"}').toString('base64url')}.signature`;
  for (const key of ['', undefined, 'sb_secret_private', serviceJwt]) {
    assert.throws(() => chrome.validateChromeTarget({ testRef: TEST_REF, testPublishableKey: key }, SHA), /public|publishable/i);
  }
  assert.throws(() => chrome.validateChromeTarget({ testRef: TEST_REF, testPublishableKey: 'sb_publishable_public' }, 'abc1234'), /SHA/);
});

test('only a missing TEST Storage byte is expected; API 404 and failed media 500 stay errors', () => {
  assert.equal(typeof chrome.expectedMissingMedia, 'function');
  assert.equal(chrome.expectedMissingMedia(`${TEST_ORIGIN}/storage/v1/object/public/photos/a.jpg`, 404, TEST_ORIGIN), true);
  for (const [url, status] of [
    [`${TEST_ORIGIN}/rest/v1/buildings`, 404],
    [`${TEST_ORIGIN}/storage/v1/object/public/photos/a.jpg`, 500],
    ['https://tryymsxyyckgbrmmvozx.supabase.co/storage/v1/object/public/a', 404],
  ]) assert.equal(chrome.expectedMissingMedia(url, status, TEST_ORIGIN), false);
});

test('Chrome TEST API pins public schema for GET and RPC POST instead of default api schema', async () => {
  assert.equal(typeof chrome.testApi, 'function');
  for (const [path, body, method] of [['/rest/v1/accounts?select=id', undefined, 'GET'], ['/rest/v1/rpc/list_my_cashbook_access_v2', {}, 'POST']]) {
    const result = await chrome.testApi(TEST_ORIGIN, { testPublishableKey: 'public-test-key' }, { authorization: 'Bearer test-jwt' }, path, body, {
      fetchImpl: async (url, options) => {
        assert.equal(url, `${TEST_ORIGIN}${path}`);
        assert.equal(options.method, method);
        const headers = new Headers(options.headers);
        const publicSchema = headers.get('accept-profile') === 'public' && headers.get('content-profile') === 'public';
        return new Response(JSON.stringify(publicSchema ? [{ id: 'visible' }] : { code: 'PGRST202' }), { status: publicSchema ? 200 : 404 });
      },
    });
    assert.deepEqual(result, [{ id: 'visible' }]);
  }
});

test('only exact TEST read cancellations are expected; writes and real network failures remain errors', () => {
  assert.equal(typeof chrome.expectedReadCancellation, 'function');
  for (const method of ['GET', 'HEAD']) {
    assert.equal(chrome.expectedReadCancellation({ url: `${TEST_ORIGIN}/rest/v1/notifications?select=id`, method, reason: 'net::ERR_ABORTED', boundary: 'navigate' }, TEST_ORIGIN), true);
  }
  const readRpc = { url: `${TEST_ORIGIN}/rest/v1/rpc/business_performance_organizations_v1`, method: 'POST', reason: 'net::ERR_ABORTED', boundary: 'organization' };
  assert.equal(chrome.expectedReadCancellation(readRpc, TEST_ORIGIN), true);
  for (const input of [
    { ...readRpc, url: `${TEST_ORIGIN}/rest/v1/rpc/cancel_income_voucher_v1` },
    { ...readRpc, url: `${TEST_ORIGIN}/rest/v1/rpc/create_income_expense_v1` },
    { ...readRpc, url: `${TEST_ORIGIN}/rest/v1/notifications` },
    { ...readRpc, reason: 'net::ERR_CONNECTION_RESET' },
    { ...readRpc, reason: 'net::ERR_ABORTED_OTHER' },
    { ...readRpc, boundary: undefined },
    { ...readRpc, responseStatus: 500 },
    { ...readRpc, url: 'https://tryymsxyyckgbrmmvozx.supabase.co/rest/v1/notifications', method: 'GET' },
    { ...readRpc, url: `${LOCAL}/rest/v1/notifications`, method: 'GET' },
  ]) assert.equal(chrome.expectedReadCancellation(input, TEST_ORIGIN), false);
});

test('completed TEST REST HEAD allows only exact abort after 2xx headers, never GET body loss', () => {
  assert.equal(typeof chrome.expectedCompletedHead, 'function');
  const head = { url: `${TEST_ORIGIN}/rest/v1/notifications?select=id`, method: 'HEAD', reason: 'net::ERR_ABORTED', responseStatus: 200 };
  for (const responseStatus of [200, 204, 206, 299]) {
    assert.equal(chrome.expectedCompletedHead({ ...head, responseStatus }, TEST_ORIGIN), true);
  }
  for (const patch of [
    { method: 'GET' }, { method: 'POST' }, { reason: 'net::ERR_CONNECTION_RESET' },
    { reason: 'net::ERR_ABORTED_OTHER' }, { responseStatus: null }, { responseStatus: undefined },
    { responseStatus: 199 }, { responseStatus: 300 }, { responseStatus: 404 }, { responseStatus: 500 },
    { url: `${TEST_ORIGIN}/rest/v1/rpc/read_income_expense_details_v1` },
    { url: `${TEST_ORIGIN}/auth/v1/user` }, { url: `${TEST_ORIGIN}/storage/v1/object/public/a` },
    { url: 'https://tryymsxyyckgbrmmvozx.supabase.co/rest/v1/notifications' },
    { url: `https://user:pass@${TEST_REF}.supabase.co/rest/v1/notifications` },
    { url: `${LOCAL}/rest/v1/notifications` },
  ]) assert.equal(chrome.expectedCompletedHead({ ...head, ...patch }, TEST_ORIGIN), false, JSON.stringify(patch));
});

test('Chrome idle waits for late reads and rechecks outstanding RPCs after an earlier idle', async () => {
  assert.equal(typeof chrome.createChromeNetworkIdle, 'function');
  vi.useFakeTimers();
  try {
    const network = chrome.createChromeNetworkIdle();
    let settled = false;
    const waiting = network.wait().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(400);
    const lateRead = {};
    network.started(lateRead);
    await vi.advanceTimersByTimeAsync(600);
    assert.equal(settled, false, 'read starting after boundary must delay navigation');
    network.finished(lateRead);
    await vi.advanceTimersByTimeAsync(499);
    assert.equal(settled, false, 'completion still requires a quiet interval');
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    assert.equal(settled, true);
    const writer = {};
    network.started(writer);
    settled = false;
    const next = network.wait().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(1000);
    assert.equal(settled, false, 'an earlier idle must not bypass a later RPC');
    network.finished(writer);
    await vi.advanceTimersByTimeAsync(500);
    await next;
    assert.equal(settled, true);
  } finally { vi.useRealTimers(); }
});

test('Chrome idle fails on bounded timeout and lease abort rather than navigating over pending work', async () => {
  assert.equal(typeof chrome.createChromeNetworkIdle, 'function');
  vi.useFakeTimers();
  try {
    const network = chrome.createChromeNetworkIdle();
    network.started({});
    const timedOut = assert.rejects(network.wait({ timeoutMs: 1000 }), /network.*timeout/i);
    await vi.advanceTimersByTimeAsync(1000);
    await timedOut;
    const controller = new AbortController();
    const interrupted = assert.rejects(network.wait({ signal: controller.signal }), /lease interrupted/);
    controller.abort(new Error('lease interrupted'));
    await interrupted;
    assert.equal(vi.getTimerCount(), 0);
    await assert.rejects(network.wait({ signal: controller.signal }), /lease interrupted/);
  } finally { vi.useRealTimers(); }
});

test('Chrome abort drain waits for a sent financial write to finish before cleanup', async () => {
  assert.equal(typeof chrome.createChromeMutationDrain, 'function');
  const drain = chrome.createChromeMutationDrain(TEST_ORIGIN);
  const requestId = {};
  drain.started(requestId, { url: `${TEST_ORIGIN}/rest/v1/rpc/create_income_expense_v1`, method: 'POST' });
  let settled = false;
  const pending = drain.drain(1000).then((value) => { settled = true; return value; });
  await Promise.resolve();
  assert.equal(settled, false);
  drain.finished(requestId);
  assert.deepEqual(await pending, { safe: true, pendingCount: 0, ambiguousCount: 0 });
});

test('Chrome abort drain retains unknown writes after network failure or bounded timeout', async () => {
  assert.equal(typeof chrome.createChromeMutationDrain, 'function');
  for (const mode of ['failed', 'timeout']) {
    const drain = chrome.createChromeMutationDrain(TEST_ORIGIN);
    const id = {};
    drain.started(id, { url: `${TEST_ORIGIN}/rest/v1/rpc/cancel_income_voucher_v1`, method: 'POST' });
    if (mode === 'failed') drain.finished(id, true);
    const receipt = await drain.drain(5);
    assert.equal(receipt.safe, false);
    assert.equal(receipt.pendingCount + receipt.ambiguousCount, 1);
  }
});

test('Chrome mutation drain treats completed gateway 5xx as unknown commit outcome', async () => {
  for (const status of [500, 502, 503, 504]) {
    const drain = chrome.createChromeMutationDrain(TEST_ORIGIN);
    const id = {};
    drain.started(id, { url: `${TEST_ORIGIN}/rest/v1/rpc/create_income_expense_v1`, method: 'POST' });
    drain.finished(id, false, status);
    assert.deepEqual(await drain.drain(5), { safe: false, pendingCount: 0, ambiguousCount: 1 });
  }
  const completed = chrome.createChromeMutationDrain(TEST_ORIGIN);
  const id = {};
  completed.started(id, { url: `${TEST_ORIGIN}/rest/v1/rpc/create_income_expense_v1`, method: 'POST' });
  completed.finished(id, false, 200);
  assert.deepEqual(await completed.drain(5), { safe: true, pendingCount: 0, ambiguousCount: 0 });
});

test('Chrome mutation drain tracks compat writer and excludes unrelated reads', async () => {
  assert.equal(typeof chrome.createChromeMutationDrain, 'function');
  const drain = chrome.createChromeMutationDrain(TEST_ORIGIN);
  drain.started({}, { url: `${TEST_ORIGIN}/rest/v1/notifications`, method: 'GET' });
  drain.started({}, { url: `${TEST_ORIGIN}/rest/v1/rpc/business_performance_organizations_v1`, method: 'POST' });
  assert.equal((await drain.drain(5)).safe, true);
  drain.started({}, { url: `${TEST_ORIGIN}/rest/v1/rpc/ie_compat_insert_v2`, method: 'POST' });
  assert.equal((await drain.drain(5)).safe, false);
});

test('receipt scrubber removes JWT, known credentials, query tokens and email addresses', () => {
  assert.equal(typeof chrome.sanitizeChromeEvidence, 'function');
  const evidence = chrome.sanitizeChromeEvidence({ error: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature failed private-value',
    path: `${TEST_ORIGIN}/storage/v1/object/sign/a?token=signed-private`, email: 'user@example.test' }, ['private-value']);
  const text = JSON.stringify(evidence);
  for (const forbidden of ['eyJhbGci', 'private-value', 'signed-private', 'user@example.test']) assert.ok(!text.includes(forbidden), forbidden);
});

test('receipt is never green for empty checks, unfinished lifecycle, or unexpected diagnostics', () => {
  assert.equal(typeof chrome.chromePassed, 'function');
  const good = { checks: { bundle: true, buildSha: true, loginOwner: true, testBanner: true, buildings: true, search: true,
    incomeExpense: true, createUi: true, autoApprovedPosted: true, cancelUi: true, reversed: true, balanceRestored: true },
  diagnostics: { consoleErrors: [], pageErrors: [], blockedRequests: [], httpErrors: [], requestFailures: [] },
  cleanup: { status: 'cancelled-audit-retained', balanceRestored: true }, errors: [] };
  assert.equal(chrome.chromePassed(good), true);
  assert.equal(chrome.chromePassed({ ...good, checks: {} }), false);
  assert.equal(chrome.chromePassed({ ...good, checks: { ...good.checks, bundle: false } }), false);
  assert.equal(chrome.chromePassed({ ...good, checks: { ...good.checks, cancelUi: false } }), false);
  assert.equal(chrome.chromePassed({ ...good, diagnostics: { ...good.diagnostics, consoleErrors: ['boom'] } }), false);
  assert.equal(chrome.chromePassed({ ...good, cleanup: { status: 'failed', balanceRestored: true } }), false);
});

test('loopback server serves only its build, pinned metadata, and SPA routes', async () => {
  assert.equal(typeof chrome.serveChromeBuild, 'function');
  const dir = await mkdtemp(join(tmpdir(), 'test-env-chrome-unit-'));
  let server;
  try {
    await writeFile(join(dir, 'index.html'), '<html>test build</html>');
    await writeFile(join(dir, 'build-meta.json'), JSON.stringify({ buildSha: SHA }));
    server = await chrome.serveChromeBuild(dir, TEST_ORIGIN);
    assert.match(server.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    const app = await fetch(`${server.origin}/income-expense`);
    assert.equal(await app.text(), '<html>test build</html>');
    assert.equal((await (await fetch(`${server.origin}/build-meta.json`)).json()).buildSha, SHA);
    assert.equal((await fetch(`${server.origin}/.env`)).status, 404);
    assert.equal((await fetch(`${server.origin}/missing.js`)).status, 404);
    assert.equal((await fetch(`${server.origin}/login`, { method: 'POST' })).status, 405);
    const badHostStatus = await new Promise((ok, fail) => {
      const req = request(`${server.origin}/x`, { headers: { Host: 'malicious.test' } }, (res) => { res.resume(); ok(res.statusCode); });
      req.on('error', fail);
      req.end();
    });
    assert.equal(badHostStatus, 403);
    assert.ok(app.headers.get('content-security-policy').includes(TEST_ORIGIN));
    assert.ok(!app.headers.get('content-security-policy').includes('tryymsxyyckgbrmmvozx'));
  } finally {
    await server?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function bundleFixture() {
  return {
    lazySource: Array.from({ length: 50 }, (_, n) => `export const Page${n} = lazy(() => import('../pages/Page${n}'));`).join('\n'),
    html: '<script type="module" src="/assets/index-12345678.js"></script>',
    files: [
      { file: 'index-12345678.js', bytes: 1000 },
      ...Array.from({ length: 50 }, (_, n) => ({ file: `Page${n}-12345678.js`, bytes: 100 })),
      ...Array.from({ length: 49 }, (_, n) => ({ file: `vendor${n}-12345678.js`, bytes: 100 })),
    ],
    baseline: { nguongEntryBytes: 1000 },
  };
}

test('Chrome bundle gate records real entry bytes and keeps every lazy chunk', () => {
  assert.equal(typeof chrome.assessChromeBundle, 'function');
  const receipt = chrome.assessChromeBundle(bundleFixture());
  assert.equal(receipt.passed, true);
  assert.equal(receipt.bytesEntry, 1000);
  assert.equal(receipt.entryLimitBytes, 1050);
  assert.equal(receipt.soChunk, 100);
  assert.equal(receipt.soTrangLazy, 50);
  assert.deepEqual(receipt.missingLazyChunks, []);
});

test('Chrome bundle gate rejects entry regression and a missing lazy chunk', () => {
  assert.equal(typeof chrome.assessChromeBundle, 'function');
  const oversized = bundleFixture();
  oversized.files[0].bytes = 1051;
  assert.equal(chrome.assessChromeBundle(oversized).passed, false);
  const missing = bundleFixture();
  missing.files[1].file = 'unexpected-12345678.js';
  const receipt = chrome.assessChromeBundle(missing);
  assert.equal(receipt.passed, false);
  assert.deepEqual(receipt.missingLazyChunks, ['Page0 (chunk Page0)']);
});

test('Chrome bundle gate fails closed for empty or malformed measurement inputs', () => {
  assert.equal(typeof chrome.assessChromeBundle, 'function');
  for (const patch of [{ files: [] }, { lazySource: '// export const Fake = lazy(() => import("fake"));' },
    { html: '' }, { html: '<script type="module" src="/assets/missing-12345678.js"></script>' },
    { baseline: {} }, { baseline: { nguongEntryBytes: 0 } }]) {
    assert.equal(chrome.assessChromeBundle({ ...bundleFixture(), ...patch }).passed, false);
  }
});
