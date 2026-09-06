import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const baseCommit = 'a181baa02653c87a902a2eb8b1b5eb5b316dd42e';
const resolverPath = 'supabase/migrations/20260829100000_copilot_authorized_scope_revocation_v1.sql';
const oldHelperPath = 'supabase/migrations/20260829090000_copilot_org_scope_semantics_v1.sql';
const useOldHelper = process.env.COPILOT_SCOPE_USE_OLD === '1';

const ids = Object.freeze({
  org: '10000000-0000-4000-8000-000000000001',
  emptyOrg: '10000000-0000-4000-8000-000000000002',
  foreignOrg: '10000000-0000-4000-8000-000000000003',
  inactiveOrg: '10000000-0000-4000-8000-000000000004',
  actor: '20000000-0000-4000-8000-000000000001',
  membership: '30000000-0000-4000-8000-000000000001',
  emptyMembership: '30000000-0000-4000-8000-000000000002',
  buildingA: '40000000-0000-4000-8000-000000000001',
  buildingB: '40000000-0000-4000-8000-000000000002',
  deletedBuilding: '40000000-0000-4000-8000-000000000003',
  foreignBuilding: '40000000-0000-4000-8000-000000000004',
  area: '50000000-0000-4000-8000-000000000001',
  scopeOrg: '60000000-0000-4000-8000-000000000001',
  scopeA: '60000000-0000-4000-8000-000000000002',
  scopeB: '60000000-0000-4000-8000-000000000003',
  scopeArea: '60000000-0000-4000-8000-000000000004',
  scopeDeleted: '60000000-0000-4000-8000-000000000005',
  scopeForeign: '60000000-0000-4000-8000-000000000006',
  scopeEmptyOrg: '60000000-0000-4000-8000-000000000007',
});

