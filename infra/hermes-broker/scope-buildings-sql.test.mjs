import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { scopeBuildingsMigration } from './scope-buildings-sql-fixture.mjs';

// Candidate 20261017023242 (public.hermes_scope_buildings_v1) against the REAL shared
// resolver app_private.authorized_scope_v3 (20260908162757, byte-identical to production
// pg_proc 17/10/2026) and a byte-identical PORT of the Copilot wrapper body that production
// runs today. That production body is NOT the one in this repository's 20260829090000:
// it came from 20260906201114_copilot_building_deny_scope_v1 (branch
// codex/copilot-building-deny-apply, never merged). Its prosrc md5 is pinned below, so the
// port cannot drift silently. Synthetic tables/data on disposable PGlite; not proof of
// production JWT, RLS or PostgREST.
const migrations = new URL('../../supabase/migrations/', import.meta.url);
function definition(sql, name) {
  const start = sql.search(new RegExp(`create or replace function ${name.replace('.', '\\.')}\\s*\\(`, 'i'));
  assert.notEqual(start, -1, name);
  const tail = sql.slice(start), quote = tail.match(/\bAS\s+(\$\w*\$)/i);
  return tail.slice(0, tail.indexOf(';', tail.indexOf(quote[1], quote.index + quote[0].length) + quote[1].length) + 1);
}
const RESOLVER = definition(readFileSync(new URL('20260908162757_authz_scope_org_wide_scoped_deny_v1.sql', migrations), 'utf8'),
  'app_private.authorized_scope_v3');
const CANDIDATE = scopeBuildingsMigration();
const HERMES = definition(CANDIDATE, 'public.hermes_scope_buildings_v1');
const PRODUCTION_RESOLVER_MD5 = '0169a4fff24e7f84ab37859c50b35a12';
const PRODUCTION_COPILOT_MD5 = '7e49860f9ac1a68f786636a577127997';
const PRODUCTION_COPILOT = `CREATE OR REPLACE FUNCTION public.copilot_org_scope_buildings_v1(
  p_permission_key text,
  p_organization_id uuid
)
RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_now timestamptz := now();
  v_scope uuid[];
BEGIN
  IF p_organization_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.organizations o
    WHERE o.id = p_organization_id
      AND o.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  -- Keep the selected-organization membership gate independent from permission
  -- resolution so a revoked or out-of-window membership remains a hard denial.
  IF NOT EXISTS (
    SELECT 1
    FROM public.organization_memberships m
    WHERE m.organization_id = p_organization_id
      AND m.user_id = v_actor
      AND m.status = 'ACTIVE'
      AND m.revoked_at IS NULL
      AND COALESCE(m.valid_from, '-infinity'::timestamptz) <= v_now
      AND (m.valid_to IS NULL OR m.valid_to > v_now)
  ) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(array_agg(b.id ORDER BY b.id), '{}'::uuid[])
    INTO v_scope
    FROM app_private.authorized_scope_v3(p_permission_key, p_organization_id) s
    CROSS JOIN LATERAL unnest(COALESCE(s.building_ids, '{}'::uuid[])) allowed(building_id)
    JOIN public.buildings b
      ON b.id = allowed.building_id
     AND b.organization_id = p_organization_id
     AND b.deleted_at IS NULL;

  -- Empty is a valid resource result. It does not imply organization permission.
  RETURN COALESCE(v_scope, '{}'::uuid[]);
END
$fn$;`;

