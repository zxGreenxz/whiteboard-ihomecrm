// crm_task_input_options không cần buildingId cho jobTypes/assignees (22/10/2026, câu 29). Bot thật trên TEST 21/10:
// schema quảng bá cho bỏ trống buildingId ⇒ kind=assignees/jobTypes không kèm toà ⇒ invalid_request ⇒ ba lỗi liền nhau
// Hermes tạm khoá MCP ~59 s ⇒ 21/27 lần tạo việc hỏng. Migration 20261021172540 (SQL thật, PGlite) cho hai loại đó chạy
// với buildingId null khi người dùng có tasks.create ở ít nhất một toà trong phạm vi kết nối; có buildingId thì y như v5.
// Kiểm đột biến: scripts/dot-bien.mjs sửa thẳng file migration (hoặc trỏ HERMES_TASK_OPTIONS_NO_BUILDING_SQL vào bản sửa).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {setup,binding,USER,ORG,FOREIGN,SESSION,BUILDING,ROOM,TYPE,SCOPE,ASSIGNEE} from './task-fixture.mjs';
import {prepareTaskMetadata,taskMetadataRpc} from './task-input-fixture.mjs';

const V5=new URL('../../supabase/migrations/20261014094913_hermes_assistant_capabilities_v5.sql',import.meta.url);
export const NO_BUILDING_PATH='supabase/migrations/20261021172540_hermes_task_input_options_no_building_v1.sql';
const candidate=()=>readFileSync(process.env.HERMES_TASK_OPTIONS_NO_BUILDING_SQL??new URL('../../'+NO_BUILDING_PATH,import.meta.url),'utf8');
const options=(kind,buildingId=null,extra={})=>({kind,buildingId,query:'',limit:20,cursor:null,...extra});
const code=expected=>error=>error.code===expected;
// 16/10 incident: the company id (organizationId) misplaced into buildingId.
const COMPANY_ID='aaaa0000-0000-4000-8000-000000000001';
// A second building of the same company, reachable through its own BUILDING overlay scope.
const OTHER_BUILDING='bbbb0000-0000-4000-8000-000000000002',OTHER_SCOPE='eeee0000-0000-4000-8000-000000000002';

async function fixture(t,{apply=true}={}){
 const f=await setup(t);await prepareTaskMetadata(f.db);await f.db.exec(readFileSync(V5,'utf8'));
 // Idempotent: the forward lane runs a candidate twice.
 if(apply){await f.db.exec(candidate());await f.db.exec(candidate());}
 return {...f,call:(value,b=binding)=>taskMetadataRpc(f.db,b,value,{session:SESSION})};
}
const outcome=promise=>promise.then(value=>({value}),error=>({code:error.code??String(error)}));

test('v5 (production/TEST 21/10) refuses a company-wide lookup with 22023: the SQL side of the incident',{timeout:60000},async t=>{
 const{call}=await fixture(t,{apply:false});
 for(const kind of ['jobTypes','assignees'])await assert.rejects(call(options(kind)),code('22023'),kind);
 assert.equal((await call(options('assignees',BUILDING))).items.length,2,'with the building it always worked');
});

test('jobTypes/assignees without buildingId list the company catalog; rooms still needs the building',{timeout:60000},async t=>{
 const{db,call,counts}=await fixture(t);
 assert.deepEqual(await call(options('jobTypes')),{organizationId:ORG,kind:'jobTypes',buildingId:null,items:[{id:TYPE,label:'Sửa chữa'}],nextCursor:null});
 const all=await call(options('assignees'));
 assert.deepEqual(all,{organizationId:ORG,kind:'assignees',buildingId:null,items:[{id:ASSIGNEE,label:'Recipient'},{id:USER,label:'Actor'}],nextCursor:null});
 assert.deepEqual(all.items,(await call(options('assignees',BUILDING))).items,'same members as with the building');
 const first=await call(options('assignees',null,{limit:1}));
 assert.deepEqual([first.items,first.nextCursor],[[{id:ASSIGNEE,label:'Recipient'}],ASSIGNEE]);
 const second=await call(options('assignees',null,{limit:1,cursor:first.nextCursor}));
 assert.deepEqual([second.items,second.nextCursor,second.buildingId],[[{id:USER,label:'Actor'}],null,null]);
 assert.deepEqual((await call(options('assignees',null,{query:'cipi'}))).items,[{id:ASSIGNEE,label:'Recipient'}]);
 assert.deepEqual((await call(options('jobTypes',null,{query:'không có'}))).items,[]);
 // rooms: a building is still required, never "every room of the company".
 await assert.rejects(call(options('rooms')),code('22023'));
 assert.deepEqual((await call(options('buildings'))).items,[{id:BUILDING,label:'Nhà A'}]);
 await assert.rejects(call(options('buildings',BUILDING)),code('22023'),'buildings still demands null');
 // Canonical RLS still decides what is listed (task_types.view, profile visibility).
 await db.exec('UPDATE public.fixture_task_acl SET type_rls=false,profile_rls=false');
 for(const kind of ['jobTypes','assignees'])assert.deepEqual((await call(options(kind))).items,[],kind);
 await db.exec('UPDATE public.fixture_task_acl SET type_rls=true,profile_rls=true');
 // Foreign/inactive recipients stay out without a building too.
 await db.exec(`INSERT INTO auth.users VALUES('${FOREIGN}');INSERT INTO public.profiles VALUES('${FOREIGN}','Visible foreign profile');
  INSERT INTO public.staff_assignments VALUES('${USER}','${FOREIGN}');
  INSERT INTO public.organization_memberships(id,user_id,organization_id,status) VALUES('${FOREIGN}','${FOREIGN}','${FOREIGN}','ACTIVE');
  UPDATE public.organization_memberships SET revoked_at=clock_timestamp() WHERE user_id='${ASSIGNEE}'`);
 assert.deepEqual((await call(options('assignees'))).items,[{id:USER,label:'Actor'}]);
 assert.deepEqual(await counts(),{jobs:0,receipts:0,audits:0});
});

