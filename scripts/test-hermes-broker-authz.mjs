// Real JWT acceptance for P1 on the separately guarded TEST project only.
// Fixture administration uses the TEST database/admin key. Every authorization
// assertion uses the publishable key + a new synthetic actor's actual JWT.
// available_rooms is a direct RPC control, not a claim that P1 exports that tool.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dichKetNoi } from './db-query.mjs';
import { giaTriVault } from './lib/vault.mjs';
import { PROD_REF, batBuocDichTest, dangKyMatKhau, uri, psql, psqlJson, lit } from './test-env/lib.mjs';
import { assertTestLease, markTestCleanupRequired, withTestCleanup, withTestLock } from './test-env/lock.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPORT = '.cache/hermes-broker-authz.json';
const SOURCE_INPUTS = Object.freeze([
  'scripts/test-hermes-broker-authz.mjs', 'infra/hermes-broker/broker.mjs',
  'infra/hermes-broker/stores.mjs', 'infra/hermes-broker/supabase-adapter.mjs',
  'scripts/test-env/lock.mjs', 'scripts/test-env/lib.mjs',
  'scripts/db-query.mjs', 'scripts/lib/vault.mjs',
]);
const sqlIds = ids => ids.map(id => { assert(UUID.test(id), 'fixture_uuid_required'); return lit(id); }).join(',');
const demand = (condition, code) => { if (!condition) throw Object.assign(new Error(code), { code }); };

export function captureSourceIdentity({ readSource = file => readFileSync(new URL(`../${file}`, import.meta.url)) } = {}) {
  return Object.fromEntries(SOURCE_INPUTS.map(file => [file, createHash('sha256').update(readSource(file)).digest('hex')]));
}

export const sourceIdentityUnchanged = (before, after) => JSON.stringify(before) === JSON.stringify(after);

export function parseArguments(args) {
  demand(args.length === 2 && args[0] === '--env' && args[1] === 'test', 'explicit_test_environment_required');
  return { environment: 'test' };
}

export function readTestCredentials({ env = process.env, readVault = name => giaTriVault(name, { env }) } = {}) {
  const get = name => env[name]?.trim() || readVault(name) || null;
  const cred = Object.fromEntries([
    ['testRef', 'TEST_SUPABASE_REF'], ['testSecretKey', 'TEST_SUPABASE_SECRET_KEY'],
    ['testPublishableKey', 'TEST_SUPABASE_PUBLISHABLE_KEY'], ['testPat', 'TEST_SUPABASE_PAT'],
  ].map(([key, name]) => [key, get(name)]));
  demand(/^[a-z0-9]{20}$/.test(cred.testRef ?? '') && cred.testRef !== PROD_REF, 'test_target_required');
  demand(cred.testSecretKey && cred.testPublishableKey, 'test_api_credentials_required');
  return cred;
}

async function testContext() {
  // Do not use credential()/ketNoi(): those load production and may create a seed.
  const cred = readTestCredentials();
  const db = await dichKetNoi('test');
  demand(db.ref === cred.testRef, 'test_target_mismatch');
  dangKyMatKhau([{ host: db.host, user: db.user, password: db.password }]);
  const test = uri(db.host, db.ref);
  const [markers] = psqlJson(test, `select to_regclass('test_env.danh_dau') is not null marker,
    to_regclass('test_env.active_run') is not null lease_marker`);
  demand(markers?.marker && markers?.lease_marker, 'existing_test_markers_required');
  await batBuocDichTest(cred, test);
  return { cred, test, url: `https://${cred.testRef}.supabase.co` };
}

export function fixturePlan() {
  const run = randomUUID();
  const actors = ['a', 'b', 'super'].map(label => ({
    label, email: `hermes-p1-${run}-${label}@example.invalid`,
    password: `H1!${randomBytes(24).toString('base64url')}`, id: null,
  }));
  const orgs = ['a', 'b'].map(label => ({ label, id: randomUUID(), roleId: randomUUID(),
    buildingId: randomUUID(), roomId: randomUUID(), slug: `hermes-p1-${run}-${label}` }));
  const memberships = [[0, 0], [1, 1], [2, 0], [2, 1]].map(([actor, org]) => ({
    actor, org, id: randomUUID(), bindingId: randomUUID(),
  }));
  return { run, actors, orgs, memberships };
}