function gitBlob(path) {
  return execFileSync('git', ['show', `${baseCommit}:${path}`], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

function extractFunction(source, qualifiedName) {
  const start = source.search(new RegExp(`create\\s+or\\s+replace\\s+function\\s+${qualifiedName.replace('.', '\\.')}\\s*\\(`, 'i'));
  assert.notEqual(start, -1, `missing ${qualifiedName}`);
  const tail = source.slice(start);
  const match = /as\s+\$fn\$(.*?)\$fn\$;/is.exec(tail);
  assert.ok(match, `missing $fn$ body for ${qualifiedName}`);
  return { sql: tail.slice(0, match.index + match[0].length), body: match[1] };
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function forwardMigration() {
  const names = readdirSync(join(repoRoot, 'supabase', 'migrations'))
    .filter((name) => /^\d{14}_copilot_building_deny_scope_v1\.sql$/.test(name));
  assert.equal(names.length, 1, 'expected exactly one forward building-deny migration');
  const path = join(repoRoot, 'supabase', 'migrations', names[0]);
  return { path, sql: readFileSync(path, 'utf8') };
}

const resolver = extractFunction(gitBlob(resolverPath), 'app_private.authorized_scope_v3');
const oldHelper = extractFunction(gitBlob(oldHelperPath), 'public.copilot_org_scope_buildings_v1');

async function setup() {
  assert.equal(sha256(resolver.body), '5b87e1cb8a2f5e7708d8cf7f624beeeb3052dd84ed8accf505d41d72a0c66e26');
  assert.equal(sha256(oldHelper.body), '98b002b8548743d4276f7a5931a0f81488803d384320dcaeef5b623ee9bbf306');

  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE SCHEMA app_private;
    GRANT USAGE ON SCHEMA app_private TO authenticated;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
      AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

    CREATE TABLE public.organizations (id uuid PRIMARY KEY, status text NOT NULL);
    CREATE TABLE public.organization_memberships (
      id uuid PRIMARY KEY, organization_id uuid NOT NULL, user_id uuid NOT NULL,
      status text NOT NULL, revoked_at timestamptz, valid_from timestamptz, valid_to timestamptz
    );
    CREATE TABLE public.permission_definitions (
      key text PRIMARY KEY, permission_domain text NOT NULL, is_active boolean NOT NULL,
      scope_kinds text[] NOT NULL, required_dimensions text[] NOT NULL,
      requires_cashbook_possession boolean NOT NULL, accepted_possession_kinds text[] NOT NULL
    );
    CREATE TABLE public.member_permission_overrides (
      id uuid PRIMARY KEY, organization_id uuid NOT NULL, membership_id uuid NOT NULL,
      permission_key text NOT NULL, effect text NOT NULL, revoked_at timestamptz, expires_at timestamptz
    );
    CREATE TABLE public.member_override_scopes (
      organization_id uuid NOT NULL, override_id uuid NOT NULL, scope_id uuid NOT NULL
    );
    CREATE TABLE public.authorization_scopes (
      id uuid PRIMARY KEY, organization_id uuid NOT NULL, scope_type text NOT NULL,
      building_id uuid, cashbook_id uuid, area_id uuid
    );
    CREATE TABLE public.role_bindings (
      id uuid PRIMARY KEY, organization_id uuid NOT NULL, membership_id uuid NOT NULL,
      role_id uuid NOT NULL, valid_from timestamptz, valid_to timestamptz
    );
    CREATE TABLE public.organization_roles (
      id uuid PRIMARY KEY, organization_id uuid NOT NULL, status text
    );
    CREATE TABLE public.role_permissions (
      organization_id uuid NOT NULL, role_id uuid NOT NULL, permission_key text NOT NULL, effect text NOT NULL
    );
    CREATE TABLE public.role_binding_scopes (
      organization_id uuid NOT NULL, role_binding_id uuid NOT NULL, scope_id uuid NOT NULL
    );
    CREATE TABLE public.area_buildings (organization_id uuid NOT NULL, area_id uuid NOT NULL, building_id uuid NOT NULL);
    CREATE TABLE app_private.tenant_emergency_denies (
      organization_id uuid NOT NULL, permission_key text, active_from timestamptz NOT NULL, expires_at timestamptz
    );
    CREATE TABLE public.cashbook_possession_bindings (
      organization_id uuid NOT NULL, membership_id uuid NOT NULL, cashbook_id uuid NOT NULL,
      possession_kind text NOT NULL, valid_from timestamptz NOT NULL, valid_to timestamptz
    );
    CREATE TABLE public.buildings (id uuid PRIMARY KEY, organization_id uuid NOT NULL, deleted_at timestamptz);
    CREATE TABLE public.accounts (id uuid PRIMARY KEY, organization_id uuid NOT NULL, deleted_at timestamptz);

    INSERT INTO public.organizations VALUES
      ('${ids.org}', 'ACTIVE'), ('${ids.emptyOrg}', 'ACTIVE'),
      ('${ids.foreignOrg}', 'ACTIVE'), ('${ids.inactiveOrg}', 'INACTIVE');
    INSERT INTO public.organization_memberships VALUES
      ('${ids.membership}', '${ids.org}', '${ids.actor}', 'ACTIVE', NULL, now() - interval '1 day', NULL),
      ('${ids.emptyMembership}', '${ids.emptyOrg}', '${ids.actor}', 'ACTIVE', NULL, now() - interval '1 day', NULL);
    INSERT INTO public.permission_definitions VALUES
      ('services.view', 'TENANT', true, ARRAY['ORGANIZATION','AREA','BUILDING'], '{}'::text[], false, '{}'::text[]);
    INSERT INTO public.buildings VALUES
      ('${ids.buildingA}', '${ids.org}', NULL),
      ('${ids.buildingB}', '${ids.org}', NULL),
      ('${ids.deletedBuilding}', '${ids.org}', now()),
      ('${ids.foreignBuilding}', '${ids.foreignOrg}', NULL);
    INSERT INTO public.authorization_scopes VALUES
      ('${ids.scopeOrg}', '${ids.org}', 'ORGANIZATION', NULL, NULL, NULL),
      ('${ids.scopeA}', '${ids.org}', 'BUILDING', '${ids.buildingA}', NULL, NULL),
      ('${ids.scopeB}', '${ids.org}', 'BUILDING', '${ids.buildingB}', NULL, NULL),
      ('${ids.scopeArea}', '${ids.org}', 'AREA', NULL, NULL, '${ids.area}'),
      ('${ids.scopeDeleted}', '${ids.org}', 'BUILDING', '${ids.deletedBuilding}', NULL, NULL),
      ('${ids.scopeForeign}', '${ids.org}', 'BUILDING', '${ids.foreignBuilding}', NULL, NULL),
      ('${ids.scopeEmptyOrg}', '${ids.emptyOrg}', 'ORGANIZATION', NULL, NULL, NULL);
    INSERT INTO public.area_buildings VALUES ('${ids.org}', '${ids.area}', '${ids.buildingB}');
    SELECT set_config('request.jwt.claim.sub', '${ids.actor}', false);
  `);
  await db.exec(resolver.sql);
  await db.exec(oldHelper.sql);
  await db.exec(`
    ALTER FUNCTION public.copilot_org_scope_buildings_v1(text, uuid) OWNER TO postgres;
    REVOKE ALL ON FUNCTION public.copilot_org_scope_buildings_v1(text, uuid) FROM PUBLIC, anon;
    GRANT EXECUTE ON FUNCTION public.copilot_org_scope_buildings_v1(text, uuid) TO authenticated, service_role;
  `);
  const before = (await db.query(`
    SELECT p.proacl::text AS acl, r.rolname AS owner
    FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
    WHERE p.oid = 'public.copilot_org_scope_buildings_v1(text,uuid)'::regprocedure
  `)).rows[0];
  let migration = null;
  if (!useOldHelper) {
    migration = forwardMigration();
    await db.exec(migration.sql);
  }
  return { db, before, migration };
}

async function resetAuthorization(db) {
  await db.exec(`
    RESET ROLE;
    DELETE FROM public.member_override_scopes;
    DELETE FROM public.member_permission_overrides;
    DELETE FROM app_private.tenant_emergency_denies;
    UPDATE public.organization_memberships
       SET status='ACTIVE', revoked_at=NULL, valid_from=now()-interval '1 day', valid_to=NULL;
    SELECT set_config('request.jwt.claim.sub', '${ids.actor}', false);
  `);
}

let edge = 0;
async function addEdge(db, effect, scopeId, organizationId = ids.org, membershipId = ids.membership) {
  edge += 1;
  const overrideId = `70000000-0000-4000-8000-${String(edge).padStart(12, '0')}`;
  await db.exec(`
    INSERT INTO public.member_permission_overrides
      (id, organization_id, membership_id, permission_key, effect)
    VALUES ('${overrideId}', '${organizationId}', '${membershipId}', 'services.view', '${effect}');
    INSERT INTO public.member_override_scopes VALUES ('${organizationId}', '${overrideId}', '${scopeId}');
  `);
}

async function asAuthenticated(db) {
  await db.exec('SET ROLE authenticated');
}

const sorted = (value) => [...(value ?? [])].sort();

async function resolveScope(db, org = ids.org, permission = 'services.view') {
  const row = (await db.query(
    'SELECT org_wide, building_ids FROM app_private.authorized_scope_v3($1, $2::uuid)',
    [permission, org],
  )).rows[0];
  return { orgWide: row.org_wide, buildings: sorted(row.building_ids) };
}

async function helperScope(db, org = ids.org, permission = 'services.view') {
  return sorted((await db.query(
    'SELECT public.copilot_org_scope_buildings_v1($1, $2::uuid) AS buildings',
    [permission, org],
  )).rows[0].buildings);
}

async function expectHelperError(db, org, code, pattern) {
  await assert.rejects(
    () => helperScope(db, org),
    (error) => error.code === code && pattern.test(error.message),
  );
}

test('actual resolver and helper preserve effective building DENYs and boundary invariants', async () => {
  const { db, before, migration } = await setup();
  let caseName = 'organization allow plus building deny';
  try {
    await resetAuthorization(db);
    await addEdge(db, 'ALLOW', ids.scopeOrg);
    await addEdge(db, 'DENY', ids.scopeB);
    await asAuthenticated(db);
    assert.deepEqual(await resolveScope(db), { orgWide: true, buildings: [ids.buildingA] },
      'actual resolver must retain org-wide authority while subtracting building B');
    assert.deepEqual(await helperScope(db), [ids.buildingA],
      'helper must never expand the resolver result back to denied building B');

    if (useOldHelper) return;

    caseName = 'area deny';
    await resetAuthorization(db);
    await addEdge(db, 'ALLOW', ids.scopeOrg);
    await addEdge(db, 'DENY', ids.scopeArea);
    await asAuthenticated(db);
    assert.deepEqual(await helperScope(db), [ids.buildingA], 'area DENY must remove its building');

    caseName = 'organization deny';
    await resetAuthorization(db);
    await addEdge(db, 'ALLOW', ids.scopeOrg);
    await addEdge(db, 'DENY', ids.scopeOrg);
    await asAuthenticated(db);
    assert.deepEqual(await resolveScope(db), { orgWide: false, buildings: [] });
    assert.deepEqual(await helperScope(db), [], 'organization DENY must return no resources');

    caseName = 'emergency deny';
    await resetAuthorization(db);
    await addEdge(db, 'ALLOW', ids.scopeOrg);
    await db.exec(`INSERT INTO app_private.tenant_emergency_denies VALUES ('${ids.org}', 'services.view', now()-interval '1 hour', NULL)`);
    await asAuthenticated(db);
    assert.deepEqual(await helperScope(db), [], 'emergency DENY must return no resources');

    for (const membershipChange of [
      "revoked_at=now()",
      "valid_to=now()-interval '1 second'",
      "valid_from=now()+interval '1 hour'",
    ]) {
      caseName = `membership gate ${membershipChange}`;
      await resetAuthorization(db);
      await db.exec(`UPDATE public.organization_memberships SET ${membershipChange} WHERE id='${ids.membership}'`);
      await asAuthenticated(db);
      await expectHelperError(db, ids.org, '42501', /not_permitted/);
    }

    caseName = 'missing permission and grant';
    await resetAuthorization(db);
    await asAuthenticated(db);
    assert.deepEqual(await helperScope(db, ids.org, 'permission.missing'), [], 'missing permission is an empty effective scope');
    assert.deepEqual(await helperScope(db), [], 'no effective grant is an empty effective scope');

    caseName = 'organization allow without deny';
    await resetAuthorization(db);
    await addEdge(db, 'ALLOW', ids.scopeOrg);
    await asAuthenticated(db);
    assert.deepEqual(await helperScope(db), [ids.buildingA, ids.buildingB], 'organization allow without DENY sees active buildings');

    caseName = 'building-only allow';
    await resetAuthorization(db);
    await addEdge(db, 'ALLOW', ids.scopeA);
    await asAuthenticated(db);
    assert.deepEqual(await resolveScope(db), { orgWide: false, buildings: [ids.buildingA] });
    assert.deepEqual(await helperScope(db), [ids.buildingA], 'building-only allow remains valid');

    caseName = 'foreign and deleted projection';
    await resetAuthorization(db);
    await addEdge(db, 'ALLOW', ids.scopeDeleted);
    await addEdge(db, 'ALLOW', ids.scopeForeign);
    await asAuthenticated(db);
    assert.deepEqual((await resolveScope(db)).buildings, [ids.deletedBuilding, ids.foreignBuilding].sort(),
      'fixture proves the resolver resource IDs still need projection validation');
    assert.deepEqual(await helperScope(db), [], 'projection excludes foreign and deleted buildings');

    caseName = 'empty organization';
    await resetAuthorization(db);
    await addEdge(db, 'ALLOW', ids.scopeEmptyOrg, ids.emptyOrg, ids.emptyMembership);
    await asAuthenticated(db);
    assert.deepEqual(await resolveScope(db, ids.emptyOrg), { orgWide: true, buildings: [] });
    assert.deepEqual(await helperScope(db, ids.emptyOrg), [], 'a genuinely empty organization is valid and empty');

    caseName = 'invalid organization and unauthenticated actor';
    await resetAuthorization(db);
    await asAuthenticated(db);
    await expectHelperError(db, '00000000-0000-0000-0000-000000000000', '22023', /organization_required/);
    await expectHelperError(db, ids.inactiveOrg, '22023', /organization_required/);
    await db.exec("RESET ROLE; SELECT set_config('request.jwt.claim.sub', '', false); SET ROLE authenticated");
    await expectHelperError(db, ids.org, '42501', /not_permitted/);

    caseName = 'catalog metadata and ACL';
    await db.exec('RESET ROLE; SET ROLE authenticated');
    const after = (await db.query(`
      SELECT p.prosrc, p.provolatile, p.prosecdef, p.proconfig, p.proacl::text AS acl, r.rolname AS owner,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute,
             has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_execute,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute
      FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = 'public.copilot_org_scope_buildings_v1(text,uuid)'::regprocedure
    `)).rows[0];
    const newHelper = extractFunction(migration.sql, 'public.copilot_org_scope_buildings_v1');
    assert.equal(after.prosrc, newHelper.body, 'catalog must execute the exact new migration body');
    assert.equal(after.provolatile, 's');
    assert.equal(after.prosecdef, true);
    assert.deepEqual(after.proconfig, ['search_path=pg_catalog, public, app_private']);
    assert.equal(after.owner, before.owner, 'CREATE OR REPLACE must preserve owner');
    assert.equal(after.acl, before.acl, 'CREATE OR REPLACE must preserve the existing ACL');
    assert.equal(after.authenticated_execute, true);
    assert.equal(after.service_execute, true);
    assert.equal(after.anon_execute, false);

    caseName = 'forward idempotency';
    await db.exec('RESET ROLE');
    await db.exec(migration.sql);
    await db.exec(`SELECT set_config('request.jwt.claim.sub', '${ids.actor}', false); SET ROLE authenticated`);
    assert.deepEqual(await helperScope(db, ids.emptyOrg), [], 'forward migration is idempotent in the disposable catalog');
  } catch (error) {
    error.message = `${caseName}: ${error.message}`;
    throw error;
  } finally {
    await db.close();
  }
});
