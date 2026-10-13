import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { splitSqlStatements } from '../../scripts/network-center-function-bodies.mjs';
const root=new URL('../../',import.meta.url);
const foundation=readFileSync(new URL('supabase/migrations/20261012061447_hermes_assistant_identity_policy_v1.sql',root),'utf8');
const setter=readFileSync(new URL('supabase/migrations/20261012165809_hermes_public_conflict_http_v1.sql',root),'utf8');
const candidate=readFileSync(new URL('supabase/migrations/20261013115741_hermes_org_policy_options_v1.sql',root),'utf8');
function body(source,name){const result=splitSqlStatements(source).map(value=>value.replace(/--[^\n]*/g,'').trim()).find(value=>value.startsWith('CREATE OR REPLACE FUNCTION '+name+'('));assert(result,name);return result;}
const id=n=>n.repeat(8)+'-'+n.repeat(4)+'-4'+n.repeat(3)+'-8'+n.repeat(3)+'-'+n.repeat(12);
const USER=id('1'),ORG=id('2'),OTHER=id('3'),MEMBER=id('4'),BUILDING=id('5'),AREA=id('6'),ORG_SCOPE=id('7'),ROOM_SCOPE=id('8'),AREA_SCOPE=id('9'),CASH_SCOPE=id('a'),FOREIGN_SCOPE=id('b'),CROSSED_SCOPE=id('c'),FOREIGN_ORG_SCOPE=id('d');
const code=value=>error=>error.code===value;
test('actual policy getter and existing policy writer on synthetic CRM tables',async t=>{
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE hermes_store_executor;
    CREATE SCHEMA auth; CREATE SCHEMA app_private;
    CREATE TABLE organizations(id uuid PRIMARY KEY,status text,authorization_version bigint);
    CREATE TABLE organization_memberships(id uuid PRIMARY KEY,user_id uuid,organization_id uuid,status text,revoked_at timestamptz,valid_from timestamptz,valid_to timestamptz);
    CREATE TABLE super_admins(user_id uuid PRIMARY KEY);
    CREATE TABLE buildings(id uuid PRIMARY KEY,organization_id uuid,deleted_at timestamptz,name text);
    CREATE TABLE areas(id uuid PRIMARY KEY,organization_id uuid,deleted_at timestamptz,name text);
    CREATE TABLE authorization_scopes(id uuid PRIMARY KEY,organization_id uuid,scope_type text,building_id uuid,area_id uuid,cashbook_id uuid);
    CREATE TABLE app_private.hermes_org_policies(organization_id uuid PRIMARY KEY,enabled boolean,version bigint,read_capabilities text[],action_capabilities text[],scope_ids uuid[],updated_by uuid,updated_at timestamptz);
    CREATE TABLE app_private.hermes_capabilities(capability text PRIMARY KEY,mode text,enabled boolean);
    CREATE TABLE app_private.fixture(admin boolean,offboarded boolean); INSERT INTO app_private.fixture VALUES(true,false);
    CREATE TABLE app_private.audit(organization_id uuid,actor uuid,event text);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$SELECT current_setting('request.jwt.claim.role',true)$$;
    CREATE FUNCTION app_private.lock_org_for_decision_v1(o uuid) RETURNS bigint LANGUAGE plpgsql AS $$BEGIN RETURN (SELECT authorization_version FROM organizations WHERE id=o FOR NO KEY UPDATE); END$$;
    CREATE FUNCTION app_private.is_actor_offboarded_v1() RETURNS boolean LANGUAGE sql AS $$SELECT offboarded FROM app_private.fixture$$;
    CREATE FUNCTION app_private.require_perm_v1(o uuid,p text,label text) RETURNS void LANGUAGE plpgsql AS $$BEGIN
      IF p<>'users.edit' OR NOT (SELECT admin FROM app_private.fixture) THEN RAISE EXCEPTION 'denied' USING ERRCODE='42501'; END IF; END$$;
    CREATE FUNCTION app_private.append_authz_audit_v1(o uuid,event text,kind text,item uuid,old_value jsonb,new_value jsonb,reason text) RETURNS void LANGUAGE sql AS $$INSERT INTO app_private.audit VALUES(o,auth.uid(),event)$$;
    GRANT USAGE ON SCHEMA auth,public TO anon,authenticated,service_role,hermes_store_executor;
    INSERT INTO organizations VALUES('${ORG}','ACTIVE',7),('${OTHER}','ACTIVE',3);
    INSERT INTO organization_memberships(id,user_id,organization_id,status) VALUES('${MEMBER}','${USER}','${ORG}','ACTIVE');
    INSERT INTO buildings VALUES('${BUILDING}','${ORG}',NULL,'Nhà A'),('${OTHER}','${OTHER}',NULL,'PRIVATE FOREIGN LABEL');
    INSERT INTO areas VALUES('${AREA}','${ORG}',NULL,'Khu A');
    INSERT INTO authorization_scopes VALUES
      ('${ORG_SCOPE}','${ORG}','ORGANIZATION',NULL,NULL,NULL),('${ROOM_SCOPE}','${ORG}','BUILDING','${BUILDING}',NULL,NULL),
      ('${AREA_SCOPE}','${ORG}','AREA',NULL,'${AREA}',NULL),('${CASH_SCOPE}','${ORG}','CASHBOOK',NULL,NULL,'${OTHER}'),
      ('${FOREIGN_SCOPE}','${OTHER}','BUILDING','${OTHER}',NULL,NULL),('${CROSSED_SCOPE}','${ORG}','BUILDING','${OTHER}',NULL,NULL),
      ('${FOREIGN_ORG_SCOPE}','${OTHER}','ORGANIZATION',NULL,NULL,NULL);
    INSERT INTO app_private.hermes_capabilities VALUES('assistant.context.read','read',true),('rooms.view','read',true),('future.read','read',true),('future.write','action',true);
    INSERT INTO app_private.hermes_org_policies VALUES('${ORG}',false,2,ARRAY['assistant.context.read','future.read'],ARRAY['future.write'],ARRAY['${ROOM_SCOPE}'::uuid,'${CASH_SCOPE}'],'${USER}',clock_timestamp());
  `);
  for(const name of ['app_private.hermes_member_v1','app_private.hermes_validate_limits_v1'])await db.exec(body(foundation,name));
  await db.exec(body(setter,'public.hermes_set_org_policy_v1'));
  await db.exec('REVOKE ALL ON FUNCTION public.hermes_set_org_policy_v1(uuid,bigint,boolean,text[],text[],uuid[]) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor; GRANT EXECUTE ON FUNCTION public.hermes_set_org_policy_v1(uuid,bigint,boolean,text[],text[],uuid[]) TO authenticated;');
  await db.exec(candidate);
  // Replay must remove an executor grant left by default privileges or drift.
  await db.exec('GRANT EXECUTE ON FUNCTION public.hermes_org_policy_options_v1(uuid) TO hermes_store_executor');
  await db.exec(candidate);
  async function call({role='authenticated',actor=USER,org=ORG,write=false,expected=2,enabled=false,read=['assistant.context.read','future.read'],action=['future.write'],scopes=[ROOM_SCOPE,CASH_SCOPE]}={}){
    await db.exec('SAVEPOINT request');
    try{
      await db.exec('SET LOCAL ROLE '+role);await db.query("SELECT set_config('request.jwt.claim.role',$1,true),set_config('request.jwt.claim.sub',$2,true)",[role,actor]);
      const row=write?await db.query('SELECT public.hermes_set_org_policy_v1($1::uuid,$2::bigint,$3::boolean,$4::text[],$5::text[],$6::uuid[]) data',[org,expected,enabled,read,action,scopes]):await db.query('SELECT public.hermes_org_policy_options_v1($1::uuid) data',[org]);
      return row.rows[0].data;
    }finally{await db.exec('ROLLBACK TO SAVEPOINT request; RELEASE SAVEPOINT request; RESET ROLE');}
  }
  async function scenario(name,work){await t.test(name,async()=>{await db.exec('BEGIN');try{await work();}finally{await db.exec('ROLLBACK; RESET ROLE');}});}
  await scenario('getter preserves complete current ceilings but exposes only implemented new read choices and active same-org scopes',async()=>{
    const value=await call();assert.equal(value.userId,USER);assert.equal(value.organizationId,ORG);assert.equal(value.policy.version,2);
    assert.deepEqual(value.policy.action,['future.write']);assert.deepEqual(value.policy.read,['assistant.context.read','future.read']);
    assert.deepEqual(value.choices.read,['assistant.context.read','rooms.view']);assert.deepEqual(value.choices.action,[]);
    assert.deepEqual(value.choices.scopes.map(s=>s.scopeId),[ORG_SCOPE,ROOM_SCOPE,AREA_SCOPE]);assert(!JSON.stringify(value).includes('PRIVATE FOREIGN LABEL'));
    assert.deepEqual(value.storedScopes,[{scopeId:ROOM_SCOPE,label:'Toà: Nhà A',available:true},{scopeId:CASH_SCOPE,label:'Phạm vi chưa có trong danh sách hiện tại',available:false}]);
  });
  await scenario('replay removes inherited store executor access from the human-only getter',async()=>{
    const result=await db.query("SELECT has_function_privilege('hermes_store_executor','public.hermes_org_policy_options_v1(uuid)','EXECUTE') allowed");
    assert.equal(result.rows[0].allowed,false);
  });
  for(const role of ['anon','service_role','hermes_store_executor'])await scenario(role+' cannot read or set policy',async()=>{
    await assert.rejects(call({role}),code('42501'));await assert.rejects(call({role,write:true}),code('42501'));
  });
  await scenario('users.edit denial does not return policy or allow writes',async()=>{
    await db.exec('UPDATE app_private.fixture SET admin=false');await assert.rejects(call(),code('42501'));await assert.rejects(call({write:true}),code('42501'));
  });
  for(const [name,sql] of [
    ['revoked member','UPDATE organization_memberships SET revoked_at=clock_timestamp()'],
    ['expired member',"UPDATE organization_memberships SET valid_to=clock_timestamp()-interval '1 second'"],
    ['inactive org',"UPDATE organizations SET status='INACTIVE'"],
    ['offboarded actor','UPDATE app_private.fixture SET offboarded=true'],
    ['ordinary multi-org',`INSERT INTO organization_memberships(id,user_id,organization_id,status) VALUES('${OTHER}','${USER}','${OTHER}','ACTIVE')`]
  ])await scenario(name+' cannot read admin policy',async()=>{await db.exec(sql);await assert.rejects(call(),code('42501'));});
  await scenario('missing actor or foreign requested org denied',async()=>{await assert.rejects(call({actor:''}),code('42501'));await assert.rejects(call({org:OTHER}),code('42501'));});
  await scenario('superadmin still requests an explicit member organization and sees no other org policy',async()=>{
    await db.exec(`INSERT INTO super_admins VALUES('${USER}');INSERT INTO organization_memberships(id,user_id,organization_id,status) VALUES('${OTHER}','${USER}','${OTHER}','ACTIVE')`);
    assert.equal((await call()).isSuperadmin,true);const other=await call({org:OTHER});assert.equal(other.organizationId,OTHER);assert.equal(other.policy.version,0);assert.deepEqual(other.policy.scopeIds,[]);
  });
  await scenario('absent policy returns disabled empty version zero without creating anything',async()=>{
    await db.exec('DELETE FROM app_private.hermes_org_policies');const value=await call();assert.deepEqual(value.policy,{organizationId:ORG,version:0,enabled:false,read:[],action:[],scopeIds:[]});
    assert.deepEqual((await db.query('SELECT * FROM app_private.hermes_org_policies')).rows,[]);
  });
  await scenario('deleted building or area never becomes a new scope option; old IDs remain visible',async()=>{
    await db.exec('UPDATE buildings SET deleted_at=clock_timestamp(); UPDATE areas SET deleted_at=clock_timestamp()');const value=await call();
    assert.deepEqual(value.choices.scopes.map(s=>s.scopeId),[ORG_SCOPE]);assert.deepEqual(value.policy.scopeIds,[ROOM_SCOPE,CASH_SCOPE]);assert(value.storedScopes.every(s=>s.available===false));
  });
  await scenario('disabled registered capability is not offered and oversized scopes are rejected without truncation',async()=>{
    await db.exec("UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability='rooms.view'");
    assert.deepEqual((await call()).choices.read,['assistant.context.read']);
    await db.exec(`INSERT INTO authorization_scopes(id,organization_id,scope_type)
      SELECT md5('fixture-scope-'||n)::uuid,'${ORG}','ORGANIZATION' FROM generate_series(1,257) n`);
    await assert.rejects(call(),code('22023'));
  });
  await scenario('existing writer enforces CAS, capability registry, foreign scope rejection, and echoes exact preserved disabled policy',async()=>{
    await assert.rejects(call({write:true,expected:1}),code('PT409'));
    await assert.rejects(call({write:true,read:['unknown.read']}),code('22023'));
    await assert.rejects(call({write:true,scopes:[FOREIGN_SCOPE]}),code('22023'));
    const value=await call({write:true});assert.equal(value.version,3);assert.equal(value.enabled,false);assert.deepEqual(value.action,['future.write']);assert.deepEqual(value.scopeIds,[ROOM_SCOPE,CASH_SCOPE]);
  });
  await scenario('read options never changes company ceilings, membership, or audit',async()=>{
    const query='SELECT (SELECT jsonb_agg(x) FROM app_private.hermes_org_policies x) policy,(SELECT jsonb_agg(x) FROM organization_memberships x) memberships,(SELECT jsonb_agg(x) FROM app_private.audit x) audit';
    const before=(await db.query(query)).rows;await call();assert.deepEqual((await db.query(query)).rows,before);
  });
});