export function fixtureSetupSql(plan) {
  demand(plan.actors.every(actor => UUID.test(actor.id ?? '')), 'fixture_actor_ids_required');
  const statements = [];
  for (const org of plan.orgs) {
    statements.push(`insert into public.organizations(id,slug,name) values (${lit(org.id)},${lit(org.slug)},'Hermes P1 synthetic fixture');`);
    statements.push(`insert into public.organization_roles(id,organization_id,name,is_system) values (${lit(org.roleId)},${lit(org.id)},'Hermes P1 rooms reader',false);`);
    statements.push(`insert into public.role_permissions(organization_id,role_id,permission_key,effect) values (${lit(org.id)},${lit(org.roleId)},'rooms.view','ALLOW');`);
    statements.push(`insert into public.buildings(id,user_id,organization_id,name,province,district,ward) values (${lit(org.buildingId)},${lit(plan.actors[2].id)},${lit(org.id)},'Hermes synthetic building','TEST','TEST','TEST');`);
    statements.push(`insert into public.rooms(id,building_id,organization_id,name,rent_price,deposit_amount,status) values (${lit(org.roomId)},${lit(org.buildingId)},${lit(org.id)},'Hermes synthetic room',100,100,'AVAILABLE');`);
  }
  for (const member of plan.memberships) {
    const org = plan.orgs[member.org];
    statements.push(`insert into public.organization_memberships(id,organization_id,user_id,member_type,status,valid_from) values (${lit(member.id)},${lit(org.id)},${lit(plan.actors[member.actor].id)},'STAFF','ACTIVE',now()-interval '2 days');`);
    statements.push(`insert into public.role_bindings(id,organization_id,membership_id,role_id,valid_from) values (${lit(member.bindingId)},${lit(org.id)},${lit(member.id)},${lit(org.roleId)},now()-interval '2 days');`);
    statements.push(`insert into public.role_binding_scopes(organization_id,role_binding_id,scope_id) select ${lit(org.id)},${lit(member.bindingId)},s.id from public.authorization_scopes s where s.organization_id=${lit(org.id)} and s.scope_type='BUILDING' and s.building_id=${lit(org.buildingId)};`);
  }
  statements.push(`insert into public.super_admins(user_id,note) values (${lit(plan.actors[2].id)},'Hermes P1 synthetic TEST fixture');`);
  return `BEGIN;\n${statements.join('\n')}\nCOMMIT;`;
}

export function fixtureCleanupSql(plan) {
  const orgs = sqlIds(plan.orgs.map(org => org.id));
  const actorIds = plan.actors.map(actor => actor.id).filter(Boolean);
  return `BEGIN;
    delete from public.role_binding_scopes where organization_id in (${orgs});
    delete from public.role_bindings where organization_id in (${orgs});
    delete from public.role_permissions where organization_id in (${orgs});
    delete from public.organization_roles where organization_id in (${orgs});
    delete from public.authorization_scopes where organization_id in (${orgs});
    delete from public.rooms where id in (${sqlIds(plan.orgs.map(org => org.roomId))});
    delete from public.buildings where id in (${sqlIds(plan.orgs.map(org => org.buildingId))});
    delete from public.super_admins where user_id in (${actorIds.length ? sqlIds(actorIds) : 'NULL'});
    delete from public.organization_memberships where organization_id in (${orgs});
    delete from public.organizations where id in (${orgs});
    COMMIT;`;
}

