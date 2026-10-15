// Guarded TEST only: independently issued browser/assistant sessions, actual
// Auth refresh, and complete synthetic-user cleanup. No business data or schema.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSupabaseRefreshProvider } from '../infra/hermes-broker/supabase-refresh-provider.mjs';
import { parseArguments, readTestCredentials, testFetch, validateCleanupEvidence, writeFixtureSql } from './test-hermes-broker-authz.mjs';
import { dichKetNoi } from './db-query.mjs';
import { batBuocDichTest, dangKyMatKhau, uri, psqlJson, lit } from './test-env/lib.mjs';
import { assertTestLease, markTestCleanupRequired, withTestCleanup, withTestLock } from './test-env/lock.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INPUTS = ['scripts/test-hermes-refresh-auth.mjs', 'scripts/test-hermes-broker-authz.mjs',
  'infra/hermes-broker/supabase-refresh-provider.mjs', 'infra/hermes-broker/supabase-adapter.mjs',
  'scripts/db-query.mjs', 'scripts/lib/vault.mjs', 'scripts/test-env/lib.mjs', 'scripts/test-env/lock.mjs'];
const demand = (value, code) => { if (!value) throw Object.assign(new Error(code), { code }); };
const codeOf = error => /^[a-z_]{1,80}$/.test(error?.code ?? '') ? error.code : 'refresh_acceptance_failed';
export const sourceIdentity = () => Object.fromEntries(INPUTS.map(file => [file,
  createHash('sha256').update(readFileSync(new URL(`../${file}`, import.meta.url))).digest('hex')]));

export function validateIndependentSessions(userId, browser, assistant) {
  demand(UUID.test(userId ?? '') && browser?.userId === userId && assistant?.userId === userId,
    'independent_session_user_mismatch');
  demand(UUID.test(browser?.sessionId ?? '') && UUID.test(assistant?.sessionId ?? '') &&
    browser.sessionId !== assistant.sessionId, 'independent_session_required');
}

export async function exerciseRefresh({ provider, userId, signIn, signal, beforeCase = async () => {}, onCheck = () => {} }) {
  const checks = [];
  const pass = name => { const check = { name, status: 'PASS' }; checks.push(check); onCheck(check); };
  const browser = await signIn();
  const assistant = await signIn();
  const browserIdentity = await provider.verifySession({ accessToken: browser.access_token, signal });
  const assistantIdentity = await provider.verifySession({ accessToken: assistant.access_token, signal });
  validateIndependentSessions(userId, browserIdentity, assistantIdentity);
  pass('separate_user_sessions_verified');
  await beforeCase();
  const refreshedAssistant = await provider.refresh({ refreshToken: assistant.refresh_token, signal });
  const nextAssistant = await provider.verifySession({ accessToken: refreshedAssistant.accessToken, signal });
  demand(nextAssistant.userId === userId && nextAssistant.sessionId === assistantIdentity.sessionId,
    'assistant_refresh_identity_changed');
  pass('assistant_refresh_keeps_verified_identity');
  await beforeCase();
  // The independent browser refresh token must remain usable after assistant refresh.
  const refreshedBrowser = await provider.refresh({ refreshToken: browser.refresh_token, signal });
  const nextBrowser = await provider.verifySession({ accessToken: refreshedBrowser.accessToken, signal });
  demand(nextBrowser.userId === userId && nextBrowser.sessionId === browserIdentity.sessionId,
    'browser_refresh_identity_changed');
  validateIndependentSessions(userId, nextBrowser, nextAssistant);
  pass('browser_refresh_unaffected_by_assistant_refresh');
  await beforeCase();
  await assert.rejects(provider.refresh({ refreshToken: `hermes-invalid-${randomUUID()}`, signal }),
    error => error?.code === 'refresh_rejected' && error.message === 'refresh_rejected');
  pass('invalid_refresh_rejected_with_safe_code');
  return checks;
}

