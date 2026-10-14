import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setup,SCOPE,BUILDING } from './room-pass-sql-fixture.mjs';
import { USER,ORG,FOREIGN,CONNECTION } from '../hermes-zalo-router/private-command-fixture.mjs';
import { connectionOptions } from './connection-options.mjs';
import { requiresBuildingScope,HERMES_ACTION_CAPABILITIES,HERMES_READ_CAPABILITIES } from './capability-contract.mjs';
const ACTION='sale_phong.manage_pass_listings';
const migration=readFileSync(process.env.HERMES_ROOM_PASS_OPTIONS_SQL??new URL('../../supabase/migrations/20261014090957_hermes_assistant_capabilities_v4.sql',import.meta.url),'utf8');
test('shared resource predicate requires scope for room-pass Action without adding a Read capability',()=>{
 assert.ok(HERMES_ACTION_CAPABILITIES.includes(ACTION));assert.equal(HERMES_READ_CAPABILITIES.includes(ACTION),false);
 assert.equal(requiresBuildingScope([], [ACTION]),true);assert.equal(requiresBuildingScope(['tasks.view'],[]),true);
 assert.equal(requiresBuildingScope([],['assistant.memory.write','chat_zalo.send']),false);
});
test('forward v4 fixed helper merges current Action building scopes, preserves v3 and never enables defaults',{timeout:60000},async t=>{
 const {db}=await setup(t);
 const member={userId:USER,organizationId:ORG,membershipId:USER,authorizationVersion:1,isSuperadmin:false};
 const options={...member,policyVersion:1,enabled:true,read:[],action:['assistant.memory.write'],scopes:[]};
 const context={...member,id:CONNECTION,policyVersion:1,scopeIds:[SCOPE],restrictions:{read:[],action:[ACTION]},companyCeilings:{read:[],action:[ACTION]},effective:{read:[],action:[]}};
 const org={...member,choices:{read:['tasks.view'],action:['assistant.memory.write'],scopes:[]},policy:{action:[]}};
 // v3 bodies are immutable and tested by the earlier C/D/E composition. These
 // three synthetic upstream ports isolate the additive v4 shape/authority merge.
 await db.exec(`ALTER TABLE public.buildings ADD COLUMN name text;ALTER TABLE public.areas ADD COLUMN name text;
   CREATE TABLE public.fixture_v3(kind text PRIMARY KEY,result jsonb);
   CREATE FUNCTION public.hermes_connection_options_v3(uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT result FROM public.fixture_v3 WHERE kind='connection_options'$$;
   CREATE FUNCTION public.hermes_connection_context_v3(uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT result FROM public.fixture_v3 WHERE kind='context'$$;
   CREATE FUNCTION public.hermes_org_policy_options_v3(uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT result FROM public.fixture_v3 WHERE kind='org_options'$$;`);
 for(const [kind,value] of Object.entries({connection_options:options,context,org_options:org}))await db.query('INSERT INTO public.fixture_v3 VALUES($1,$2)',[kind,JSON.stringify(value)]);
 await db.exec(migration);await db.exec(migration);
 const call=async(kind,role='authenticated')=>{
   await db.exec('BEGIN');await db.query("SELECT set_config('request.jwt.claim.role',$1,true),set_config('request.jwt.claim.sub',$2,true)",[role,USER]);await db.exec(`SET LOCAL ROLE ${role}`);
   try{const query={connection_options:'SELECT public.hermes_connection_options_v4($1) value',context:'SELECT public.hermes_connection_context_v4($1) value',org_options:'SELECT public.hermes_org_policy_options_v4($1) value'}[kind];
     const value=(await db.query(query,[kind==='context'?CONNECTION:ORG])).rows[0].value;await db.exec('COMMIT');return value;
   }catch(error){await db.exec('ROLLBACK');throw error;}finally{await db.exec('RESET ROLE');}
 };
 await db.exec("UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability='sale_phong.manage_pass_listings'");
 assert.deepEqual(await call('connection_options'),options);assert.deepEqual((await call('org_options')).choices.action,['assistant.memory.write']);
 assert.equal((await db.query("SELECT enabled FROM app_private.hermes_capabilities WHERE capability='sale_phong.manage_pass_listings'")).rows[0].enabled,false);
 await db.exec("UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability='sale_phong.manage_pass_listings'");
 const result=await call('connection_options');assert.deepEqual(result.read,[]);assert.deepEqual(result.action,['assistant.memory.write',ACTION]);assert.equal(result.scopes[0].buildingId,BUILDING);
 assert.deepEqual(connectionOptions(result,ORG,USER).action,result.action);
 assert.throws(()=>connectionOptions({...result,scopes:[]},ORG,USER));
 const company=await call('org_options');assert.deepEqual(company.policy.action,[]);assert.deepEqual(company.choices.read,['tasks.view']);assert.deepEqual(company.choices.action,['assistant.memory.write',ACTION]);
 assert.deepEqual((await call('context')).effective,{read:[],action:[ACTION]});
 for(const changed of [{...context,scopeIds:[]},{...context,restrictions:{read:[],action:[]}},{...context,companyCeilings:{read:[],action:[]}}]){
   await db.query("UPDATE public.fixture_v3 SET result=$1 WHERE kind='context'",[JSON.stringify(changed)]);assert.deepEqual((await call('context')).effective.action,[]);
 }
 await db.exec('UPDATE public.fixture_action_acl SET allowed=false');assert.deepEqual(await call('connection_options'),options);
 await db.exec('UPDATE public.fixture_action_acl SET allowed=true');
 await db.query('UPDATE public.authorization_scopes SET building_id=$1',[FOREIGN]);assert.deepEqual(await call('connection_options'),options);
 await db.query('UPDATE public.authorization_scopes SET building_id=$1',[BUILDING]);
 await db.query("UPDATE public.fixture_v3 SET result=$1 WHERE kind='connection_options'",[JSON.stringify({...options,authorizationVersion:2})]);
 await assert.rejects(call('connection_options'),error=>error.code==='PT409');
 for(const role of ['anon','service_role'])await assert.rejects(call('org_options',role),/permission denied/);
 assert.equal((await db.query("SELECT has_function_privilege('authenticated','app_private.hermes_room_pass_extend_options_v1(jsonb,text)','EXECUTE') value")).rows[0].value,false);
});