export async function testFetch(ctx, url, options, { write = false, fetchImpl = fetch } = {}) {
  ctx.signal?.throwIfAborted();
  try {
    // Never abort an in-flight write then release the lease while the server runs it.
    const response = await fetchImpl(url, { ...options, ...(write ? {} : { signal: ctx.signal }) });
    if (write && response.status >= 500) ctx.writeState.uncertain = true;
    return response;
  } catch (error) {
    if (write) ctx.writeState.uncertain = true;
    throw error;
  }
}

export async function writeFixtureSql(ctx, sql, { lease, assertLease = assertTestLease, execute = psql } = {}) {
  await assertLease(lease, ctx.test);
  try { await execute(ctx.test, sql, { timeoutMs: 30_000 }); }
  catch {
    // psql can lose its connection/timeout after dispatch without proving whether
    // the backend committed. Keep the TEST marker even if cleanup currently sees
    // zero rows; no retry or cancellation/settlement guarantee exists here.
    ctx.writeState.uncertain = true;
    throw Object.assign(new Error('fixture_sql_failed'), { code: 'fixture_sql_failed' });
  }
}

export function validateCleanupEvidence(counts, writeState) {
  demand(counts && Object.values(counts).every(value => value === 0), 'fixture_cleanup_incomplete');
  demand(!writeState.uncertain, 'fixture_write_outcome_uncertain');
}

