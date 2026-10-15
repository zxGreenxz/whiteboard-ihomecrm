import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const sql = readFileSync(new URL('../../supabase/migrations/20261013164116_hermes_group_capability_options_v2.sql', import.meta.url), 'utf8');
const USER='11111111-1111-4111-8111-111111111111', ORG='22222222-2222-4222-8222-222222222222';
const MEMBER='33333333-3333-4333-8333-333333333333', CONNECTION='44444444-4444-4444-8444-444444444444';
// Actual additive v2 SQL, with explicit synthetic v1/Auth/action-context ports.
// This proves composition/default-off/metadata fences, not real JWT/RBAC/MVCC.
test('action metadata extends unchanged v1 APIs and remains default-off', async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE hermes_store_executor;
    CREATE SCHEMA app_private; CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '${USER}'::uuid $$;
    CREATE TABLE app_private.hermes_capabilities(capability text PRIMARY KEY,mode text,enabled boolean);
    CREATE TABLE public.fixture_ports(kind text PRIMARY KEY,value jsonb);
    CREATE FUNCTION public.hermes_org_policy_options_v1(p_org uuid) RETURNS jsonb LANGUAGE sql AS $$
      SELECT value FROM public.fixture_ports WHERE kind='policy' $$;
    CREATE FUNCTION public.hermes_connection_options_v1(p_org uuid) RETURNS jsonb LANGUAGE sql AS $$
      SELECT value FROM public.fixture_ports WHERE kind='options' $$;
    CREATE FUNCTION public.hermes_connection_context_v1(p_connection_id uuid) RETURNS jsonb LANGUAGE sql AS $$
      SELECT value FROM public.fixture_ports WHERE kind='context' $$;
    CREATE FUNCTION public.hermes_group_action_context_v1(p_organization_id uuid) RETURNS jsonb LANGUAGE sql AS $$
      SELECT value FROM public.fixture_ports WHERE kind='action' $$;`);
  const identity = { userId:USER,organizationId:ORG,membershipId:MEMBER,authorizationVersion:4,policyVersion:2 };
  const base = {
    policy:{...identity,choices:{read:['rooms.view'],action:[],scopes:[{id:MEMBER}]},policy:{version:2}},
    options:{...identity,enabled:true,read:['assistant.context.read','rooms.view'],action:[],scopes:[{id:MEMBER}]},
    context:{...identity,id:CONNECTION,restrictions:{read:['rooms.view'],action:['chat_zalo.send']},
      companyCeilings:{read:['rooms.view'],action:['chat_zalo.send']},effective:{read:['rooms.view'],action:[]}},
    action:{...identity,allowed:true,companyEnabled:true},
  };
  const set = async (kind,value) => db.query('INSERT INTO public.fixture_ports VALUES($1,$2::jsonb) ON CONFLICT(kind) DO UPDATE SET value=EXCLUDED.value',[kind,JSON.stringify(value)]);
  for(const [kind,value] of Object.entries(base)) await set(kind,value);
  const call = async (fn,arg=ORG) => (await db.query(`SELECT public.${fn}($1::uuid) AS value`,[arg])).rows[0].value;
  const v1 = async () => (await db.query(`SELECT proname,prosrc,proowner,proacl FROM pg_proc WHERE pronamespace='public'::regnamespace
    AND proname IN ('hermes_org_policy_options_v1','hermes_connection_options_v1','hermes_connection_context_v1') ORDER BY proname`)).rows;
  const before = await v1(); await db.exec(sql); await db.exec(sql);
  await t.test('replay preserves v1 bodies/ACL and never enables action',async()=>{
    assert.deepEqual(await v1(),before);
    assert.equal((await db.query(`SELECT enabled FROM app_private.hermes_capabilities WHERE capability='chat_zalo.send'`)).rows[0].enabled,false);
    assert.deepEqual(await call('hermes_org_policy_options_v2'),base.policy);
    assert.deepEqual(await call('hermes_connection_options_v2'),base.options);
    assert.deepEqual(await call('hermes_connection_context_v2',CONNECTION),base.context);
  });
  await db.exec(`UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability='chat_zalo.send'`);
  await t.test('enabled catalog only extends action metadata; read/scope stay identical',async()=>{
    assert.deepEqual(await call('hermes_org_policy_options_v2'),{...base.policy,choices:{...base.policy.choices,action:['chat_zalo.send']}});
    assert.deepEqual(await call('hermes_connection_options_v2'),{...base.options,action:['chat_zalo.send']});
    assert.deepEqual(await call('hermes_connection_context_v2',CONNECTION),{...base.context,effective:{...base.context.effective,action:['chat_zalo.send']}});
  });
  await t.test('current actor denial and company ceiling deny leave action empty',async()=>{
    for(const change of [{allowed:false},{companyEnabled:false}]){
      await set('action',{...base.action,...change});
      assert.deepEqual((await call('hermes_connection_options_v2')).action,[]);
      assert.deepEqual((await call('hermes_connection_context_v2',CONNECTION)).effective.action,[]);
    }
    await set('action',base.action);
  });
  await t.test('connection opt-out cannot inherit another action choice',async()=>{
    for(const kind of ['restrictions','companyCeilings']){
      await set('context',{...base.context,[kind]:{...base.context[kind],action:[]}});
      assert.deepEqual((await call('hermes_connection_context_v2',CONNECTION)).effective.action,[]);
    }
    await set('context',base.context);
  });
  await t.test('group read is an independent registered choice without room scope or send permission',async()=>{
    await db.exec("UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability='chat_zalo.view'");
    await set('options',{...base.options,read:[],action:[],scopes:[]});
    await set('context',{...base.context,restrictions:{read:['chat_zalo.view'],action:[]},companyCeilings:{read:['chat_zalo.view'],action:[]},effective:{read:[],action:[]}});
    await set('action',{...base.action,allowed:false,companyEnabled:false,readAllowed:true,readCompanyEnabled:true});
    assert.deepEqual((await call('hermes_org_policy_options_v2')).choices.read,['rooms.view','chat_zalo.view']);
    const options=await call('hermes_connection_options_v2');
    assert.deepEqual(options.read,['chat_zalo.view']);assert.deepEqual(options.action,[]);assert.deepEqual(options.scopes,[]);
    assert.deepEqual((await call('hermes_connection_context_v2',CONNECTION)).effective,{read:['chat_zalo.view'],action:[]});
    await set('action',{...base.action,allowed:false,companyEnabled:false,readAllowed:false,readCompanyEnabled:true});
    assert.deepEqual((await call('hermes_connection_options_v2')).read,[]);
    assert.deepEqual((await call('hermes_connection_context_v2',CONNECTION)).effective.read,[]);
    await set('options',base.options);await set('context',base.context);await set('action',base.action);
    await db.exec("UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability='chat_zalo.view'");
  });
  await t.test('foreign actor/org or stale action versions cannot return a grant',async()=>{
    for(const change of [{userId:MEMBER},{organizationId:MEMBER},{membershipId:ORG},{authorizationVersion:5},{policyVersion:3}]){
      await set('action',{...base.action,...change});
      await assert.rejects(call('hermes_connection_options_v2'),error=>error.code==='40001');
      await assert.rejects(call('hermes_connection_context_v2',CONNECTION),error=>error.code==='40001');
    }
    await set('action',base.action);
  });
  await t.test('a later v1 replacement does not overwrite the additive action extension',async()=>{
    await db.exec(`CREATE OR REPLACE FUNCTION public.hermes_connection_options_v1(p_org uuid) RETURNS jsonb LANGUAGE sql AS $$
      SELECT value||'{"sourceRevision":"later-v1"}'::jsonb FROM public.fixture_ports WHERE kind='options' $$;`);
    const result=await call('hermes_connection_options_v2');
    assert.equal(result.sourceRevision,'later-v1');assert.deepEqual(result.action,['chat_zalo.send']);
  });
  await t.test('only authenticated has execute access to the public v2 RPCs',async()=>{
    for(const name of ['hermes_org_policy_options_v2','hermes_connection_options_v2','hermes_connection_context_v2']){
      for(const role of ['anon','service_role','hermes_store_executor']){
        assert.equal((await db.query('SELECT has_function_privilege($1,$2,\'EXECUTE\') AS allowed',[role,`public.${name}(uuid)`])).rows[0].allowed,false);
      }
      assert.equal((await db.query('SELECT has_function_privilege(\'authenticated\',$1,\'EXECUTE\') AS allowed',[`public.${name}(uuid)`])).rows[0].allowed,true);
    }
  });
});
