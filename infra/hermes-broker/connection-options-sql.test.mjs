import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { splitSqlStatements } from '../../scripts/network-center-function-bodies.mjs';

const uuid=n=>n.repeat(8)+'-'+n.repeat(4)+'-4'+n.repeat(3)+'-8'+n.repeat(3)+'-'+n.repeat(12);
const USER=uuid('1'), ORG=uuid('2'), OTHER=uuid('3'), MEMBER=uuid('4'), BUILDING=uuid('5'), HIDDEN=uuid('6'), AREA=uuid('7');
const ROOM_SCOPE=uuid('8'), AREA_SCOPE=uuid('9'), ORG_SCOPE=uuid('a'), HIDDEN_SCOPE=uuid('b'), FOREIGN_SCOPE=uuid('c'), CASH_SCOPE=uuid('d');
const migration=readFileSync(new URL('../../supabase/migrations/20261013183000_hermes_connection_options_v1.sql',import.meta.url),'utf8');
const foundation=readFileSync(new URL('../../supabase/migrations/20261012061447_hermes_assistant_identity_policy_v1.sql',import.meta.url),'utf8');
const member=splitSqlStatements(foundation).map(s=>s.replace(/--[^\n]*/g,'').trim()).find(s=>/^CREATE OR REPLACE FUNCTION app_private.hermes_member_v1\(/i.test(s));
const code=n=>error=>error.code===n;

test('actual candidate self-options SQL and existing membership helper on synthetic CRM scope tables', async t=>{
  const db=new PGlite(); t.after(()=>db.close());
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE hermes_store_executor;
    CREATE SCHEMA auth; CREATE SCHEMA app_private;
    CREATE TABLE organizations(id uuid PRIMARY KEY,status text,authorization_version bigint);
    CREATE TABLE organization_memberships(id uuid PRIMARY KEY,user_id uuid,organization_id uuid,status text,revoked_at timestamptz,valid_from timestamptz,valid_to timestamptz);
    CREATE TABLE super_admins(user_id uuid PRIMARY KEY);
    CREATE TABLE buildings(id uuid PRIMARY KEY,organization_id uuid,deleted_at timestamptz);
    CREATE TABLE areas(id uuid PRIMARY KEY,organization_id uuid,deleted_at timestamptz);
    CREATE TABLE area_buildings(area_id uuid,organization_id uuid,building_id uuid);
    CREATE TABLE authorization_scopes(id uuid PRIMARY KEY,organization_id uuid,scope_type text,building_id uuid,area_id uuid,cashbook_id uuid);
    CREATE TABLE app_private.hermes_org_policies(organization_id uuid PRIMARY KEY,enabled boolean,read_capabilities text[],scope_ids uuid[],version bigint);
    CREATE TABLE app_private.hermes_capabilities(capability text PRIMARY KEY,mode text,enabled boolean);
    CREATE TABLE app_private.fixture(offboarded boolean,rooms boolean,allowed uuid[],foreign_context boolean);
    INSERT INTO app_private.fixture VALUES(false,true,ARRAY['${BUILDING}'::uuid],false);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$SELECT current_setting('request.jwt.claim.role',true)$$;
    CREATE FUNCTION app_private.lock_org_for_decision_v1(o uuid) RETURNS void LANGUAGE plpgsql AS $$BEGIN PERFORM 1 FROM organizations WHERE id=o FOR NO KEY UPDATE; END$$;
    CREATE FUNCTION app_private.is_actor_offboarded_v1() RETURNS boolean LANGUAGE sql AS $$SELECT offboarded FROM app_private.fixture$$;
    CREATE FUNCTION app_private.scope_label_v1(s uuid) RETURNS text LANGUAGE sql AS $$SELECT 'Phạm vi '||s::text$$;
    CREATE FUNCTION public.copilot_org_scope_buildings_v1(p text,o uuid) RETURNS uuid[] LANGUAGE plpgsql AS $$BEGIN
      IF p <> 'rooms.view' OR o <> '${ORG}'::uuid THEN RETURN ARRAY[]::uuid[]; END IF;
      RETURN (SELECT allowed FROM app_private.fixture); END$$;
    CREATE FUNCTION public.get_authorization_context_v1(o uuid) RETURNS jsonb LANGUAGE sql AS $$
      SELECT jsonb_build_object('organizationId',CASE WHEN f.foreign_context THEN '${OTHER}'::uuid ELSE o END,
       'membershipId',m.id,'authorizationVersion',org.authorization_version,'isOffboarded',f.offboarded,
       'permissions',jsonb_build_object('rooms.view',f.rooms))
      FROM organization_memberships m JOIN organizations org ON org.id=m.organization_id CROSS JOIN app_private.fixture f
      WHERE m.organization_id=o AND m.user_id=auth.uid() LIMIT 1$$;
    GRANT USAGE ON SCHEMA auth,public TO anon,authenticated,service_role,hermes_store_executor;
    INSERT INTO organizations VALUES('${ORG}','ACTIVE',7),('${OTHER}','ACTIVE',3);
    INSERT INTO organization_memberships(id,user_id,organization_id,status) VALUES('${MEMBER}','${USER}','${ORG}','ACTIVE');
    INSERT INTO buildings VALUES('${BUILDING}','${ORG}',NULL),('${HIDDEN}','${ORG}',NULL);
    INSERT INTO areas VALUES('${AREA}','${ORG}',NULL);
    INSERT INTO area_buildings VALUES('${AREA}','${ORG}','${BUILDING}'),('${AREA}','${ORG}','${HIDDEN}');
    INSERT INTO authorization_scopes VALUES
      ('${ROOM_SCOPE}','${ORG}','BUILDING','${BUILDING}',NULL,NULL),
      ('${AREA_SCOPE}','${ORG}','AREA',NULL,'${AREA}',NULL),
      ('${ORG_SCOPE}','${ORG}','ORGANIZATION',NULL,NULL,NULL),
      ('${HIDDEN_SCOPE}','${ORG}','BUILDING','${HIDDEN}',NULL,NULL),
      ('${FOREIGN_SCOPE}','${OTHER}','BUILDING','${BUILDING}',NULL,NULL),
      ('${CASH_SCOPE}','${ORG}','CASHBOOK',NULL,NULL,'${HIDDEN}');
    INSERT INTO app_private.hermes_capabilities VALUES('assistant.context.read','read',true),('rooms.view','read',true);
    INSERT INTO app_private.hermes_org_policies VALUES('${ORG}',true,ARRAY['assistant.context.read','rooms.view'],
      ARRAY['${ROOM_SCOPE}'::uuid,'${AREA_SCOPE}','${ORG_SCOPE}','${HIDDEN_SCOPE}','${FOREIGN_SCOPE}','${CASH_SCOPE}'],2);
  `);
  assert(member,'existing member helper found'); await db.exec(member); await db.exec(migration);
  // CREATE OR REPLACE preserves old ACLs. Reapplying the candidate must remove
  // a prior direct executor grant, not merely the default PUBLIC grant.
  await db.exec('GRANT EXECUTE ON FUNCTION public.hermes_connection_options_v1(uuid) TO hermes_store_executor');
  await db.exec(migration);
  assert.equal((await db.query("SELECT has_function_privilege('hermes_store_executor','public.hermes_connection_options_v1(uuid)','EXECUTE') AS allowed")).rows[0].allowed,false);
  async function call({role='authenticated',actor=USER,org=ORG}={}) {
    await db.exec('SAVEPOINT request');
    try {
      await db.exec('SET LOCAL ROLE '+role);
      await db.query("SELECT set_config('request.jwt.claim.role',$1,true),set_config('request.jwt.claim.sub',$2,true)",[role,actor]);
      return (await db.query('SELECT public.hermes_connection_options_v1($1::uuid) AS data',[org])).rows[0].data;
    } finally { await db.exec('ROLLBACK TO SAVEPOINT request; RELEASE SAVEPOINT request; RESET ROLE'); }
  }
  async function scenario(name,work) { await t.test(name,async()=>{await db.exec('BEGIN');try{await work();}finally{await db.exec('ROLLBACK; RESET ROLE');}}); }
  await scenario('scope choices intersect policy, selected org and physical CRM buildings, with no cashbook or foreign label',async()=>{
    const result=await call();
    assert.deepEqual(Object.keys(result).sort(),['userId','organizationId','membershipId','authorizationVersion','isSuperadmin','policyVersion','enabled','read','action','scopes'].sort());
    assert.deepEqual(result.read,['assistant.context.read','rooms.view']); assert.deepEqual(result.action,[]);
    assert.deepEqual(result.scopes.map(s=>s.scopeId),[ROOM_SCOPE,AREA_SCOPE,ORG_SCOPE].sort());
    assert(result.scopes.every(s=>s.cashbookId===null)); assert.equal(result.membershipId,MEMBER); assert.equal(result.authorizationVersion,7);
  });
  for(const role of ['anon','service_role','hermes_store_executor']) await scenario(role+' has no RPC execution grant',async()=>assert.rejects(call({role}),code('42501')));
  for(const [name,sql] of [
    ['revoked membership',"UPDATE organization_memberships SET revoked_at=clock_timestamp()"],
    ['inactive membership',"UPDATE organization_memberships SET status='SUSPENDED'"],
    ['expired membership',"UPDATE organization_memberships SET valid_to=clock_timestamp()-interval '1 second'"],
    ['future membership',"UPDATE organization_memberships SET valid_from=clock_timestamp()+interval '1 hour'"],
    ['inactive organization',"UPDATE organizations SET status='INACTIVE'"],
    ['offboarded actor',"UPDATE app_private.fixture SET offboarded=true"],
    ['ordinary multi company',`INSERT INTO organization_memberships(id,user_id,organization_id,status) VALUES('${OTHER}','${USER}','${OTHER}','ACTIVE')`]
  ]) await scenario(name+' denied',async()=>{await db.exec(sql);await assert.rejects(call(),code('42501'));});
  await scenario('foreign requested company and missing authenticated actor denied',async()=>{
    await assert.rejects(call({org:OTHER}),code('42501')); await assert.rejects(call({actor:''}),code('42501'));
  });
  await scenario('foreign authorization context cannot return choices',async()=>{
    await db.exec('UPDATE app_private.fixture SET foreign_context=true'); await assert.rejects(call(),code('40001'));
  });
  await scenario('superadmin remains explicitly selected-company scoped',async()=>{
    await db.exec(`INSERT INTO super_admins VALUES('${USER}');
      INSERT INTO organization_memberships(id,user_id,organization_id,status) VALUES('${OTHER}','${USER}','${OTHER}','ACTIVE')`);
    assert.equal((await call()).isSuperadmin,true);
    const other=await call({org:OTHER}); assert.equal(other.organizationId,OTHER); assert.equal(other.enabled,false); assert.deepEqual(other.scopes,[]);
  });
  for(const [name,sql] of [['disabled policy','UPDATE app_private.hermes_org_policies SET enabled=false'],['missing policy','DELETE FROM app_private.hermes_org_policies']])
    await scenario(name+' is an explicit empty selection',async()=>{await db.exec(sql);const result=await call();assert.equal(result.enabled,false);assert.deepEqual(result.read,[]);assert.deepEqual(result.scopes,[]);});
  for(const [name,sql] of [
    ['no rooms permission','UPDATE app_private.fixture SET rooms=false'],
    ['empty CRM buildings',"UPDATE app_private.fixture SET allowed=ARRAY[]::uuid[]"],
    ['disabled capability',"UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability='rooms.view'"],
    ['policy no room scopes',"UPDATE app_private.hermes_org_policies SET scope_ids=ARRAY[]::uuid[]"],
    ['deleted physical building',"UPDATE buildings SET deleted_at=clock_timestamp()"],
    ['foreign physical building',`UPDATE buildings SET organization_id='${OTHER}'`]
  ]) await scenario(name+' cannot expose rooms scope choices',async()=>{await db.exec(sql);const result=await call();assert.deepEqual(result.read,['assistant.context.read']);assert.deepEqual(result.scopes,[]);});
  await scenario('deleted area is excluded while permitted building remains',async()=>{
    await db.exec('UPDATE areas SET deleted_at=clock_timestamp()');assert.deepEqual((await call()).scopes.map(s=>s.scopeId),[ROOM_SCOPE,ORG_SCOPE].sort());
  });
  await scenario('company policy narrows choices even where CRM permits all physical buildings',async()=>{
    await db.exec(`UPDATE app_private.hermes_org_policies SET scope_ids=ARRAY['${AREA_SCOPE}'::uuid]`);
    assert.deepEqual((await call()).scopes.map(s=>s.scopeId),[AREA_SCOPE]);
  });
  await scenario('choices read does not alter user membership, CRM grants or company policy',async()=>{
    const query='SELECT (SELECT jsonb_agg(x) FROM organization_memberships x) AS members,(SELECT jsonb_agg(x) FROM app_private.fixture x) AS crm,(SELECT jsonb_agg(x) FROM app_private.hermes_org_policies x) AS policy';
    const before=(await db.query(query)).rows;await call();assert.deepEqual((await db.query(query)).rows,before);
  });
});