const id = n => `5c09e000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORG = id(1), FOREIGN_ORG = id(2), SUSPENDED_ORG = id(3), UNKNOWN_ORG = id(4);
const USER = id(5), OUTSIDER = id(6), MEMBER = id(7), SUSPENDED_MEMBER = id(8), OUTSIDER_MEMBER = id(9);
// Sorted by id: B2 < B4 < B1, deliberately not insertion order.
const B1 = id(30), B2 = id(10), B4 = id(20), DELETED = id(40), FOREIGN_BUILDING = id(50), AREA = id(60);
const S_ORG = id(70), S_B1 = id(71), S_B2 = id(72), S_DELETED = id(73), S_FOREIGN_BUILDING = id(74), S_AREA = id(75);
const ROLE = id(80), BINDING = id(81);
const ALL = [B2, B4, B1];

async function setup() {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE hermes_store_executor;
    CREATE SCHEMA auth; CREATE SCHEMA app_private;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    CREATE TABLE public.organizations(id uuid PRIMARY KEY,status text);
    CREATE TABLE public.organization_memberships(id uuid PRIMARY KEY,organization_id uuid,user_id uuid,status text,
      revoked_at timestamptz,valid_from timestamptz,valid_to timestamptz);
    CREATE TABLE public.buildings(id uuid PRIMARY KEY,organization_id uuid,deleted_at timestamptz);
    CREATE TABLE public.accounts(id uuid PRIMARY KEY,organization_id uuid,deleted_at timestamptz);
    CREATE TABLE public.permission_definitions(key text,permission_domain text,is_active boolean,scope_kinds text[],
      requires_cashbook_possession boolean,accepted_possession_kinds text[],required_dimensions text[]);
    CREATE TABLE app_private.tenant_emergency_denies(organization_id uuid,permission_key text,active_from timestamptz,expires_at timestamptz);
    CREATE TABLE public.member_permission_overrides(id uuid,organization_id uuid,membership_id uuid,permission_key text,effect text,
      revoked_at timestamptz,expires_at timestamptz);
    CREATE TABLE public.member_override_scopes(organization_id uuid,override_id uuid,scope_id uuid);
    CREATE TABLE public.authorization_scopes(id uuid,organization_id uuid,scope_type text,building_id uuid,cashbook_id uuid,area_id uuid);
    CREATE TABLE public.role_bindings(id uuid,organization_id uuid,membership_id uuid,role_id uuid,valid_from timestamptz,valid_to timestamptz);
    CREATE TABLE public.organization_roles(id uuid,organization_id uuid,status text);
    CREATE TABLE public.role_permissions(organization_id uuid,role_id uuid,permission_key text,effect text);
    CREATE TABLE public.role_binding_scopes(organization_id uuid,role_binding_id uuid,scope_id uuid);
    CREATE TABLE public.area_buildings(organization_id uuid,area_id uuid,building_id uuid);
    CREATE TABLE public.cashbook_possession_bindings(organization_id uuid,membership_id uuid,cashbook_id uuid,possession_kind text,
      valid_from timestamptz,valid_to timestamptz);
    GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role,hermes_store_executor;
    INSERT INTO public.organizations VALUES('${ORG}','ACTIVE'),('${FOREIGN_ORG}','ACTIVE'),('${SUSPENDED_ORG}','SUSPENDED');
    INSERT INTO public.organization_memberships(id,organization_id,user_id,status) VALUES
      ('${MEMBER}','${ORG}','${USER}','ACTIVE'),('${SUSPENDED_MEMBER}','${SUSPENDED_ORG}','${USER}','ACTIVE'),
      ('${OUTSIDER_MEMBER}','${FOREIGN_ORG}','${OUTSIDER}','ACTIVE');
    INSERT INTO public.buildings VALUES('${B1}','${ORG}',NULL),('${B2}','${ORG}',NULL),('${B4}','${ORG}',NULL),
      ('${DELETED}','${ORG}',now()),('${FOREIGN_BUILDING}','${FOREIGN_ORG}',NULL);
    INSERT INTO public.area_buildings VALUES('${ORG}','${AREA}','${B2}'),('${ORG}','${AREA}','${B4}');
    INSERT INTO public.permission_definitions VALUES
      ('rooms.view','TENANT',true,ARRAY['ORGANIZATION','AREA','BUILDING'],false,'{}','{}'),
      ('contracts.view','TENANT',true,ARRAY['ORGANIZATION','AREA','BUILDING'],false,'{}','{}');
    -- A BUILDING scope row of this company that points at another company's building is
    -- corrupt data; the production wrapper must still not return that building.
    INSERT INTO public.authorization_scopes VALUES
      ('${S_ORG}','${ORG}','ORGANIZATION',NULL,NULL,NULL),('${S_B1}','${ORG}','BUILDING','${B1}',NULL,NULL),
      ('${S_B2}','${ORG}','BUILDING','${B2}',NULL,NULL),('${S_DELETED}','${ORG}','BUILDING','${DELETED}',NULL,NULL),
      ('${S_FOREIGN_BUILDING}','${ORG}','BUILDING','${FOREIGN_BUILDING}',NULL,NULL),('${S_AREA}','${ORG}','AREA',NULL,NULL,'${AREA}');
    INSERT INTO public.organization_roles VALUES('${ROLE}','${ORG}','ACTIVE');
  `);
  await db.exec(RESOLVER);
  await db.exec(PRODUCTION_COPILOT);
  await db.exec('SET check_function_bodies=off');
  try { await db.exec(CANDIDATE); await db.exec(CANDIDATE); } finally { await db.exec('SET check_function_bodies=on'); }
  return db;
}

