import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrackedAuthFetch, exerciseRefresh, refreshEvidence, validateIndependentSessions } from '../test-hermes-refresh-auth.mjs';
import { createSupabaseRefreshProvider } from '../../infra/hermes-broker/supabase-refresh-provider.mjs';

const userId = '10000000-0000-4000-8000-000000000001';
const browser = { userId, sessionId: '20000000-0000-4000-8000-000000000001' };
const assistant = { userId, sessionId: '20000000-0000-4000-8000-000000000002' };

test('session validation refuses token sharing, forged user, and malformed provider session', () => {
  assert.doesNotThrow(() => validateIndependentSessions(userId, browser, assistant));
  for (const invalid of [browser, { ...assistant, userId: 'forged' }, { ...assistant, sessionId: 'invalid' }]) {
    assert.throws(() => validateIndependentSessions(userId, browser, invalid));
  }
});

function fixture(changedIdentity) {
  let signedIn = 0;
  const refreshCalls = [];
  const signIn = async () => ({ access_token: ++signedIn === 1 ? 'browser' : 'assistant', refresh_token: `refresh-${signedIn}` });
  const provider = {
    verifySession: async ({ accessToken }) => {
      if (accessToken === 'new-assistant' && changedIdentity) return changedIdentity;
      return accessToken.includes('browser') ? browser : assistant;
    },
    refresh: async ({ refreshToken }) => {
      refreshCalls.push(refreshToken);
      if (refreshToken.startsWith('hermes-invalid-')) throw Object.assign(new Error('refresh_rejected'), { code: 'refresh_rejected' });
      return { accessToken: refreshToken === 'refresh-1' ? 'new-browser' : 'new-assistant', refreshToken: 'candidate' };
    },
  };
  return { signIn, provider, refreshCalls, userId, signal: new AbortController().signal };
}

test('acceptance probes independent sessions and never retries a provider refresh', async () => {
  const f = fixture();
  const checks = await exerciseRefresh(f);
  assert.equal(checks.length, 4);
  assert(checks.every(check => check.status === 'PASS'));
  assert.deepEqual(f.refreshCalls.slice(0, 2), ['refresh-2', 'refresh-1']);
  assert.equal(f.refreshCalls.length, 3);
});

test('acceptance fails before browser refresh when assistant identity changes', async () => {
  const f = fixture(browser);
  await assert.rejects(exerciseRefresh(f), /assistant_refresh_identity_changed/);
  assert.equal(f.refreshCalls.length, 1);
});

test('an Auth outage cannot count as a successful invalid-token policy rejection', async () => {
  const f = fixture();
  const original = f.provider.refresh;
  f.provider.refresh = input => input.refreshToken.startsWith('hermes-invalid-')
    ? Promise.reject(Object.assign(new Error('refresh_provider_unavailable'), { code: 'refresh_provider_unavailable' })) : original(input);
  await assert.rejects(exerciseRefresh(f));
});

test('cleanup/lease interruption prevents later provider calls', async () => {
  const f = fixture();
  await assert.rejects(exerciseRefresh({ ...f, beforeCase: async () => { throw new Error('lease_lost'); } }), /lease_lost/);
  assert.equal(f.refreshCalls.length, 0);
});

test('provider timeout cannot permit cleanup before the underlying POST settles', async () => {
  const ctx = { url: 'https://example.supabase.co', signal: new AbortController().signal, writeState: { uncertain: false } };
  let settle, sentSignal;
  const tracked = createTrackedAuthFetch(ctx, async () => {}, { fetchImpl: async (_url, options) => {
    sentSignal = options.signal;
    return new Promise(resolve => { settle = resolve; });
  } });
  const provider = createSupabaseRefreshProvider({ url: ctx.url, publishableKey: 'sb_publishable_test', timeoutMs: 5, fetch: tracked.fetch });
  await assert.rejects(provider.refresh({ refreshToken: 'secret', signal: ctx.signal }), error => error.code === 'refresh_timeout');
  assert.equal(sentSignal, undefined);
  let cleanupEntered = false;
  const cleanup = tracked.drainWrites().then(() => { cleanupEntered = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cleanupEntered, false);
  settle(new Response('{}', { status: 200 }));
  await cleanup;
  assert.equal(cleanupEntered, true);
  assert.equal(ctx.writeState.uncertain, false);
  assert.throws(() => tracked.fetch(`${ctx.url}/auth/v1/token?grant_type=refresh_token`, { method: 'POST' }), /auth_transport_closing/);
});

test('unsettled or failed writes keep cleanup unverified and the TEST marker required', async () => {
  for (const outcome of ['pending', 'reject', 'server_error']) {
    const ctx = { url: 'https://example.supabase.co', signal: new AbortController().signal, writeState: { uncertain: false } };
    const tracked = createTrackedAuthFetch(ctx, async () => {}, { drainTimeoutMs: 5, fetchImpl: async () => {
      if (outcome === 'pending') return new Promise(() => {});
      if (outcome === 'reject') throw new Error('network');
      return new Response('{}', { status: 500 });
    } });
    const work = tracked.fetch(`${ctx.url}/auth/v1/token?grant_type=refresh_token`, { method: 'POST' });
    work.catch(() => {});
    if (outcome === 'pending') await assert.rejects(tracked.drainWrites(), /auth_write_settlement_unknown/);
    else { await Promise.allSettled([work]); await tracked.drainWrites(); }
    assert.equal(ctx.writeState.uncertain, true);
  }
});

test('a provider deadline during the lease check prevents a new POST after cleanup starts', async () => {
  const ctx = { url: 'https://example.supabase.co', signal: new AbortController().signal, writeState: { uncertain: false } };
  let finishLease, posted = 0;
  const tracked = createTrackedAuthFetch(ctx, () => new Promise(resolve => { finishLease = resolve; }), {
    fetchImpl: async () => { posted++; return new Response('{}'); },
  });
  const signal = new AbortController();
  const work = tracked.fetch(`${ctx.url}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', signal: signal.signal });
  signal.abort();
  const denied = assert.rejects(work);
  const drained = tracked.drainWrites();
  finishLease();
  await Promise.all([denied, drained]);
  assert.equal(posted, 0);
  assert.equal(ctx.writeState.uncertain, false);
});

test('receipt claims only refresh outcomes actually verified before failure', async () => {
  assert.equal(refreshEvidence([]).actualAuthRefresh, false);
  const f = fixture(browser), checks = [];
  await assert.rejects(exerciseRefresh({ ...f, onCheck: check => checks.push(check) }));
  assert.equal(checks.length, 1);
  assert.equal(refreshEvidence(checks).actualAuthRefresh, false);
  const success = await exerciseRefresh(fixture());
  assert.deepEqual(refreshEvidence(success), { actualAuthRefresh: true, independentBrowserRefresh: true,
    schemaChanges: false, productionWrites: false });
});