// A provider deadline can return before its underlying HTTP call settles. Track
// the whole POST path (including its lease check), never abort a dispatched POST,
// and drain before cleanup. An unconfirmed write keeps the durable TEST marker.
export function createTrackedAuthFetch(ctx, beforeWrite, { fetchImpl = fetch, drainTimeoutMs = 30_000 } = {}) {
  demand(Number.isSafeInteger(drainTimeoutMs) && drainTimeoutMs > 0 && drainTimeoutMs <= 30_000, 'invalid_drain_timeout');
  const pending = new Set();
  let closing = false;
  return {
    fetch(url, options) {
      demand(!closing, 'auth_transport_closing');
      const parsed = new URL(url);
      demand(parsed.origin === ctx.url && ((options.method === 'POST' && parsed.pathname === '/auth/v1/token' &&
        parsed.search === '?grant_type=refresh_token') ||
        (options.method === 'GET' && parsed.pathname === '/auth/v1/user' && !parsed.search)), 'unexpected_auth_endpoint');
      if (options.method !== 'POST') return testFetch(ctx, url, options, { fetchImpl });
      const work = (async () => {
        await beforeWrite();
        options.signal?.throwIfAborted();
        return testFetch(ctx, url, { ...options, signal: undefined }, { write: true, fetchImpl });
      })();
      pending.add(work);
      work.then(() => pending.delete(work), () => pending.delete(work));
      return work;
    },
    async drainWrites() {
      closing = true;
      if (!pending.size) return;
      let timer;
      try {
        await Promise.race([Promise.allSettled([...pending]), new Promise((_, reject) => {
          timer = setTimeout(() => {
            ctx.writeState.uncertain = true;
            reject(Object.assign(new Error('auth_write_settlement_unknown'), { code: 'auth_write_settlement_unknown' }));
          }, drainTimeoutMs);
        })]);
      } finally { clearTimeout(timer); }
    },
  };
}

export function refreshEvidence(cases) {
  return { actualAuthRefresh: cases.some(item => item.name === 'assistant_refresh_keeps_verified_identity' && item.status === 'PASS'),
    independentBrowserRefresh: cases.some(item => item.name === 'browser_refresh_unaffected_by_assistant_refresh' && item.status === 'PASS'),
    schemaChanges: false, productionWrites: false };
}

async function context() {
  const cred = readTestCredentials();
  const db = await dichKetNoi('test');
  demand(db.ref === cred.testRef, 'test_target_mismatch');
  dangKyMatKhau([{ host: db.host, user: db.user, password: db.password }]);
  const test = uri(db.host, db.ref);
  const [markers] = psqlJson(test, "select to_regclass('test_env.danh_dau') is not null marker, to_regclass('test_env.active_run') is not null lease_marker");
  demand(markers?.marker && markers?.lease_marker, 'existing_test_markers_required');
  await batBuocDichTest(cred, test);
  return { cred, test, url: `https://${cred.testRef}.supabase.co` };
}

