import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseRefreshProvider, SupabaseRefreshError } from './supabase-refresh-provider.mjs';
import { createSupabaseAuthAdapter } from './supabase-adapter.mjs';

const USER = '10000000-0000-4000-8000-000000000001';
const SESSION = '20000000-0000-4000-8000-000000000001';
const NOW = 1_700_000_000_000;
const identity = () => ({ userId: USER, sessionId: SESSION, expiresAt: NOW + 60_000 });
const tokens = () => ({ access_token: 'new-access-fixture', refresh_token: 'new-refresh-fixture', token_type: 'bearer' });
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json; charset=utf-8' } });
const code = expected => error => error.code === expected && error.message === expected && error.cause === undefined;
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(overrides = {}) {
  const calls = [], verifications = [];
  const provider = createSupabaseRefreshProvider({ url: 'https://fixture.supabase.co', publishableKey: 'sb_publishable_fixture',
    clock: () => NOW, fetch: async (url, options) => { calls.push({ url, options }); return json(tokens()); },
    verifySession: async input => { verifications.push(input); return identity(); }, ...overrides });
  const controller = new AbortController();
  return { provider, calls, verifications, controller, input: { refreshToken: 'old-refresh-fixture', signal: controller.signal } };
}

test('refresh uses only the fixed HTTPS Auth grant with a bounded token body and publishable key', async () => {
  const f = setup();
  assert.deepEqual(await f.provider.refresh(f.input), { accessToken: tokens().access_token, refreshToken: tokens().refresh_token });
  assert.equal(f.calls.length, 1);
  const { url, options } = f.calls[0];
  assert.equal(url, 'https://fixture.supabase.co/auth/v1/token?grant_type=refresh_token');
  assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
  assert.deepEqual(options.headers, { apikey: 'sb_publishable_fixture', 'content-type': 'application/json', accept: 'application/json' });
  assert.deepEqual(JSON.parse(options.body), { refresh_token: 'old-refresh-fixture' });
  assert.equal(f.verifications.length, 0); // Manager explicitly verifies before sealing.
});

test('provider metadata never becomes verified identity or escapes the token projection', async () => {
  const f = setup({ fetch: async () => json({ ...tokens(), user: { id: 'forged-user' }, expires_at: Number.MAX_SAFE_INTEGER, debug: 'secret' }) });
  const candidate = await f.provider.refresh(f.input);
  assert.deepEqual(Object.keys(candidate), ['accessToken', 'refreshToken']);
  assert.deepEqual(await f.provider.verifySession({ accessToken: candidate.accessToken }), identity());
  assert.equal(f.verifications[0].accessToken, candidate.accessToken);
  assert.ok(f.verifications[0].signal instanceof AbortSignal);
});

