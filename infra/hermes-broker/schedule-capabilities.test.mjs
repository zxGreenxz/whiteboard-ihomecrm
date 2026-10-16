import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { createScheduleAuthAdapter } from './schedule-adapter.mjs';
import { createBroker } from './broker.mjs';
import { createDependencyScope } from './dependency-scope.mjs';
import { DOMAIN_READ_CAPABILITIES } from './domain-contract.mjs';
const id=n=>`${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const USER=id('1'),ORG=id('2'),MEMBER=id('3'),CONNECTION=id('4');
const source=slug=>{const root=new URL('../../supabase/migrations/',import.meta.url),names=readdirSync(root).filter(n=>n.endsWith('_'+slug+'.sql'));assert.equal(names.length,1);return readFileSync(new URL(names[0],root),'utf8');};
// Actual v2, memory capability and combined v3 SQL. Auth/CRM/base v1 are
// explicit synthetic ports; this does not claim Supabase JWT or MVCC evidence.
test('combined v3 SQL intersects current CRM, catalog, company and connection without replacing v2',async t=>{
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE ROLE hermes_store_executor;
    CREATE SCHEMA auth;CREATE SCHEMA app_private;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT '${USER}'::uuid$$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$SELECT 'authenticated'::text$$;
    CREATE TABLE app_private.hermes_capabilities(capability text PRIMARY KEY,mode text,enabled boolean);
    INSERT INTO app_private.hermes_capabilities VALUES('assistant.memory.read','read',false),('assistant.memory.write','action',false);
    CREATE TABLE app_private.hermes_org_policies(organization_id uuid,enabled boolean,version bigint,read_capabilities text[],action_capabilities text[],scope_ids uuid[]);
    INSERT INTO app_private.hermes_org_policies VALUES('${ORG}',true,0,ARRAY['assistant.memory.read'],ARRAY['assistant.memory.write','chat_zalo.manage_automation'],ARRAY['${id('5')}']::uuid[]);
    CREATE TABLE public.fixture_acl(allowed boolean,version bigint);INSERT INTO public.fixture_acl VALUES(true,4);
    CREATE TABLE public.fixture_ports(kind text PRIMARY KEY,value jsonb);
    CREATE FUNCTION app_private.lock_org_for_decision_v1(uuid) RETURNS void LANGUAGE sql AS $$SELECT$$;
    CREATE FUNCTION app_private.is_actor_offboarded_v1() RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
    CREATE FUNCTION app_private.hermes_uuid_v1(value jsonb) RETURNS uuid LANGUAGE sql AS $$SELECT (value#>>'{}')::uuid$$;
    CREATE FUNCTION app_private.require_perm_v1(uuid,text,text) RETURNS void LANGUAGE sql AS $$SELECT$$;
    CREATE TABLE public.buildings(id uuid,organization_id uuid,name text,deleted_at timestamptz);
    INSERT INTO public.buildings VALUES('${id('6')}','${ORG}','Building',NULL);
    CREATE TABLE public.areas(id uuid,organization_id uuid,name text,deleted_at timestamptz);
    CREATE TABLE public.area_buildings(area_id uuid,organization_id uuid,building_id uuid);
    CREATE TABLE public.authorization_scopes(id uuid,organization_id uuid,scope_type text,building_id uuid,area_id uuid,cashbook_id uuid);
    INSERT INTO public.authorization_scopes VALUES('${id('5')}','${ORG}','ORGANIZATION',NULL,NULL,NULL);
    CREATE FUNCTION app_private.authorized_scope_v3(text,uuid) RETURNS TABLE(org_wide boolean,building_ids uuid[]) LANGUAGE sql AS $$SELECT true,ARRAY['${id('6')}']::uuid[]$$;
    CREATE FUNCTION app_private.hermes_member_v1(uuid,uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_object('membershipId','${MEMBER}','authorizationVersion',4,'isSuperadmin',false)$$;
    CREATE FUNCTION app_private.hermes_effective_org_policy_v1(uuid,text[],text[],uuid[]) RETURNS app_private.hermes_org_policies LANGUAGE sql AS $$SELECT * FROM app_private.hermes_org_policies$$;
    CREATE FUNCTION app_private.authorize_tenant_action_v3(actor uuid,org uuid,permission text) RETURNS TABLE(allowed boolean,authorization_version bigint) LANGUAGE sql AS $$
      SELECT allowed AND actor='${USER}' AND org='${ORG}' AND permission='chat_zalo.manage_automation',version FROM public.fixture_acl$$;
    CREATE FUNCTION public.hermes_org_policy_options_v1(uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT value FROM public.fixture_ports WHERE kind='policy'$$;
    CREATE FUNCTION public.hermes_connection_options_v1(uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT value FROM public.fixture_ports WHERE kind='options'$$;
    CREATE FUNCTION public.hermes_connection_context_v1(uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT value FROM public.fixture_ports WHERE kind='context'$$;
    CREATE FUNCTION public.hermes_group_action_context_v1(uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT value FROM public.fixture_ports WHERE kind='group'$$;`);
  await db.exec(`CREATE FUNCTION public.get_authorization_context_v1(uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_object('organizationId','${ORG}',
    'membershipId','${MEMBER}','authorizationVersion',4,'isOffboarded',false,'permissions','${JSON.stringify(Object.fromEntries(DOMAIN_READ_CAPABILITIES.map(key=>[key,true])))}'::jsonb)$$;`);
  const identity={userId:USER,organizationId:ORG,membershipId:MEMBER,authorizationVersion:4,policyVersion:0,isSuperadmin:false};
  const ports={policy:{...identity,choices:{read:['rooms.view'],action:[],scopes:[]}},options:{...identity,enabled:true,read:['rooms.view'],action:[],scopes:[]},
    context:{...identity,id:CONNECTION,restrictions:{read:['rooms.view','assistant.memory.read'],action:['chat_zalo.send','assistant.memory.write','chat_zalo.manage_automation']},
      companyCeilings:{read:['rooms.view','assistant.memory.read'],action:['chat_zalo.send','assistant.memory.write','chat_zalo.manage_automation']},effective:{read:['rooms.view'],action:[]}},
    group:{...identity,allowed:true,companyEnabled:true,readAllowed:false,readCompanyEnabled:false}};
  const set=(kind,value)=>db.query('INSERT INTO public.fixture_ports VALUES($1,$2) ON CONFLICT(kind) DO UPDATE SET value=EXCLUDED.value',[kind,JSON.stringify(value)]);
  for(const [kind,value]of Object.entries(ports))await set(kind,value);
  await db.exec(source('hermes_group_capability_options_v2'));
  const memory=source('hermes_work_memory_v1').match(/CREATE OR REPLACE FUNCTION public.hermes_work_memory_capabilities_v1[\s\S]*?END \$fn\$;/)[0];await db.exec(memory);
  const domain=source('hermes_domain_reads_v1');
  for(const name of ['public.hermes_domain_capabilities_v1','app_private.hermes_domain_extend_options_v1'])await db.exec(domain.match(new RegExp('CREATE OR REPLACE FUNCTION '+name.replaceAll('.','\\.')+'[\\s\\S]*?END \\$fn\\$;'))[0]);
  for(const key of DOMAIN_READ_CAPABILITIES)await db.query("INSERT INTO app_private.hermes_capabilities VALUES($1,'read',false)",[key]);
  const sql=source('hermes_assistant_capabilities_v3');await db.exec(sql);await db.exec(sql);
  const call=async(name,arg=ORG)=>(await db.query(`SELECT public.${name}($1::uuid) value`,[arg])).rows[0].value;
  assert.deepEqual((await call('hermes_connection_options_v3')).action,[]);
  await db.exec('UPDATE app_private.hermes_capabilities SET enabled=true');
  const all=['chat_zalo.send','assistant.memory.write','chat_zalo.manage_automation'];
  assert.deepEqual((await call('hermes_connection_options_v3')).action,all);
  assert.deepEqual((await call('hermes_org_policy_options_v3')).choices.action,all);
  assert.deepEqual((await call('hermes_connection_context_v3',CONNECTION)).effective,{read:['rooms.view','assistant.memory.read'],action:all});
  await db.query('UPDATE app_private.hermes_org_policies SET read_capabilities=read_capabilities||$1::text[]',[DOMAIN_READ_CAPABILITIES]);
  const extended=await call('hermes_connection_options_v3');
  assert.deepEqual(new Set(extended.read),new Set(['rooms.view','assistant.memory.read',...DOMAIN_READ_CAPABILITIES]));assert.equal(extended.scopes.length,1);
  assert.deepEqual(new Set((await call('hermes_org_policy_options_v3')).choices.read),new Set(['rooms.view','chat_zalo.view','assistant.memory.read',...DOMAIN_READ_CAPABILITIES]));
  // Domain permissions alone cannot widen a saved connection overlay.
  assert.deepEqual((await call('hermes_connection_context_v3',CONNECTION)).effective,{read:['rooms.view','assistant.memory.read'],action:all});
  await set('context',{...ports.context,restrictions:{...ports.context.restrictions,read:['contracts.view']},companyCeilings:{...ports.context.companyCeilings,read:['contracts.view']},effective:{read:[],action:[]}});
  assert.deepEqual((await call('hermes_connection_context_v3',CONNECTION)).effective.read,['contracts.view']);await set('context',ports.context);
  await db.exec('UPDATE public.fixture_acl SET allowed=false');
  assert.deepEqual((await call('hermes_connection_options_v3')).action,['chat_zalo.send','assistant.memory.write']);
  await db.exec('UPDATE public.fixture_acl SET allowed=true');
  for(const field of ['restrictions','companyCeilings']){
    await set('context',{...ports.context,[field]:{read:['rooms.view'],action:['chat_zalo.send']}});
    assert.deepEqual((await call('hermes_connection_context_v3',CONNECTION)).effective,{read:['rooms.view'],action:['chat_zalo.send']});
  }
  await set('context',ports.context);await db.exec("UPDATE app_private.hermes_org_policies SET action_capabilities=ARRAY['assistant.memory.write']");
  assert.equal((await call('hermes_room_schedule_capabilities_v1')).allowed,false);
  await db.exec('UPDATE public.fixture_acl SET version=5');await assert.rejects(call('hermes_connection_options_v3'),error=>error.code==='PT409');
  for(const name of ['hermes_connection_options_v3','hermes_connection_context_v3','hermes_org_policy_options_v3','hermes_room_schedule_capabilities_v1']){
    for(const role of ['anon','service_role','hermes_store_executor'])assert.equal((await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed",[role,`public.${name}(uuid)`])).rows[0].allowed,false);
  }
});
test('schedule auth preserves memory/group grants and requires current CRM metadata',async()=>{
  const base={isSuperadmin:false,epoch:'base',membership:{membershipId:MEMBER,authorizationVersion:4},permissions:{read:['assistant.memory.read'],action:['assistant.memory.write','chat_zalo.send']},companyCeilings:{read:['assistant.memory.read'],action:['assistant.memory.write','chat_zalo.send']},scopesByPermission:{}};
  const capability={organizationId:ORG,userId:USER,membershipId:MEMBER,authorizationVersion:4,isSuperadmin:false,policyVersion:0,allowed:true,companyEnabled:true};
  const auth=createScheduleAuthAdapter({baseAuth:{verifySession:async()=>({}),readAuthorization:async()=>base},reads:{capabilities:async()=>capability}});
  const input={organizationId:ORG,userId:USER,accessToken:'unused',signal:new AbortController().signal};
  assert.deepEqual((await auth.readAuthorization(input)).permissions.action,['assistant.memory.write','chat_zalo.send','chat_zalo.manage_automation']);
  capability.allowed=false;assert.deepEqual((await auth.readAuthorization(input)).permissions.action,base.permissions.action);
  capability.authorizationVersion=5;await assert.rejects(auth.readAuthorization(input),/context_changed/);
});
test('broker gates schedule tools by overlay and returns unknown write outcome without retry',async t=>{
  const scope=createDependencyScope();t.after(()=>scope.close());const events=[];
  const identity={row:{id:CONNECTION,assistantId:MEMBER,userId:USER,organizationId:ORG,expiresAt:Date.now()+600000,epoch:1,state:'active',restrictions:{read:['chat_zalo.view','rooms.view'],action:['chat_zalo.send','chat_zalo.manage_automation']}},effective:{read:['chat_zalo.view','rooms.view'],action:['chat_zalo.send','chat_zalo.manage_automation']},isSuperadmin:false,policyEpoch:'a'.repeat(64),contextVersion:'b'.repeat(64),assistantScopeIds:[],scopesByPermission:{}};
  identity.scopesByPermission=Object.fromEntries([...identity.effective.read,...identity.effective.action].map(key=>[key,{buildingIds:[],cashbookIds:[]}]));
  const broker=createBroker({authority:{identifyConnection:async()=>({connectionId:CONNECTION}),resolve:async()=>identity,checkUnchanged:async()=>{}},dependencyScope:scope,audit:async()=>events.push('audit'),
    schedules:{prepareSchedule:async()=>{events.push('prepare');return Object.freeze({});},finalizeSchedule:async(_t,_r,options)=>{events.push('finalize');options.onDispatch();throw Error('lost ACK');}}});
  // Cutover P6.06: create/update are retired (CRM automation is the one scheduler); legacy rows stay readable/revocable.
  const token='hc_'+'A'.repeat(43);assert.deepEqual((await broker.listTools(token)).tools.filter(t=>t.name.startsWith('crm_room_schedule')).map(t=>t.name).sort(),['crm_room_schedule_issues','crm_room_schedule_list','crm_room_schedule_reconcile','crm_room_schedule_revoke']);
  await assert.rejects(broker.callTool(token,'crm_room_schedule_create',{requestId:MEMBER,settings:{}}),/tool_not_available/);
  assert.equal(events.filter(x=>x==='prepare').length,0);events.length=0;
  await assert.rejects(broker.callTool(token,'crm_room_schedule_revoke',{requestId:MEMBER,scheduleId:ORG,expectedRevision:1}),e=>e.code==='schedule_outcome_unknown');
  assert.equal(events.filter(x=>x==='finalize').length,1);assert.deepEqual(events.slice(0,3),['prepare','audit','finalize']);
  identity.effective.action=[];assert.deepEqual((await broker.listTools(token)).tools.filter(t=>t.name.startsWith('crm_room_schedule')).map(t=>t.name).sort(),['crm_room_schedule_issues','crm_room_schedule_list']);
  await assert.rejects(broker.callTool(token,'crm_room_schedule_revoke',{requestId:MEMBER,scheduleId:ORG,expectedRevision:1}),/tool_not_available/);
});

