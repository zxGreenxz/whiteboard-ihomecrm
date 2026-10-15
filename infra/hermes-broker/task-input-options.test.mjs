import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {setup,input,binding,USER,ORG,FOREIGN,SESSION,BUILDING,ROOM,TYPE,ASSIGNEE} from './task-fixture.mjs';
import {prepareTaskMetadata,taskMetadataRpc} from './task-input-fixture.mjs';
import {taskActionInput,taskActionOperation,mayUseTaskAction,taskOptionsResult} from './task-input-contract.mjs';
const sql=()=>readFileSync(process.env.HERMES_TASK_OPTIONS_SQL??new URL('../../supabase/migrations/20261014094913_hermes_assistant_capabilities_v5.sql',import.meta.url),'utf8');
const options=(kind,buildingId=kind==='buildings'?null:BUILDING)=>({kind,buildingId,query:'',limit:20,cursor:null});
const code=expected=>error=>error.code===expected;
// 16/10 19:38Z: the model put the company id (organizationId) into buildingId.
const COMPANY_ID='aaaa0000-0000-4000-8000-000000000001';
async function fixture(t){const f=await setup(t);await prepareTaskMetadata(f.db);await f.db.exec(sql());await f.db.exec(sql());return {...f,call:(value,b=binding)=>taskMetadataRpc(f.db,b,value,{session:SESSION})};}

test('fixed action-input contract rejects arbitrary identity/directory and remains distinct from task-data Read',()=>{
 assert.equal(taskActionOperation('crm_task_input_options'),'options');for(const name of ['__proto__','toString','crm_read_tasks','rpc'])assert.equal(taskActionOperation(name),null);
 assert.equal(mayUseTaskAction({read:[],action:['tasks.create']},'options'),true);assert.equal(mayUseTaskAction({read:['tasks.view'],action:[]},'options'),false);
 assert.deepEqual(taskActionInput('options',options('buildings')),options('buildings'));
 for(const value of [{...options('rooms'),buildingId:null},{...options('assignees'),organizationId:ORG},{...options('jobTypes'),kind:'customers'},
  {...options('assignees'),query:'x'.repeat(101)},{...options('rooms'),limit:51}])assert.throws(()=>taskActionInput('options',value));
 // 16/10 19:38Z production: kind=buildings with the company id misplaced in buildingId (cursor nil UUID already null after #176).
 // Any string is dropped for kind=buildings, not only this one.
 const incident={kind:'buildings',buildingId:COMPANY_ID,query:'417LVT',limit:20,cursor:null};
 assert.deepEqual(taskActionInput('options',incident),{...incident,buildingId:null});
 for(const buildingId of [BUILDING,FOREIGN,'','Nhà A',' x\0'])assert.deepEqual(taskActionInput('options',{...options('buildings'),buildingId}),options('buildings'),'buildings ignores any string');
 for(const buildingId of [7,0,true,{},[],[BUILDING],undefined])assert.throws(()=>taskActionInput('options',{...options('buildings'),buildingId}),'non-string/null is still rejected');
 for(const kind of ['rooms','jobTypes','assignees']){
  assert.deepEqual(taskActionInput('options',options(kind,COMPANY_ID)),options(kind,COMPANY_ID),kind+' keeps the id for SQL to decide');
  for(const buildingId of [null,'','Nhà A',7])assert.throws(()=>taskActionInput('options',options(kind,buildingId)),kind+' still needs a real UUID');
 }
 const result={organizationId:ORG,kind:'buildings',buildingId:null,items:[{id:BUILDING,label:'Nhà A'}],nextCursor:null};
 assert.deepEqual(taskOptionsResult('options',result,{row:{organizationId:ORG},scopesByPermission:{'tasks.create':{buildingIds:[BUILDING]}}},options('buildings')),result);
 assert.deepEqual(taskOptionsResult('options',result,{row:{organizationId:ORG}},taskActionInput('options',incident)),result,'normalized input matches the SQL echo');
 assert.throws(()=>taskOptionsResult('options',{...result,buildingId:COMPANY_ID},{row:{organizationId:ORG}},taskActionInput('options',incident)));
 assert.throws(()=>taskOptionsResult('options',{...result,items:[{id:BUILDING,label:'Nhà A',phone:'private'}]},{row:{organizationId:ORG}},options('buildings')));
});

