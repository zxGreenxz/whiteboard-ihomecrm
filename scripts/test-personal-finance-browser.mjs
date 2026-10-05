#!/usr/bin/env node
// Provision disposable real roles only on guarded TEST; never persist credentials.
// Start the candidate app against TEST first, then run this wrapper for the fleet spec.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { credential, ketNoi, batBuocDichTest, psql, psqlJson, lit } from './test-env/lib.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const org = 'dddd0000-0000-4000-8000-000000000001';
const base = process.env.FLEET_BASE_URL || 'http://127.0.0.1:5187';
assert.match(base, /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/, 'Use a local candidate targeting TEST');
const preflightOnly = process.argv.includes('--self-check');
const spec = 'specs/personal-finance-real.spec.ts';
if (!preflightOnly) assert(existsSync(resolve(root, '.e2e-fleet', spec)), 'Real browser spec missing');
const cred = credential();
const { test: db } = await ketNoi(cred);
await batBuocDichTest(cred, db);
assert(cred.testPublishableKey, 'TEST publishable key required');
const url = `https://${cred.testRef}.supabase.co`;
const adminHeaders = { apikey: cred.testSecretKey, Authorization: `Bearer ${cred.testSecretKey}`, 'Content-Type': 'application/json' };
const emails = [];
const browserReport = resolve(tmpdir(), `personal-finance-browser-${randomUUID()}.json`);
const scopes = psqlJson(db, `select id from public.authorization_scopes where organization_id=${lit(org)} and scope_type='ORGANIZATION'`);
assert.equal(scopes.length, 1, 'DEMO TEST organization scope must already exist');
const organizationScope = scopes[0].id;

async function json(response, label) {
  assert(response.ok, `${label}: HTTP ${response.status}`);
  const body = await response.text();
  return body ? JSON.parse(body) : null;
}

async function rpc(actor, name, payload = {}) {
  return json(await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST', signal: AbortSignal.timeout(45000),
    headers: { apikey: cred.testPublishableKey, Authorization: `Bearer ${actor.jwt}`, 'Content-Type': 'application/json', 'Accept-Profile': 'public', 'Content-Profile': 'public' },
    body: JSON.stringify(payload),
  }), `actor ${actor.role} RPC ${name}`);
}

async function provision(role, permissions) {
  const email = `personal-browser-${role}-${randomBytes(8).toString('hex')}@example.invalid`;
  const password = randomBytes(24).toString('base64url');
  emails.push(email); // Recover this exact fixture even if the create response is lost.
  const user = await json(await fetch(`${url}/auth/v1/admin/users`, {
    method: 'POST', signal: AbortSignal.timeout(45000), headers: adminHeaders,
    body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { full_name: `TEST ví ${role}` } }),
  }), `create ${role}`);
  const membership = randomUUID();
  psql(db, `BEGIN;
    INSERT INTO public.organization_memberships(id,organization_id,user_id,member_type,status,valid_from)
      VALUES(${lit(membership)},${lit(org)},${lit(user.id)},'STAFF','ACTIVE',now()-interval '1 day');
    ${permissions.map(action => `WITH created AS (
      INSERT INTO public.member_permission_overrides(organization_id,membership_id,permission_key,effect,reason,scope_mode)
      VALUES(${lit(org)},${lit(membership)},${lit(`personal_finance.${action}`)},'ALLOW','temporary personal browser fixture','ORGANIZATION') RETURNING id)
      INSERT INTO public.member_override_scopes(organization_id,override_id,scope_id)
      SELECT ${lit(org)},id,${lit(organizationScope)} FROM created;`).join('\n')}
    COMMIT;`);
  const session = await json(await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST', signal: AbortSignal.timeout(45000),
    headers: { apikey: cred.testPublishableKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  }), `sign in ${role}`);
  assert.equal(session.user.id, user.id);
  const actor = { id: user.id, email, password, role, jwt: session.access_token };
  const effective = await rpc(actor, 'get_my_permissions_v2', { p_org: org });
  assert.notEqual(effective.__superadmin, true, 'fixture must not inherit an admin bypass');
  for (const action of ['view', 'create', 'edit', 'delete']) {
    const scope = effective.personal_finance?.[action];
    const allowed = scope === true || scope?.org_wide === true;
    assert.equal(allowed, permissions.includes(action), `${role} personal_finance.${action}`);
  }
  const company = effective.income_expenses?.create;
  assert(!(company === true || company?.org_wide || company?.building_ids?.length || company?.cashbook_ids?.length), 'personal-only fixture cannot write company money');
  await rpc(actor, 'personal_finance_bootstrap');
  const snapshot = await rpc(actor, 'personal_finance_snapshot');
  assert.equal(snapshot.owner_id, actor.id);
  assert.equal(snapshot.wallets.length, 1);
  assert.equal(snapshot.wallets[0].balance, 0);
  assert.equal(snapshot.transactions.length, 0);
  console.log(`PASS disposable ${role}: exact real permissions and zero personal wallet`);
  return actor;
}