test('shared broker discovers only granted domain reads and keeps final SQL after audit',async t=>{
  const scope=createDependencyScope();t.after(()=>scope.close());const events=[];
  const identity={row:{id:CONNECTION,assistantId:MEMBER,userId:USER,organizationId:ORG,expiresAt:Date.now()+600000,epoch:1,state:'active',restrictions:{read:['contracts.view'],action:[]}},effective:{read:['contracts.view'],action:[]},isSuperadmin:false,policyEpoch:'a'.repeat(64),contextVersion:'b'.repeat(64),assistantScopeIds:[],scopesByPermission:{'contracts.view':{buildingIds:[],cashbookIds:[]}}};
  const broker=createBroker({authority:{identifyConnection:async()=>({connectionId:CONNECTION}),resolve:async()=>identity,checkUnchanged:async()=>{}},dependencyScope:scope,audit:async()=>events.push('audit'),
    domains:{prepareDomain:async(_t,operation)=>{assert.equal(operation,'contracts');events.push('prepare');return Object.freeze({});},finalizeDomain:async()=>{events.push('sql');return {organizationId:ORG,domain:'contracts',items:[],nextCursor:null};}}});
  const token='hc_'+'A'.repeat(43);assert.deepEqual((await broker.listTools(token)).tools.map(t=>t.name),['crm_read_contracts']);events.length=0;
  const result=await broker.callTool(token,'crm_read_contracts',{});assert.equal(result.isError,false);assert.deepEqual(events,['prepare','audit','sql']);
  await assert.rejects(broker.callTool(token,'crm_read_invoices',{}),/tool_not_available/);
});