test('existing Auth verifier validates actual user, JWT session and expiry without duplicate verification logic', async () => {
  const calls = [];
  const jwt = claims => `fixture.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
  const valid = jwt({ sub: USER, session_id: SESSION, role: 'authenticated', exp: (NOW + 60_000) / 1000 });
  const auth = createSupabaseAuthAdapter({ url: 'https://fixture.supabase.co', publishableKey: 'sb_publishable_fixture', clock: () => NOW,
    fetch: async (url, options) => { calls.push({ url, options }); return json({ id: USER }); } });
  const f = setup({ verifySession: auth.verifySession });
  assert.deepEqual(await f.provider.verifySession({ accessToken: valid }), identity());
  for (const claims of [
    { sub: '30000000-0000-4000-8000-000000000001', session_id: SESSION, role: 'authenticated', exp: (NOW + 60_000) / 1000 },
    { sub: USER, session_id: 'invalid', role: 'authenticated', exp: (NOW + 60_000) / 1000 },
    { sub: USER, session_id: SESSION, role: 'service_role', exp: (NOW + 60_000) / 1000 },
    { sub: USER, session_id: SESSION, role: 'authenticated', exp: NOW / 1000 },
  ]) await assert.rejects(f.provider.verifySession({ accessToken: jwt(claims) }), code('refresh_verification_failed'));
  assert.equal(calls.length, 5);
  for (const call of calls) assert.equal(String(call.url), 'https://fixture.supabase.co/auth/v1/user');
});

test('unsafe origins, credentials, invalid trusted verifier and unbounded settings are rejected', () => {
  for (const override of [
    { url: 'http://fixture.supabase.co' }, { url: 'https://user:secret@fixture.supabase.co' },
    { url: 'https://fixture.supabase.co/override' }, { url: 'https://fixture.supabase.co?grant_type=password' },
    { url: 'https://fixture.supabase.co/#fragment' }, { url: 'bad-url' },
    { publishableKey: 'sb_secret_fixture' }, { publishableKey: 'fixture.service_role.jwt' },
    { publishableKey: 'sb_publishable_abc\r\nInjected:true' }, { verifySession: null }, { fetch: null },
    { timeoutMs: 0 }, { timeoutMs: 30_001 }, { maxRequestBytes: Infinity }, { maxResponseBytes: 131_073 }, { clock: null },
  ]) assert.throws(() => setup(override), { message: 'invalid_refresh_provider_config' });
});

test('invalid request tokens, signals and grant overrides fail before any network or verifier call', async () => {
  const f = setup();
  for (const refreshToken of ['', 'a\nb', 'a b', '\u00e9', 'x'.repeat(16385), null]) {
    await assert.rejects(f.provider.refresh({ refreshToken }), code('refresh_invalid_request'));
    await assert.rejects(f.provider.verifySession({ accessToken: refreshToken }), code('refresh_invalid_request'));
  }
  for (const addition of [{ url: 'https://evil.invalid' }, { password: 'secret' }, { grant_type: 'password' }, { signal: {} }]) {
    await assert.rejects(f.provider.refresh({ ...f.input, ...addition }), code('refresh_invalid_request'));
  }
  await assert.rejects(f.provider.verifySession({ accessToken: 'fixture', userId: USER }), code('refresh_invalid_request'));
  assert.equal(f.calls.length, 0); assert.equal(f.verifications.length, 0);
});

test('serialized request cap accounts for JSON escaping before sending', async () => {
  const f = setup({ maxRequestBytes: 30 });
  await assert.rejects(f.provider.refresh({ refreshToken: '"'.repeat(10) }), code('refresh_request_too_large'));
  assert.equal(f.calls.length, 0);
});

test('HTTP failures have fixed safe codes, cancel their body, and never retry', async () => {
  for (const status of [400, 401, 403, 429, 500, 503]) {
    let count = 0, cancelled = false;
    const f = setup({ fetch: async () => {
      count++;
      return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('private-token-detail')); },
        cancel() { cancelled = true; } }), { status });
    } });
    await assert.rejects(f.provider.refresh(f.input), code([400, 401, 403].includes(status) ? 'refresh_rejected' : 'refresh_provider_unavailable'));
    assert.equal(count, 1); assert.equal(cancelled, true);
  }
});

test('lost response and verifier exceptions never expose raw errors or trigger retries', async () => {
  let count = 0;
  const f = setup({ fetch: async () => { count++; throw new Error('old-refresh-fixture'); },
    verifySession: async () => { throw new Error('new-access-fixture'); } });
  await assert.rejects(f.provider.refresh(f.input), code('refresh_provider_unavailable'));
  await assert.rejects(f.provider.verifySession({ accessToken: 'fixture' }), code('refresh_verification_failed'));
  assert.equal(count, 1);
  const forged = setup({ fetch: async () => { throw new SupabaseRefreshError('private-token-detail'); } });
  await assert.rejects(forged.provider.refresh(forged.input), code('refresh_provider_unavailable'));
});

test('HTTP 200 errors, malformed JSON and invalid token candidates fail closed', async () => {
  for (const value of [null, [], {}, { ...tokens(), error: 'secret' }, { ...tokens(), error_code: 'secret' },
    { ...tokens(), error_description: 'secret' }, { ...tokens(), token_type: 'basic' },
    { ...tokens(), access_token: '' }, { ...tokens(), refresh_token: 'x'.repeat(16385) },
    { ...tokens(), access_token: 'line\rbreak' }]) {
    const f = setup({ fetch: async () => json(value) });
    await assert.rejects(f.provider.refresh(f.input), code('refresh_invalid_response'));
  }
  for (const fetch of [async () => new Response('{', { headers: { 'content-type': 'application/json' } }),
    async () => new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } }),
    async () => new Response(JSON.stringify(tokens())), async () => new Response(null)]) {
    const f = setup({ fetch }); await assert.rejects(f.provider.refresh(f.input), code('refresh_invalid_response'));
  }
});

test('declared and streamed response byte caps both cancel the response', async () => {
  for (const declared of [false, true]) {
    let cancelled = false;
    const f = setup({ maxResponseBytes: 10, fetch: async () => new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode('more than ten bytes')); }, cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'application/json', ...(declared ? { 'content-length': '100' } : {}) } }) });
    await assert.rejects(f.provider.refresh(f.input), code('refresh_response_too_large'));
    assert.equal(cancelled, true);
  }
});

test('pre-cancelled calls never dispatch refresh or verification', async () => {
  const f = setup(); f.controller.abort(new Error('caller-private-detail'));
  await assert.rejects(f.provider.refresh(f.input), code('refresh_cancelled'));
  await assert.rejects(f.provider.verifySession({ accessToken: 'fixture', signal: f.controller.signal }), code('refresh_cancelled'));
  assert.equal(f.calls.length, 0); assert.equal(f.verifications.length, 0);
});

test('caller cancellation suppresses late refresh and cancels a late response body', async () => {
  let finish, sentSignal, cancelled = false;
  const f = setup({ fetch: async (_url, options) => { sentSignal = options.signal; return new Promise(resolve => { finish = resolve; }); } });
  const pending = f.provider.refresh(f.input); f.controller.abort();
  await assert.rejects(pending, code('refresh_cancelled')); assert.equal(sentSignal.aborted, true);
  finish(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await tick(); assert.equal(cancelled, true);
});

test('deadline bounds a transport or verifier that ignores AbortSignal', async () => {
  let sentSignal, verificationSignal;
  const f = setup({ timeoutMs: 5,
    fetch: (_url, options) => { sentSignal = options.signal; return new Promise(() => {}); },
    verifySession: input => { verificationSignal = input.signal; return new Promise(() => {}); } });
  await assert.rejects(f.provider.refresh(f.input), code('refresh_timeout'));
  await assert.rejects(f.provider.verifySession({ accessToken: 'fixture' }), code('refresh_timeout'));
  assert.equal(sentSignal.aborted, true); assert.equal(verificationSignal.aborted, true);
});

test('deadline covers a stalled response stream and cancels its reader', async () => {
  let cancelled = false;
  const f = setup({ timeoutMs: 5, fetch: async () => new Response(new ReadableStream({
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(f.provider.refresh(f.input), code('refresh_timeout')); assert.equal(cancelled, true);
});

test('cancelled or late verification never releases verified identity', async () => {
  let finish, verificationSignal;
  const f = setup({ verifySession: input => { verificationSignal = input.signal; return new Promise(resolve => { finish = resolve; }); } });
  const pending = f.provider.verifySession({ accessToken: 'fixture', signal: f.controller.signal });
  f.controller.abort(); await assert.rejects(pending, code('refresh_cancelled'));
  assert.equal(verificationSignal.aborted, true); finish(identity()); await tick();
});

test('verified identities require valid UUID user/session and live safe-integer expiry', async () => {
  for (const result of [null, {}, { ...identity(), userId: 'invalid' }, { ...identity(), sessionId: 'invalid' },
    { ...identity(), expiresAt: NOW }, { ...identity(), expiresAt: Infinity }, { ...identity(), expiresAt: NOW + 0.5 }]) {
    const f = setup({ verifySession: async () => result });
    await assert.rejects(f.provider.verifySession({ accessToken: 'fixture' }), code('refresh_verification_failed'));
  }
  const f = setup({ verifySession: async () => ({ ...identity(), accessToken: 'do-not-return', user: { email: 'private' } }) });
  assert.deepEqual(await f.provider.verifySession({ accessToken: 'fixture' }), identity());
  const invalidClock = setup({ clock: () => NaN });
  await assert.rejects(invalidClock.provider.verifySession({ accessToken: 'fixture' }), code('refresh_verification_failed'));
});

test('verification receives the original candidate despite caller mutation during the request', async () => {
  let finish, seen;
  const f = setup({ verifySession: input => { seen = input.accessToken; return new Promise(resolve => { finish = resolve; }); } });
  const input = { accessToken: 'original-candidate' };
  const pending = f.provider.verifySession(input); input.accessToken = 'replacement'; finish(identity());
  assert.deepEqual(await pending, identity()); assert.equal(seen, 'original-candidate');
});

test('default verifier reuses Auth validation through the fixed, bounded user endpoint', async () => {
  const accessToken = `fixture.${Buffer.from(JSON.stringify({ sub: USER, session_id: SESSION,
    role: 'authenticated', exp: (NOW + 60_000) / 1000 })).toString('base64url')}.signature`;
  const calls = [];
  const f = setup({ verifySession: undefined, fetch: async (url, options) => {
    calls.push({ url, options });
    return url.endsWith('/user') ? json({ id: USER, private_metadata: 'discard' }) : json({ ...tokens(), access_token: accessToken });
  } });
  const candidate = await f.provider.refresh(f.input);
  assert.deepEqual(await f.provider.verifySession({ accessToken: candidate.accessToken }), identity());
  assert.deepEqual(calls.map(call => call.url), ['https://fixture.supabase.co/auth/v1/token?grant_type=refresh_token',
    'https://fixture.supabase.co/auth/v1/user']);
  assert.equal(calls[1].options.headers.authorization, `Bearer ${accessToken}`);
  assert.equal(calls[1].options.method, 'GET'); assert.equal(calls[1].options.redirect, 'error');
});

test('default verifier bounds response bytes and rejects Auth denial without disclosing details', async () => {
  let cancelled = false;
  const f = setup({ verifySession: undefined, maxResponseBytes: 10, fetch: async () => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode('unbounded-user-metadata')); }, cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(f.provider.verifySession({ accessToken: 'fixture' }), code('refresh_response_too_large'));
  assert.equal(cancelled, true);
  const denied = setup({ verifySession: undefined, fetch: async () => new Response('private-auth-error', { status: 401 }) });
  await assert.rejects(denied.provider.verifySession({ accessToken: 'fixture' }), code('refresh_verification_failed'));
  const mixed = setup({ verifySession: undefined, fetch: async () => json({ id: USER, error: 'private-auth-error' }) });
  await assert.rejects(mixed.provider.verifySession({ accessToken: 'fixture' }), code('refresh_verification_failed'));
});