test('company-wide lookup needs tasks.create on at least one building of the connection scope, never wider',{timeout:60000},async t=>{
 const{db,call,counts}=await fixture(t);
 const denied=async(label,sql,undo)=>{
  await db.exec(sql);
  for(const kind of ['jobTypes','assignees'])await assert.rejects(call(options(kind)),code('42501'),`${label}: ${kind}`);
  await db.exec(undo);
  assert.equal((await call(options('assignees'))).items.length,2,`${label}: restored`);
 };
 // Connection overlay no longer covers the building (CRM permission unchanged).
 await denied('overlay',`UPDATE public.authorization_scopes SET building_id=null`,`UPDATE public.authorization_scopes SET building_id='${BUILDING}'`);
 await denied('connection scope',`UPDATE app_private.hermes_connections SET scope_ids='{}'`,`UPDATE app_private.hermes_connections SET scope_ids=ARRAY['${SCOPE}'::uuid]`);
 await denied('policy scope',`UPDATE app_private.hermes_org_policies SET scope_ids='{}'`,`UPDATE app_private.hermes_org_policies SET scope_ids=ARRAY['${SCOPE}'::uuid]`);
 // CRM tasks.create decided per building: granted on another building only.
 await denied('CRM building',`UPDATE public.fixture_task_acl SET building_id='${FOREIGN}'`,`UPDATE public.fixture_task_acl SET building_id='${BUILDING}'`);
 await denied('CRM deadline',`UPDATE public.fixture_task_acl SET deadline=clock_timestamp()-interval '1 minute'`,`UPDATE public.fixture_task_acl SET deadline=null`);
 await denied('soft-deleted building',`UPDATE public.buildings SET deleted_at=clock_timestamp()`,`UPDATE public.buildings SET deleted_at=null`);
 await denied('CRM permission',`UPDATE public.fixture_task_acl SET allowed=false`,`UPDATE public.fixture_task_acl SET allowed=true`);
 await denied('connection Action',`UPDATE app_private.hermes_connections SET action_capabilities='{}'`,`UPDATE app_private.hermes_connections SET action_capabilities=ARRAY['tasks.create']`);
 await denied('registry',`UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability='tasks.create'`,`UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability='tasks.create'`);
 // Stale binding: same PT409 as with a building.
 await assert.rejects(call(options('assignees'),{...binding,expectedEpoch:2}),code('PT409'));
 // RLS: the INVOKER rows step needs one authorized building the asker can still see.
 await db.exec('UPDATE public.fixture_task_acl SET building_rls=false');
 for(const kind of ['jobTypes','assignees'])assert.deepEqual((await call(options(kind))).items,[],kind);
 await db.exec('UPDATE public.fixture_task_acl SET building_rls=true');
 assert.deepEqual(await counts(),{jobs:0,receipts:0,audits:0});
});