async function rpc(ctx, accessToken, name, args) {
  const response = await testFetch(ctx, `${ctx.url}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: { apikey: ctx.cred.testPublishableKey, Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json', 'Content-Profile': 'public' }, body: JSON.stringify(args),
  });
  const body = await response.json();
  return { status: response.status, body };
}

const parseContext = result => {
  demand(result?.isError === false && result.content?.[0]?.type === 'text', 'broker_result_invalid');
  return JSON.parse(result.content[0].text);
};

export async function expectBrokerRejection(operation, expectedCodes) {
  let observed;
  try { await operation(); } catch (error) { observed = error?.code; }
  demand(expectedCodes.includes(observed), 'broker_expected_rejection_missing');
}

function reportError(error) {
  return /^[a-z][a-z0-9_]{0,80}$/.test(error?.code ?? '') ? error.code : 'assertion_or_dependency_failed';
}

export async function runHarness({ context, lease, reportPath = REPORT, sourceIdentity } = {}) {
  const initialSources = sourceIdentity ?? captureSourceIdentity();
  const connection = context ?? await testContext();
  if (!lease) return withTestLock(connection, held => runHarness({ context: connection, lease: held, reportPath, sourceIdentity: initialSources }));
  const ctx = { ...connection, signal: lease.signal, writeState: { uncertain: false } };
  const { createBroker } = await import('../infra/hermes-broker/broker.mjs');
  const { createSupabaseAuthAdapter } = await import('../infra/hermes-broker/supabase-adapter.mjs');
  const plan = fixturePlan();
  const cases = [];
  const adapterObservations = [];
  const check = async (name, operation) => {
    await assertTestLease(lease, ctx.test);
    try { await operation(); cases.push({ name, status: 'PASS' }); }
    catch (error) { cases.push({ name, status: 'FAIL', code: reportError(error) }); }
  };
  const sqlWrite = (sql, held = lease) => writeFixtureSql(ctx, sql, { lease: held });
  let cleanupRequired = false;
  let cleanupVerified = false;
  let authenticatedActors = 0;
  let setupStage = 'auth_create';
  try {
    await assertTestLease(lease, ctx.test);
    markTestCleanupRequired(lease, ctx.test);
    cleanupRequired = true;
    for (const actor of plan.actors) {
      const response = await testFetch(ctx, `${ctx.url}/auth/v1/admin/users`, {
        method: 'POST', headers: { apikey: ctx.cred.testSecretKey, Authorization: `Bearer ${ctx.cred.testSecretKey}`,
          'Content-Type': 'application/json' },
        body: JSON.stringify({ email: actor.email, password: actor.password, email_confirm: true,
          user_metadata: { full_name: 'Hermes P1 synthetic fixture' } }),
      }, { write: true });
      demand(response.ok, 'fixture_auth_create_failed');
      actor.id = (await response.json()).id;
      demand(UUID.test(actor.id ?? ''), 'fixture_actor_id_invalid');
      const signIn = await testFetch(ctx, `${ctx.url}/auth/v1/token?grant_type=password`, {
        method: 'POST', headers: { apikey: ctx.cred.testPublishableKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: actor.email, password: actor.password }),
      }, { write: true });
      demand(signIn.ok, 'fixture_signin_failed');
      const session = await signIn.json();
      demand(session.user?.id === actor.id && typeof session.access_token === 'string', 'fixture_session_invalid');
      actor.accessToken = session.access_token;
      authenticatedActors += 1;
    }
    setupStage = 'fixture_sql';
    await sqlWrite(fixtureSetupSql(plan));
    setupStage = 'broker_connection';
    const auth = createSupabaseAuthAdapter({ url: ctx.url, publishableKey: ctx.cred.testPublishableKey,
      fetch: async (url, options) => {
        const started = performance.now();
        const endpoint = new URL(url).pathname.split('/').at(-1);
        demand(['user', 'get_authorization_context_v1', 'get_my_organizations', 'copilot_org_scope_buildings_v1'].includes(endpoint), 'unexpected_adapter_endpoint');
        const response = await fetch(url, options);
        let errorCode = null;
        if (!response.ok) {
          try { const body = await response.clone().json(); if (/^[A-Z0-9_]{1,32}$/.test(body?.code ?? '')) errorCode = body.code; } catch { /* metadata only */ }
        }
        adapterObservations.push({ endpoint, status: response.status, errorCode, elapsedMs: Math.round(performance.now() - started) });
        return response;
      },
    });
    const broker = createBroker({ auth });
    const restrictions = { read: ['assistant.context.read', 'rooms.view'], action: [] };
    const issue = (actorIndex, orgIndex, target = broker) => target.issueConnection({
      accessToken: plan.actors[actorIndex].accessToken, organizationId: plan.orgs[orgIndex].id, restrictions,
    });
    const readContext = (issued, target = broker) => target.callTool(issued.token, 'crm_auth_context', {}).then(parseContext);
    const directRooms = (actorIndex, orgIndex) => rpc(ctx, plan.actors[actorIndex].accessToken,
      'copilot_available_rooms_v1', { p_organization_id: plan.orgs[orgIndex].id });
    const expectRooms = async (actorIndex, orgIndex, expectedIds) => {
      const result = await directRooms(actorIndex, orgIndex);
      demand(result.status === 200 && Array.isArray(result.body?.rooms), 'rooms_rpc_failed');
      assert.deepEqual(result.body.rooms.map(room => room.id).sort(), [...expectedIds].sort(), 'fixture room scope mismatch');
      demand(result.body.buildings.every(building => building.id === plan.orgs[orgIndex].buildingId), 'cross_org_building_leak');
    };
    await check('identity.database_auth_uid_matches_real_jwt', async () => {
      for (const actor of plan.actors) {
        const result = await rpc(ctx, actor.accessToken, 'get_my_organizations', {});
        demand(result.status === 200 && result.body?.user_id === actor.id, 'database_auth_uid_mismatch');
      }
    });
    await check('rpc_scope.a_and_b_only_own_org', async () => {
      await expectRooms(0, 0, [plan.orgs[0].roomId]); await expectRooms(1, 1, [plan.orgs[1].roomId]);
      for (const [actorIndex, orgIndex] of [[0, 1], [1, 0]]) {
        const response = await directRooms(actorIndex, orgIndex);
        demand(response.status === 403 && response.body?.code === '42501', 'cross_org_rpc_not_denied');
      }
    });
    const a = await issue(0, 0), b = await issue(1, 1), superA = await issue(2, 0), superB = await issue(2, 1);
    await check('identity.a_and_b_bound_to_verified_jwt', async () => {
      for (const [issued, actorIndex, orgIndex] of [[a, 0, 0], [b, 1, 1]]) {
        const value = await readContext(issued);
        demand(value.userId === plan.actors[actorIndex].id && value.organizationId === plan.orgs[orgIndex].id, 'actor_binding_mismatch');
        demand(value.permissions.read.includes('rooms.view') && value.permissions.action.length === 0, 'effective_permissions_mismatch');
      }
    });
    await check('identity.ordinary_user_cannot_select_other_org', async () => {
      await expectBrokerRejection(() => issue(0, 1), ['forbidden']);
      await expectBrokerRejection(() => issue(1, 0), ['forbidden']);
    });
    await check('identity.superadmin_two_separate_org_contexts', async () => {
      for (const [issued, orgIndex] of [[superA, 0], [superB, 1]]) {
        const value = await readContext(issued);
        demand(value.userId === plan.actors[2].id && value.organizationId === plan.orgs[orgIndex].id, 'superadmin_binding_mismatch');
        await expectRooms(2, orgIndex, [plan.orgs[orgIndex].roomId]);
      }
      demand(superA.connection.assistantId !== superB.connection.assistantId, 'org_assistant_namespace_shared');
    });
    await check('identity.tool_arguments_cannot_spoof_user_or_org', async () => {
      for (const args of [{ userId: plan.actors[1].id }, { organizationId: plan.orgs[1].id }]) {
        await expectBrokerRejection(() => broker.callTool(a.token, 'crm_auth_context', args), ['invalid_request']);
      }
    });
    await check('identity.reconnect_retains_assistant_namespace', async () => {
      const next = await issue(0, 0);
      demand(next.connection.assistantId === a.connection.assistantId, 'assistant_namespace_changed');
      await broker.revokeConnection(next.connection.id);
    });
    await check('policy.membership_revoke_invalidates_existing_connection', async () => {
      const member = plan.memberships[0];
      await sqlWrite(`update public.organization_memberships set status='REVOKED',revoked_at=now() where id=${lit(member.id)};`);
      try {
        await expectBrokerRejection(() => readContext(a), ['forbidden']);
        const result = await directRooms(0, 0);
        demand(result.status === 403 && result.body?.code === '42501', 'revoked_membership_rpc_not_denied');
      } finally { await sqlWrite(`update public.organization_memberships set status='ACTIVE',revoked_at=null where id=${lit(member.id)};`); }
    });
    await check('policy.membership_expiry_invalidates_existing_connection', async () => {
      const member = plan.memberships[0];
      await sqlWrite(`update public.organization_memberships set valid_to=now()-interval '1 day' where id=${lit(member.id)};`);
      try {
        await expectBrokerRejection(() => readContext(a), ['forbidden']);
        const result = await directRooms(0, 0);
        demand(result.status === 403 && result.body?.code === '42501', 'expired_membership_rpc_not_denied');
      } finally { await sqlWrite(`update public.organization_memberships set valid_to=null where id=${lit(member.id)};`); }
    });
    await check('policy.active_membership_with_revoked_timestamp_is_denied', async () => {
      const member = plan.memberships[0];
      await sqlWrite(`update public.organization_memberships set revoked_at=now() where id=${lit(member.id)};`);
      try {
        await expectBrokerRejection(() => readContext(a), ['forbidden']);
        const result = await directRooms(0, 0);
        demand(result.status === 403 && result.body?.code === '42501', 'revoked_timestamp_rpc_not_denied');
      } finally { await sqlWrite(`update public.organization_memberships set revoked_at=null where id=${lit(member.id)};`); }
    });
    await check('policy.future_membership_is_denied', async () => {
      const member = plan.memberships[0];
      await sqlWrite(`update public.organization_memberships set valid_from=now()+interval '1 day' where id=${lit(member.id)};`);
      try {
        await expectBrokerRejection(() => readContext(a), ['forbidden']);
        const result = await directRooms(0, 0);
        demand(result.status === 403 && result.body?.code === '42501', 'future_membership_rpc_not_denied');
      } finally { await sqlWrite(`update public.organization_memberships set valid_from=now()-interval '2 days' where id=${lit(member.id)};`); }
    });
    await check('policy.role_downgrade_recomputed_without_reconnect', async () => {
      const member = plan.memberships[0];
      await sqlWrite(`update public.role_bindings set valid_to=now()-interval '1 day' where id=${lit(member.bindingId)};`);
      try {
        const value = await readContext(a);
        demand(!value.permissions.read.includes('rooms.view'), 'stale_room_permission');
        await expectRooms(0, 0, []);
      } finally { await sqlWrite(`update public.role_bindings set valid_to=null where id=${lit(member.bindingId)};`); }
    });
    await check('policy.superadmin_downgrade_disallows_multi_org_connection', async () => {
      await sqlWrite(`delete from public.super_admins where user_id=${lit(plan.actors[2].id)};`);
      try {
        await expectBrokerRejection(() => readContext(superA), ['forbidden']);
        await expectBrokerRejection(() => readContext(superB), ['forbidden']);
      } finally { await sqlWrite(`insert into public.super_admins(user_id,note) values (${lit(plan.actors[2].id)},'Hermes P1 synthetic TEST fixture');`); }
    });
    await check('policy.read_restriction_hides_and_blocks_tool', async () => {
      const limited = await issue(0, 0);
      await broker.restrictConnection(limited.connection.id, { read: [], action: [] });
      demand((await broker.listTools(limited.token)).tools.length === 0, 'restricted_tool_listed');
      await expectBrokerRejection(() => readContext(limited), ['tool_not_available']);
      await broker.revokeConnection(limited.connection.id);
    });
    await check('connection.revoke_rejects_old_token', async () => {
      const removed = await issue(0, 0);
      await broker.revokeConnection(removed.connection.id);
      await expectBrokerRejection(() => readContext(removed), ['unauthorized']);
    });
    await check('connection.expiry_rejects_old_token', async () => {
      let clockNow = Date.now();
      const expiryBroker = createBroker({ auth, clock: () => clockNow, limits: { tokenLifetimeMs: 1000 } });
      const expires = await issue(0, 0, expiryBroker);
      clockNow += 1001;
      await expectBrokerRejection(() => readContext(expires, expiryBroker), ['unauthorized']);
    });
    for (const issued of [a, b, superA, superB]) await broker.revokeConnection(issued.connection.id);
  } catch (error) {
    cases.push({ name: 'fixture_or_broker_setup', stage: setupStage, status: 'FAIL', code: reportError(error) });
  } finally {
    if (cleanupRequired) {
      try {
        await withTestCleanup(lease, ctx.test, async cleanupLease => {
          const cleanupCtx = { ...ctx, signal: cleanupLease.signal };
          // Exact run-specific addresses recover a successful-but-unread admin create.
          const rows = psqlJson(ctx.test, `select id,email from auth.users where email in (${plan.actors.map(actor => lit(actor.email)).join(',')})`);
          for (const actor of plan.actors) actor.id ??= rows.find(row => row.email === actor.email)?.id ?? null;
          await sqlWrite(fixtureCleanupSql(plan), cleanupLease);
          for (const actor of plan.actors.filter(actor => actor.id)) {
            await assertTestLease(cleanupLease, ctx.test);
            const response = await testFetch(cleanupCtx, `${ctx.url}/auth/v1/admin/users/${actor.id}`, {
              method: 'DELETE', headers: { apikey: ctx.cred.testSecretKey, Authorization: `Bearer ${ctx.cred.testSecretKey}` },
            }, { write: true });
            demand(response.status === 200 || response.status === 404, 'fixture_auth_cleanup_failed');
          }
          const [left] = psqlJson(ctx.test, `select
            (select count(*) from auth.users where email in (${plan.actors.map(actor => lit(actor.email)).join(',')}))::int actors,
            (select count(*) from public.organizations where id in (${sqlIds(plan.orgs.map(org => org.id))}))::int orgs,
            (select count(*) from public.rooms where id in (${sqlIds(plan.orgs.map(org => org.roomId))}))::int rooms,
            (select count(*) from public.buildings where id in (${sqlIds(plan.orgs.map(org => org.buildingId))}))::int buildings,
            (select count(*) from public.organization_memberships where id in (${sqlIds(plan.memberships.map(member => member.id))}))::int memberships,
            (select count(*) from public.role_bindings where organization_id in (${sqlIds(plan.orgs.map(org => org.id))}))::int bindings,
            (select count(*) from public.role_binding_scopes where organization_id in (${sqlIds(plan.orgs.map(org => org.id))}))::int binding_scopes,
            (select count(*) from public.role_permissions where organization_id in (${sqlIds(plan.orgs.map(org => org.id))}))::int permissions,
            (select count(*) from public.organization_roles where organization_id in (${sqlIds(plan.orgs.map(org => org.id))}))::int roles,
            (select count(*) from public.authorization_scopes where organization_id in (${sqlIds(plan.orgs.map(org => org.id))}))::int scopes,
            (select count(*) from public.profiles where id in (${sqlIds(plan.actors.map(actor => actor.id).filter(Boolean)) || 'NULL'}))::int profiles,
            (select count(*) from public.super_admins where user_id in (${sqlIds(plan.actors.map(actor => actor.id).filter(Boolean)) || 'NULL'}))::int superadmins`);
          validateCleanupEvidence(left, ctx.writeState);
          cleanupVerified = true;
        });
        cases.push({ name: 'fixture.cleanup_verified', status: 'PASS' });
      } catch (error) { cases.push({ name: 'fixture.cleanup_verified', status: 'FAIL', code: reportError(error) }); }
    }
    const finalSources = captureSourceIdentity();
    const inputsUnchanged = sourceIdentityUnchanged(initialSources, finalSources);
    if (!inputsUnchanged) cases.push({ name: 'evidence.inputs_unchanged', status: 'FAIL', code: 'source_changed_during_run' });
    const report = {
      version: 1, observedAt: new Date().toISOString(), environment: 'guarded-ihomecrm-test',
      sourceIdentity: { initialSha256: initialSources, finalSha256: finalSources, inputsUnchanged },
      fixture: { runId: plan.run, actors: 3, organizations: 2, copiedAccountsUsed: false, cleanupVerified },
      evidence: { realJwt: authenticatedActors === 3, authenticatedActors, brokerTool: 'crm_auth_context', directControlRpc: 'copilot_available_rooms_v1',
        rpcIsBrokerTool: false, schemaChanges: false, productionWrites: false },
      limitations: ['SECURITY DEFINER RPC scope gate tested; not a general table/storage RLS audit.',
        'No Hermes runtime/MCP client round-trip in this harness.', 'No business tool exported by P1 broker.',
        'No deployment or durable store/refresh-token lifecycle certification.'],
      adapterObservations,
      cases, passed: cases.filter(item => item.status === 'PASS').length, failed: cases.filter(item => item.status === 'FAIL').length,
    };
    const path = resolve(reportPath); mkdirSync(dirname(path), { recursive: true });
    const bytes = `${JSON.stringify(report, null, 2)}\n`;
    // Keep every FAIL/PASS receipt immutable by run ID; the main path is latest only.
    writeFileSync(path.replace(/\.json$/, '') + `.${plan.run}.json`, bytes, { flag: 'wx' });
    writeFileSync(path, bytes);
  }
  demand(cleanupVerified, 'fixture_cleanup_not_verified');
  demand(!cases.some(item => item.status === 'FAIL'), 'real_jwt_harness_failed');
  return { passed: cases.length, report: reportPath, cleanupVerified };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    parseArguments(process.argv.slice(2));
    runHarness().then(result => console.log(JSON.stringify(result))).catch(error => {
      console.error(reportError(error)); process.exitCode = 1;
    });
  } catch (error) { console.error(reportError(error)); process.exitCode = 1; }
}