test('action-only selectors preserve canonical RLS and task_types.view, return bounded IDs/labels, never jobs or contacts',{timeout:60000},async t=>{
 const{db,call,counts,rpc}=await fixture(t);
 await db.exec("UPDATE app_private.hermes_connections SET read_capabilities='{}';UPDATE app_private.hermes_org_policies SET read_capabilities='{}'");
 for(const [kind,id] of [['buildings',BUILDING],['rooms',ROOM],['jobTypes',TYPE]]){
  const value=await call(options(kind));assert.equal(value.items[0].id,id);assert.deepEqual(Object.keys(value.items[0]).sort(),['id','label']);assert.equal(value.nextCursor,null);
 }
 const first=await call({...options('assignees'),limit:1});assert.deepEqual(first.items,[{id:ASSIGNEE,label:'Recipient'}]);assert.equal(first.nextCursor,ASSIGNEE);
 // Exact 16/10 incident arguments: SQL itself still demands null; through the contract it lists the matching building.
 const incident={kind:'buildings',buildingId:COMPANY_ID,query:'417LVT',limit:20,cursor:null};
 await db.exec("UPDATE public.buildings SET name='Toà 417LVT'");
 await assert.rejects(call(incident),code('22023'));
 assert.deepEqual(await call(taskActionInput('options',incident)),{organizationId:ORG,kind:'buildings',buildingId:null,items:[{id:BUILDING,label:'Toà 417LVT'}],nextCursor:null});
 await db.exec("UPDATE public.buildings SET name='Nhà A'");
 const second=await call({...options('assignees'),limit:1,cursor:first.nextCursor});assert.deepEqual(second.items,[{id:USER,label:'Actor'}]);assert.equal(second.nextCursor,null);
 assert.deepEqual((await call({...options('assignees'),query:'cipi'})).items,[{id:ASSIGNEE,label:'Recipient'}]);assert.deepEqual((await call({...options('assignees'),query:'%'})).items,[]);
 for(const [kind,flag] of [['buildings','building_rls'],['rooms','room_rls'],['jobTypes','type_rls'],['assignees','profile_rls']]){
  await db.exec(`UPDATE public.fixture_task_acl SET ${flag}=false`);assert.deepEqual((await call(options(kind))).items,[],kind+' RLS must hide metadata');
  if(kind==='jobTypes')await assert.rejects(rpc('create',input),code('42501'),'canonical create cannot bypass task_types.view either');
  await db.exec(`UPDATE public.fixture_task_acl SET ${flag}=true`);
 }
 await db.exec('UPDATE public.fixture_task_acl SET building_rls=false');for(const kind of ['rooms','jobTypes','assignees'])assert.deepEqual((await call(options(kind))).items,[]);
 assert.deepEqual(await counts(),{jobs:0,receipts:0,audits:0});
});

test('action-input lookup rejects foreign/inactive recipients and stale or missing Action/scope/session authority',{timeout:60000},async t=>{
 const{db,call,counts}=await fixture(t);
 await db.exec(`INSERT INTO auth.users VALUES('${FOREIGN}');INSERT INTO public.profiles VALUES('${FOREIGN}','Visible foreign profile');
  INSERT INTO public.staff_assignments VALUES('${USER}','${FOREIGN}');
  INSERT INTO public.organization_memberships(id,user_id,organization_id,status) VALUES('${FOREIGN}','${FOREIGN}','${FOREIGN}','ACTIVE');`);
 assert.equal((await call(options('assignees'))).items.some(row=>row.id===FOREIGN),false);
 await db.exec(`UPDATE public.organization_memberships SET revoked_at=clock_timestamp() WHERE user_id='${ASSIGNEE}'`);
 assert.equal((await call(options('assignees'))).items.some(row=>row.id===ASSIGNEE),false);
 await assert.rejects(call(options('rooms',FOREIGN)),code('42501'));
 // Not loosened for child kinds: a well-formed id that is not a building (the company id) reaches SQL and is denied there.
 for(const kind of ['rooms','jobTypes','assignees'])await assert.rejects(call(taskActionInput('options',options(kind,COMPANY_ID))),code('42501'),kind);
 await assert.rejects(call(options('assignees'),{...binding,expectedEpoch:2}),code('PT409'));
 await db.exec("UPDATE app_private.hermes_connections SET action_capabilities='{}'");await assert.rejects(call(options('buildings')),code('42501'));
 await db.exec("UPDATE app_private.hermes_connections SET action_capabilities=ARRAY['tasks.create'];UPDATE public.authorization_scopes SET building_id=null");
 assert.deepEqual((await call(options('buildings'))).items,[]);await assert.rejects(call(options('assignees')),code('42501'));
 assert.deepEqual(await counts(),{jobs:0,receipts:0,audits:0});
 const acl=(await db.query(`SELECT has_schema_privilege('authenticated','app_private','USAGE') private_usage,
   has_function_privilege('service_role','public.hermes_task_input_options_v1(jsonb,jsonb)','EXECUTE') service_exec,
   (SELECT prosecdef FROM pg_proc WHERE oid='public.hermes_task_input_options_v1(jsonb,jsonb)'::regprocedure) public_definer,
   (SELECT prosecdef FROM pg_proc WHERE oid='app_private.hermes_task_input_rows_v1(jsonb)'::regprocedure) rows_definer`)).rows[0];
 assert.deepEqual(acl,{private_usage:false,service_exec:false,public_definer:false,rows_definer:false});
});