test('"at least one building" is any building of the scope, while a named building is still checked itself',{timeout:60000},async t=>{
 const{db,call}=await fixture(t);
 await db.exec(`INSERT INTO public.buildings(id,organization_id,deleted_at,name) VALUES('${OTHER_BUILDING}','${ORG}',null,'Nhà B');
  INSERT INTO public.authorization_scopes VALUES('${OTHER_SCOPE}','${ORG}','BUILDING','${OTHER_BUILDING}',null,null);
  UPDATE app_private.hermes_connections SET scope_ids=ARRAY['${SCOPE}','${OTHER_SCOPE}']::uuid[];
  UPDATE app_private.hermes_org_policies SET scope_ids=ARRAY['${SCOPE}','${OTHER_SCOPE}']::uuid[];
  UPDATE public.fixture_task_acl SET building_id='${OTHER_BUILDING}'`);
 assert.deepEqual((await call(options('buildings'))).items,[{id:OTHER_BUILDING,label:'Nhà B'}]);
 for(const kind of ['jobTypes','assignees']){
  await assert.rejects(call(options(kind,BUILDING)),code('42501'),kind+': the named building is outside tasks.create');
  assert.ok((await call(options(kind))).items.length>0,kind+': company-wide through the other building');
 }
 await assert.rejects(call(options('rooms',BUILDING)),code('42501'));
 // A building of another company never counts, even when an overlay row points at it.
 await db.exec(`UPDATE public.buildings SET organization_id='${FOREIGN}' WHERE id='${OTHER_BUILDING}'`);
 for(const kind of ['jobTypes','assignees'])await assert.rejects(call(options(kind)),code('42501'),kind);
});

test('with a buildingId every kind answers exactly as v5 (results and error codes)',{timeout:120000},async t=>{
 const before=await fixture(t,{apply:false}),after=await fixture(t);
 const inputs=[options('buildings'),options('buildings',null,{query:'Nhà'}),options('rooms',BUILDING),options('rooms',FOREIGN),options('rooms',COMPANY_ID),
  options('jobTypes',BUILDING),options('jobTypes',FOREIGN),options('jobTypes',COMPANY_ID),options('assignees',BUILDING),options('assignees',BUILDING,{limit:1}),
  options('assignees',BUILDING,{limit:1,cursor:ASSIGNEE}),options('assignees',BUILDING,{query:'%'}),options('assignees',COMPANY_ID),
  options('rooms',BUILDING,{cursor:ROOM}),options('jobTypes',BUILDING,{query:'sửa'})];
 const states=[['default',''],['buildings hidden','UPDATE public.fixture_task_acl SET building_rls=false'],['rooms hidden','UPDATE public.fixture_task_acl SET room_rls=false'],
  ['overlay gone','UPDATE public.authorization_scopes SET building_id=null'],['CRM elsewhere',`UPDATE public.fixture_task_acl SET building_id='${FOREIGN}'`]];
 for(const [label,sql] of states){
  for(const f of [before,after])if(sql)await f.db.exec(sql);
  for(const value of inputs){
   assert.deepEqual(await outcome(after.call(value)),await outcome(before.call(value)),`${label}: ${JSON.stringify(value)}`);
  }
  for(const f of [before,after])await f.db.exec(`UPDATE public.fixture_task_acl SET building_rls=true,room_rls=true,building_id='${BUILDING}';
   UPDATE public.authorization_scopes SET building_id='${BUILDING}'`);
 }
});

test('migration keeps the reviewed signatures, owner, ACL and entry OIDs, and refuses an unknown guard body',{timeout:60000},async t=>{
 const{db}=await fixture(t);
 const acl=(await db.query(`SELECT has_schema_privilege('authenticated','app_private','USAGE') private_usage,
   has_function_privilege('service_role','app_private.hermes_task_input_guard_v1(jsonb,jsonb)','EXECUTE') guard_service,
   has_function_privilege('anon','app_private.hermes_task_input_rows_v1(jsonb)','EXECUTE') rows_anon,
   has_function_privilege('authenticated','app_private.hermes_task_input_rows_v1(jsonb)','EXECUTE') rows_authenticated,
   (SELECT prosecdef FROM pg_proc WHERE oid='app_private.hermes_task_input_guard_v1(jsonb,jsonb)'::regprocedure) guard_definer,
   (SELECT prosecdef FROM pg_proc WHERE oid='app_private.hermes_task_input_rows_v1(jsonb)'::regprocedure) rows_definer,
   (SELECT count(DISTINCT d.refobjid)::int FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid='public.hermes_task_input_options_v1(jsonb,jsonb)'::regprocedure
     AND d.refobjid IN ('app_private.hermes_task_input_guard_v1(jsonb,jsonb)'::regprocedure,'app_private.hermes_task_input_rows_v1(jsonb)'::regprocedure)) entry_bound`)).rows[0];
 assert.deepEqual(acl,{private_usage:false,guard_service:false,rows_anon:false,rows_authenticated:true,guard_definer:true,rows_definer:false,entry_bound:2});
 // An unreviewed guard body (neither v5 nor this file) stops the forward lane before any change.
 const guard=readFileSync(V5,'utf8').match(/CREATE OR REPLACE FUNCTION app_private\.hermes_task_input_guard_v1[\s\S]*?END \$fn\$;/)[0];
 await db.exec(guard.replace("'hermes_task_denied'","'hermes_task_denied_changed'"));
 await assert.rejects(db.exec(candidate()),/hermes_task_input_no_building_requires_v5_guard/);
});