let overrides = 0;
async function override(db, effect, scopes, { key = 'rooms.view', revoked = false, expired = false } = {}) {
  const row = id(100 + ++overrides);
  await db.query(`INSERT INTO public.member_permission_overrides VALUES($1,$2,$3,$4,$5,
    CASE WHEN $6 THEN now()-interval '1 day' END,CASE WHEN $7 THEN now()-interval '1 day' END)`, [row, ORG, MEMBER, key, effect, revoked, expired]);
  for (const scope of scopes) await db.query('INSERT INTO public.member_override_scopes VALUES($1,$2,$3)', [ORG, row, scope]);
}
async function call(db, fn, org, { actor = USER, key = 'rooms.view' } = {}) {
  await db.exec('SAVEPOINT scope_call');
  try {
    await db.exec('SET LOCAL ROLE authenticated');
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [actor ?? '']);
    const value = (await db.query(`SELECT public.${fn}($1,$2) AS value`, [key, org])).rows[0].value;
    return { ok: [...value] };
  } catch (error) { return { error: `${error.code}:${error.message}` }; }
  finally { await db.exec('ROLLBACK TO SAVEPOINT scope_call; RELEASE SAVEPOINT scope_call; RESET ROLE'); }
}

const ok = value => ({ ok: value }), denied = { error: '42501:not_permitted' }, orgRequired = { error: '22023:organization_required' };
// Each case: arrange inside one rolled-back transaction, then the SAME call to both functions.
const CASES = [
  ['no grant is an empty scope', async () => {}, ORG, {}, ok([])],
  ['organization ALLOW expands to active buildings of the company, sorted by id', async db => override(db, 'ALLOW', [S_ORG]), ORG, {}, ok(ALL)],
  ['organization ALLOW minus BUILDING DENY (20260908162757)', async db => { await override(db, 'ALLOW', [S_ORG]); await override(db, 'DENY', [S_B2]); },
    ORG, {}, ok([B4, B1])],
  ['organization ALLOW minus AREA DENY', async db => { await override(db, 'ALLOW', [S_ORG]); await override(db, 'DENY', [S_AREA]); }, ORG, {}, ok([B1])],
  ['BUILDING plus AREA ALLOW', async db => override(db, 'ALLOW', [S_B1, S_AREA]), ORG, {}, ok(ALL)],
  ['BUILDING ALLOW on a deleted building returns nothing', async db => override(db, 'ALLOW', [S_DELETED, S_B1]), ORG, {}, ok([B1])],
  ['BUILDING ALLOW on another company building returns nothing', async db => override(db, 'ALLOW', [S_FOREIGN_BUILDING]), ORG, {}, ok([])],
  ['organization DENY wins over organization ALLOW', async db => { await override(db, 'ALLOW', [S_ORG]); await override(db, 'DENY', [S_ORG]); }, ORG, {}, ok([])],
  ['active emergency deny closes the company', async db => {
    await override(db, 'ALLOW', [S_ORG]); await db.query("INSERT INTO app_private.tenant_emergency_denies VALUES($1,NULL,now()-interval '1 hour',NULL)", [ORG]);
  }, ORG, {}, ok([])],
  ['expired emergency deny no longer applies', async db => {
    await override(db, 'ALLOW', [S_ORG]);
    await db.query("INSERT INTO app_private.tenant_emergency_denies VALUES($1,'rooms.view',now()-interval '2 day',now()-interval '1 day')", [ORG]);
  }, ORG, {}, ok(ALL)],
  ['inactive permission definition grants nothing', async db => {
    await override(db, 'ALLOW', [S_ORG]); await db.exec("UPDATE public.permission_definitions SET is_active=false WHERE key='rooms.view'");
  }, ORG, {}, ok([])],
  ['revoked override grants nothing', async db => override(db, 'ALLOW', [S_ORG], { revoked: true }), ORG, {}, ok([])],
  ['expired override grants nothing', async db => override(db, 'ALLOW', [S_ORG], { expired: true }), ORG, {}, ok([])],
  ['override for another permission grants nothing', async db => override(db, 'ALLOW', [S_ORG], { key: 'contracts.view' }), ORG, {}, ok([])],
  ['role binding ALLOW', async db => {
    await db.query("INSERT INTO public.role_bindings VALUES($1,$2,$3,$4,NULL,NULL)", [BINDING, ORG, MEMBER, ROLE]);
    await db.query("INSERT INTO public.role_permissions VALUES($1,$2,'rooms.view','ALLOW')", [ORG, ROLE]);
    await db.query('INSERT INTO public.role_binding_scopes VALUES($1,$2,$3)', [ORG, BINDING, S_B1]);
  }, ORG, {}, ok([B1])],
  ['expired role binding grants nothing', async db => {
    await db.query("INSERT INTO public.role_bindings VALUES($1,$2,$3,$4,NULL,now()-interval '1 day')", [BINDING, ORG, MEMBER, ROLE]);
    await db.query("INSERT INTO public.role_permissions VALUES($1,$2,'rooms.view','ALLOW')", [ORG, ROLE]);
    await db.query('INSERT INTO public.role_binding_scopes VALUES($1,$2,$3)', [ORG, BINDING, S_B1]);
  }, ORG, {}, ok([])],
  ['suspended role grants nothing', async db => {
    await db.query("INSERT INTO public.role_bindings VALUES($1,$2,$3,$4,NULL,NULL)", [BINDING, ORG, MEMBER, ROLE]);
    await db.query("INSERT INTO public.role_permissions VALUES($1,$2,'rooms.view','ALLOW')", [ORG, ROLE]);
    await db.query('INSERT INTO public.role_binding_scopes VALUES($1,$2,$3)', [ORG, BINDING, S_B1]);
    await db.exec("UPDATE public.organization_roles SET status='SUSPENDED'");
  }, ORG, {}, ok([])],
  ['revoked membership is a hard denial', async db => {
    await override(db, 'ALLOW', [S_ORG]); await db.exec(`UPDATE public.organization_memberships SET revoked_at=now() WHERE id='${MEMBER}'`);
  }, ORG, {}, denied],
  ['membership past valid_to is a hard denial', async db => {
    await override(db, 'ALLOW', [S_ORG]); await db.exec(`UPDATE public.organization_memberships SET valid_to=now()-interval '1 day' WHERE id='${MEMBER}'`);
  }, ORG, {}, denied],
  ['membership before valid_from is a hard denial', async db => {
    await override(db, 'ALLOW', [S_ORG]); await db.exec(`UPDATE public.organization_memberships SET valid_from=now()+interval '1 day' WHERE id='${MEMBER}'`);
  }, ORG, {}, denied],
  ['non-ACTIVE membership is a hard denial', async db => {
    await override(db, 'ALLOW', [S_ORG]); await db.exec(`UPDATE public.organization_memberships SET status='SUSPENDED' WHERE id='${MEMBER}'`);
  }, ORG, {}, denied],
  ['no auth.uid() is denied', async db => override(db, 'ALLOW', [S_ORG]), ORG, { actor: null }, denied],
  ['a member of another company is denied', async db => override(db, 'ALLOW', [S_ORG]), ORG, { actor: OUTSIDER }, denied],
  ['the member asking about a company they do not belong to is denied', async () => {}, FOREIGN_ORG, {}, denied],
  ['NULL company', async () => {}, null, {}, orgRequired],
  ['suspended company even with a membership', async () => {}, SUSPENDED_ORG, {}, orgRequired],
  ['unknown company', async () => {}, UNKNOWN_ORG, {}, orgRequired],
];