try {
  const writer = await provision('writer', ['view', 'create', 'edit', 'delete']);
  const viewer = await provision('viewer', ['view']);
  assert.notEqual(writer.id, viewer.id);
  if (preflightOnly) {
    console.log('FIXTURE PREFLIGHT PASS; browser was not run');
  } else {
    const fixtures = { org, ref: cred.testRef, url, writer: { id: writer.id, email: writer.email, password: writer.password }, viewer: { id: viewer.id, email: viewer.email, password: viewer.password } };
    const child = spawn(process.execPath, [resolve(root, 'node_modules/@playwright/test/cli.js'), 'test', spec, '--workers=1', '--reporter=list,json', '--output', resolve(root, '.e2e-fleet/test-results/personal-finance-real')], {
      cwd: resolve(root, '.e2e-fleet'), windowsHide: true, stdio: 'inherit',
      env: { ...process.env, FLEET_BASE_URL: base, PERSONAL_FINANCE_TEST_FIXTURES: JSON.stringify(fixtures), PLAYWRIGHT_JSON_OUTPUT_NAME: browserReport },
    });
    const exitCode = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', code => resolveExit(code ?? 1)); });
    assert.equal(exitCode, 0, 'real personal finance browser suite failed');
    const result = JSON.parse(readFileSync(browserReport, 'utf8'));
    assert(result.stats.expected >= 2, 'writer and viewer browser scenarios must actually run');
    for (const key of ['unexpected', 'skipped', 'flaky']) assert.equal(result.stats[key], 0, `browser ${key} scenarios`);
    assert.equal(result.errors.length, 0, 'browser runner errors');
    // Browser success alone cannot stand in for actual persisted money operations.
    const committed = psqlJson(db, `select distinct payload->>'action' action from public.personal_finance_requests where user_id=${lit(writer.id)}`);
    const actions = new Set(committed.map(row => row.action));
    for (const action of ['wallet.create', 'wallet.update', 'category.create', 'transaction.create', 'transaction.update', 'transaction.delete', 'transaction.batch', 'transfer.create', 'budget.create', 'goal.create']) {
      assert(actions.has(action), `real TEST browser did not persist ${action}`);
    }
    assert.equal(psqlJson(db, `select count(*)::int n from public.personal_finance_requests where user_id=${lit(viewer.id)}`)[0].n, 0, 'view-only browser must not mutate');
    console.log('PASS real browser receipts cover wallet/category/transaction CRUD/transfer/budget/goal; viewer has zero writes');
  }
} finally {
  if (emails.length) {
    // Exact random emails only; never a broad prefix or pre-existing account.
    const ids = psqlJson(db, `select id from auth.users where email in (${emails.map(lit).join(',')})`).map(row => row.id);
    if (ids.length) {
      const list = ids.map(lit).join(',');
      psql(db, `BEGIN;SET LOCAL session_replication_role=replica;
        DELETE FROM public.member_override_scopes WHERE override_id IN (SELECT id FROM public.member_permission_overrides WHERE membership_id IN (SELECT id FROM public.organization_memberships WHERE user_id IN (${list})));
        DELETE FROM public.member_permission_overrides WHERE membership_id IN (SELECT id FROM public.organization_memberships WHERE user_id IN (${list}));
        DELETE FROM public.organization_memberships WHERE user_id IN (${list});
        DELETE FROM public.user_roles WHERE user_id IN (${list});COMMIT;`);
      for (const id of ids) assert((await fetch(`${url}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: adminHeaders, signal: AbortSignal.timeout(45000) })).ok, 'fixture auth cleanup failed');
      assert.equal(psqlJson(db, `select count(*)::int n from auth.users where id in (${list})`)[0].n, 0);
      assert.equal(psqlJson(db, `select count(*)::int n from public.personal_finance_requests where user_id in (${list})`)[0].n, 0);
    }
    console.log(`CLEANUP ${ids.length} disposable personal browser accounts`);
  }
  if (existsSync(browserReport)) unlinkSync(browserReport);
}