export async function runRefreshHarness({ reportPath = '.cache/hermes-refresh-auth.json' } = {}) {
  const initial = sourceIdentity();
  const run = randomUUID();
  const actor = { id: null, email: `hermes-refresh-${run}@example.invalid`, password: `H2!${randomBytes(24).toString('base64url')}` };
  const cases = [];
  let cleanupVerified = false, inputsUnchanged = false;
  let failure;
  try {
    const ctx = await context();
    await withTestLock(ctx, async lease => {
      const current = { ...ctx, signal: lease.signal, writeState: { uncertain: false } };
      const trackedAuth = createTrackedAuthFetch(current, () => assertTestLease(lease, ctx.test));
      const admin = { apikey: ctx.cred.testSecretKey, authorization: `Bearer ${ctx.cred.testSecretKey}`, 'content-type': 'application/json' };
      await assertTestLease(lease, ctx.test);
      markTestCleanupRequired(lease, ctx.test);
      try {
        const created = await testFetch(current, `${ctx.url}/auth/v1/admin/users`, { method: 'POST', headers: admin,
          body: JSON.stringify({ email: actor.email, password: actor.password, email_confirm: true,
            user_metadata: { full_name: 'Hermes refresh synthetic TEST fixture' } }) }, { write: true });
        demand(created.ok, 'fixture_auth_create_failed');
        actor.id = (await created.json()).id;
        demand(UUID.test(actor.id ?? ''), 'fixture_actor_id_invalid');
        const signIn = async () => {
          await assertTestLease(lease, ctx.test);
          const result = await testFetch(current, `${ctx.url}/auth/v1/token?grant_type=password`, { method: 'POST',
            headers: { apikey: ctx.cred.testPublishableKey, 'content-type': 'application/json' },
            body: JSON.stringify({ email: actor.email, password: actor.password }) }, { write: true });
          demand(result.ok, 'fixture_signin_failed');
          const session = await result.json();
          demand(session.user?.id === actor.id && typeof session.access_token === 'string' &&
            typeof session.refresh_token === 'string', 'fixture_session_invalid');
          return session;
        };
        const provider = createSupabaseRefreshProvider({ url: ctx.url, publishableKey: ctx.cred.testPublishableKey,
          fetch: trackedAuth.fetch,
        });
        await exerciseRefresh({ provider, userId: actor.id, signIn, signal: lease.signal,
          beforeCase: () => assertTestLease(lease, ctx.test), onCheck: check => cases.push(check) });
      } catch (error) {
        cases.push({ name: 'refresh_acceptance', status: 'FAIL', code: codeOf(error) });
      } finally {
        // Do not enter cleanup while any provider POST can still mutate Auth.
        await trackedAuth.drainWrites();
        await withTestCleanup(lease, ctx.test, async cleanupLease => {
          const cleanupContext = { ...current, signal: cleanupLease.signal };
          const rows = psqlJson(ctx.test, `select id from auth.users where email=${lit(actor.email)}`);
          demand(rows.length <= 1, 'fixture_actor_ambiguous');
          actor.id ??= rows[0]?.id ?? null;
          if (actor.id) {
            demand(UUID.test(actor.id), 'fixture_actor_id_invalid');
            await writeFixtureSql(current, `BEGIN; DELETE FROM public.profiles WHERE id=${lit(actor.id)}; COMMIT;`, { lease: cleanupLease });
            await assertTestLease(cleanupLease, ctx.test);
            const deleted = await testFetch(cleanupContext, `${ctx.url}/auth/v1/admin/users/${actor.id}`, {
              method: 'DELETE', headers: admin }, { write: true });
            demand([200, 404].includes(deleted.status), 'fixture_auth_cleanup_failed');
          }
          const [left] = psqlJson(ctx.test, `select
            (select count(*) from auth.users where email=${lit(actor.email)})::int actors,
            (select count(*) from public.profiles where id=${actor.id ? lit(actor.id) : 'NULL'})::int profiles,
            (select count(*) from auth.sessions where user_id=${actor.id ? lit(actor.id) : 'NULL'})::int sessions`);
          validateCleanupEvidence(left, current.writeState);
          cleanupVerified = true;
        });
      }
    });
  } catch (error) { failure = error; cases.push({ name: 'fixture_or_cleanup', status: 'FAIL', code: codeOf(error) }); }
  let final = null;
  try { final = sourceIdentity(); inputsUnchanged = JSON.stringify(initial) === JSON.stringify(final); }
  catch { cases.push({ name: 'source_identity_read', status: 'FAIL', code: 'source_unreadable_after_run' }); }
  if (!inputsUnchanged) cases.push({ name: 'source_identity', status: 'FAIL', code: 'source_changed_during_run' });
  cases.push({ name: 'cleanup_verified', status: cleanupVerified ? 'PASS' : 'FAIL' });
  const receipt = { version: 1, observedAt: new Date().toISOString(), environment: 'guarded-ihomecrm-test',
    sourceIdentity: { initialSha256: initial, finalSha256: final, inputsUnchanged },
    fixture: { run, actors: 1, organizations: 0, copiedAccountsUsed: false, cleanupVerified },
    evidence: refreshEvidence(cases),
    limitations: ['Independent sessions tested for a synthetic TEST user only.',
      'No durable store, CRM permissions, Hermes runtime, browser UI or production Auth settings tested.'],
    cases, passed: cases.filter(item => item.status === 'PASS').length, failed: cases.filter(item => item.status === 'FAIL').length };
  const target = resolve(reportPath); mkdirSync(dirname(target), { recursive: true });
  const bytes = JSON.stringify(receipt, null, 2) + '\n';
  writeFileSync(target.replace(/\.json$/, '') + `.${run}.json`, bytes, { flag: 'wx' });
  writeFileSync(target, bytes);
  demand(!failure && cleanupVerified && inputsUnchanged && receipt.failed === 0, 'refresh_auth_harness_failed');
  return { report: reportPath, passed: receipt.passed, cleanupVerified };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    parseArguments(process.argv.slice(2));
    runRefreshHarness().then(result => console.log(JSON.stringify(result))).catch(error => {
      console.error(codeOf(error)); process.exitCode = 1;
    });
  } catch (error) { console.error(codeOf(error)); process.exitCode = 1; }
}