async function matrix(db) {
  const mismatches = [];
  for (const [name, arrange, org, options, expected] of CASES) {
    await db.exec('BEGIN');
    try {
      overrides = 0; await arrange(db);
      const production = await call(db, 'copilot_org_scope_buildings_v1', org, options);
      const hermes = await call(db, 'hermes_scope_buildings_v1', org, options);
      try { assert.deepEqual(hermes, production); assert.deepEqual(hermes, expected); }
      catch { mismatches.push({ name, production, hermes, expected }); }
    } finally { await db.exec('ROLLBACK'); }
  }
  return mismatches;
}

test('hermes_scope_buildings_v1 equals the production Copilot wrapper over the real resolver, case by case', { timeout: 300000 }, async t => {
  const db = await setup(); t.after(() => db.close());
  const md5 = async signature => (await db.query('SELECT md5(prosrc) AS value FROM pg_proc WHERE oid=$1::regprocedure', [signature])).rows[0].value;
  assert.equal(await md5('app_private.authorized_scope_v3(text,uuid)'), PRODUCTION_RESOLVER_MD5, 'resolver = production body');
  assert.equal(await md5('public.copilot_org_scope_buildings_v1(text,uuid)'), PRODUCTION_COPILOT_MD5, 'Copilot port = production body');

  await t.test('every case: same result or same SQLSTATE/message, and the expected value', async () => {
    assert.deepEqual(await matrix(db), []);
  });

  await t.test('only the Hermes key is accepted; other or NULL keys are rejected instead of resolved', async () => {
    await db.exec('BEGIN');
    try {
      await override(db, 'ALLOW', [S_ORG], { key: 'contracts.view' });
      assert.deepEqual(await call(db, 'copilot_org_scope_buildings_v1', ORG, { key: 'contracts.view' }), ok(ALL), 'wrapper resolves any key');
      assert.deepEqual(await call(db, 'hermes_scope_buildings_v1', ORG, { key: 'contracts.view' }), { error: '22023:hermes_scope_invalid' });
      assert.deepEqual(await call(db, 'hermes_scope_buildings_v1', ORG, { key: null }), { error: '22023:hermes_scope_invalid' });
    } finally { await db.exec('ROLLBACK'); }
  });

  await t.test('definer, STABLE, fixed search_path, owner postgres; only authenticated may execute', async () => {
    const row = (await db.query(`SELECT p.prosecdef,p.provolatile,p.proconfig,pg_get_userbyid(p.proowner) AS owner
      FROM pg_proc p WHERE p.oid='public.hermes_scope_buildings_v1(text,uuid)'::regprocedure`)).rows[0];
    assert.deepEqual(row, { prosecdef: true, provolatile: 's', proconfig: ['search_path=pg_catalog, public, app_private'], owner: 'postgres' });
    for (const role of ['anon', 'authenticated', 'service_role', 'hermes_store_executor']) {
      assert.equal((await db.query("SELECT has_function_privilege($1,'public.hermes_scope_buildings_v1(text,uuid)','EXECUTE') AS allowed", [role]))
        .rows[0].allowed, role === 'authenticated', role);
    }
    assert.doesNotMatch(HERMES.replace(/--[^\n]*/g, ''), /copilot/i);
  });

  // Hand mutations: each removes one rule of the candidate (or of the shared resolver);
  // the matrix above must observe it. Replacing the body by a call to the Copilot wrapper
  // is NOT observable here by design (same result) and is the static gate's job.
  const mutants = [
    ['deleted buildings kept', HERMES, ' AND b.deleted_at IS NULL;', ';'],
    ['other company buildings kept', HERMES, ' AND b.organization_id=p_organization_id AND', ' AND'],
    ['membership gate removed', HERMES, /  IF NOT EXISTS\(SELECT 1 FROM public\.organization_memberships m[\s\S]*?END IF;\n/, ''],
    ['inactive company accepted', HERMES, " AND o.status='ACTIVE'", ''],
    ['historical org_wide expansion instead of resolved building_ids', HERMES,
      /SELECT COALESCE\(array_agg\(b\.id ORDER BY b\.id\)[\s\S]*?b\.deleted_at IS NULL;/,
      `SELECT CASE WHEN s.org_wide THEN COALESCE((SELECT array_agg(b.id ORDER BY b.id) FROM public.buildings b
        WHERE b.organization_id=p_organization_id AND b.deleted_at IS NULL),'{}'::uuid[]) ELSE COALESCE(s.building_ids,'{}'::uuid[]) END
        INTO v_scope FROM app_private.authorized_scope_v3(p_permission_key,p_organization_id) s;`],
    ['shared resolver ignores BUILDING/AREA DENY', RESOLVER, 'and not (t.b = any(r.d_b))', ''],
  ];
  // Each mutant replaces the live definition, is observed, then the original is restored.
  for (const [name, source, from, to] of mutants) {
    await t.test(`mutation observed: ${name}`, async () => {
      const mutant = source.replace(from, to);
      assert.notEqual(mutant, source);
      try { await db.exec(mutant); assert.notDeepEqual(await matrix(db), []); }
      finally { await db.exec(source); }
    });
  }
  await t.test('mutation observed: key allowlist removed', async () => {
    const mutant = HERMES.replace(/  IF p_permission_key IS NULL OR p_permission_key<>'rooms\.view' THEN\n.*\n/, '');
    assert.notEqual(mutant, HERMES);
    try {
      await db.exec(mutant); await db.exec('BEGIN');
      try {
        await override(db, 'ALLOW', [S_ORG], { key: 'contracts.view' });
        assert.notDeepEqual(await call(db, 'hermes_scope_buildings_v1', ORG, { key: 'contracts.view' }), { error: '22023:hermes_scope_invalid' });
      } finally { await db.exec('ROLLBACK'); }
    } finally { await db.exec(HERMES); }
  });
  await t.test('every mutant was restored', async () => assert.deepEqual(await matrix(db), []));
});
