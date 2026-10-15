import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setup,id,input,binding,USER,ORG,FOREIGN,SESSION,CONNECTION,BUILDING,ROOM,TYPE,REQUEST,ASSIGNEE } from './task-fixture.mjs';
import { taskInput,taskResult,mayUseTask } from './task-contract.mjs';
import { createTaskReads,createTaskService,createTaskAuth } from './task-adapter.mjs';
const code=expected=>error=>error.code===expected;
const identity={row:{organizationId:ORG,userId:USER},scopesByPermission:{'tasks.create':{buildingIds:[BUILDING]}}};

test('fixed DTO admits create/status only, never actor, org, status, material, arbitrary RPC or recipient impersonation',()=>{
 assert.deepEqual(taskInput('create',input),input);
 assert.equal(mayUseTask({read:['tasks.create'],action:[]},'create'),false);
 assert.equal(mayUseTask({action:['tasks.create']},'create'),true);
 assert.equal(mayUseTask({action:['tasks.create']},'finalize'),false);
 for(const [key,value] of Object.entries({actorId:USER,userId:ASSIGNEE,organizationId:ORG,status:'COMPLETED',attachments:[],materials:[],rpc:'anything'}))
  assert.throws(()=>taskInput('create',{...input,[key]:value}));
 for(const patch of [{title:''},{title:' x '},{title:'x'.repeat(201)},{description:'x'.repeat(4001)},{priority:'HIGH'},{deadline:'2026-02-30T08:00:00.000Z'},{deadline:'2026-10-14'},{buildingId:null}])
  assert.throws(()=>taskInput('create',{...input,...patch}));
 assert.throws(()=>taskResult('create',{organizationId:ORG,requestId:REQUEST,outcome:'unknown',job:null},identity,input));
 for(const outcome of ['not_found','unknown'])assert.equal(taskResult('status',{organizationId:ORG,requestId:REQUEST,outcome,job:null},identity,{requestId:REQUEST}).outcome,outcome);
});

test('canonical INSERT executes RLS, generates CRM code, assigns recipient while preserving actor, and commits one receipt/audit',{timeout:60000},async t=>{
 const{db,rpc,counts}=await setup(t);
 const capabilities=await rpc('capabilities',{});assert.equal(capabilities.allowed,true);assert.deepEqual(capabilities.buildingIds,[BUILDING]);
 const applied=await rpc('create',input);assert.equal(applied.outcome,'applied');assert.match(applied.job.code,/^JOB-\d{8}-\d{4}$/);
 assert.equal(applied.job.createdBy,USER);assert.equal(applied.job.assigneeId,ASSIGNEE);assert.equal(applied.job.status,'IN_PROGRESS');
 assert.deepEqual(taskResult('create',applied,identity,input),applied);
 assert.deepEqual(await rpc('create',input),applied);assert.deepEqual(await rpc('status',{requestId:REQUEST}),applied);
 assert.deepEqual(await counts(),{jobs:1,receipts:1,audits:1});
 const row=(await db.query('SELECT user_id,assignee_id,visible_to_customer,attachments,completion_time,started_at FROM public.jobs')).rows[0];
 assert.equal(row.user_id,USER);assert.equal(row.assignee_id,ASSIGNEE);assert.equal(row.visible_to_customer,false);assert.equal(row.attachments,null);assert.equal(row.completion_time,null);assert.ok(row.started_at);
 const audit=(await db.query('SELECT actor_user_id,new_state FROM public.authorization_audit_events')).rows[0];
 assert.equal(audit.actor_user_id,USER);assert.equal(audit.new_state.actor,USER);assert.equal(audit.new_state.assigneeId,ASSIGNEE);
 await assert.rejects(rpc('create',{...input,title:'Đổi ý'}),code('PT409'));
 assert.deepEqual(await counts(),{jobs:1,receipts:1,audits:1});
 assert.deepEqual(await rpc('status',{requestId:id('9')}),{organizationId:ORG,requestId:id('9'),outcome:'not_found',job:null});
});

test('deadline: any zoned RFC 3339 form becomes the canonical SQL form; zone-less is refused; the SQL echo stays strict',{timeout:60000},async t=>{
 // input.deadline is 2026-10-20T08:30:00.000Z; same pattern as the 16/10 21:27Z schedule expiresAt incident.
 for(const deadline of ['2026-10-20T08:30:00Z','2026-10-20T08:30Z','2026-10-20T15:30:00+07:00','2026-10-20T15:30+07:00',input.deadline])
  assert.deepEqual(taskInput('create',{...input,deadline}),input,deadline);
 assert.equal(taskInput('create',{...input,deadline:'2026-10-20T08:30:00.5Z'}).deadline,'2026-10-20T08:30:00.500Z');
 assert.equal(taskInput('create',{...input,deadline:null}).deadline,null);
 for(const deadline of ['2026-10-20T08:30:00','2026-10-20T08:30:00.000','2026-10-20 08:30:00Z','2026-10-20T08:30:00+0700','2026-10-20T24:00:00Z',Date.parse(input.deadline),''])
  assert.throws(()=>taskInput('create',{...input,deadline}),String(deadline));
 const{rpc}=await setup(t);
 const zoned=taskInput('create',{...input,deadline:'2026-10-20T15:30:00+07:00'});
 const applied=await rpc('create',zoned);assert.equal(applied.job.deadline,input.deadline);
 assert.deepEqual(taskResult('create',applied,identity,zoned),applied);
 assert.deepEqual(await rpc('create',taskInput('create',{...input,deadline:'2026-10-20T08:30Z'})),applied,'equivalent form replays the same request');
 assert.throws(()=>taskResult('create',{...applied,job:{...applied.job,deadline:'2026-10-20T08:30:00Z'}},identity,{...zoned,deadline:'2026-10-20T08:30:00Z'}),'SQL echo is never canonicalized');
});

test('jobs INSERT/SELECT and profile RLS remain effective even when Action guard and superadmin succeed',{timeout:60000},async t=>{
 const{db,rpc,counts}=await setup(t);
 for(const flag of ['insert_rls','select_rls','profile_rls']) {
  await db.exec(`UPDATE public.fixture_task_acl SET ${flag}=false`);
  await assert.rejects(rpc('create',input),code('42501'));
  assert.deepEqual(await counts(),{jobs:0,receipts:0,audits:0});
  await db.exec(`UPDATE public.fixture_task_acl SET ${flag}=true`);
 }
 await db.exec(`INSERT INTO public.super_admins VALUES('${USER}');UPDATE public.fixture_task_acl SET insert_rls=false`);
 await assert.rejects(rpc('create',input),code('42501'));
 await db.exec('UPDATE public.fixture_task_acl SET insert_rls=true');const applied=await rpc('create',input);
 assert.equal(applied.job.createdBy,USER);assert.equal(applied.job.assigneeId,ASSIGNEE);
 await db.exec('UPDATE public.fixture_task_acl SET select_rls=false');await assert.rejects(rpc('status',{requestId:REQUEST}),code('42501'));
});

test('live Action, scope, session, epoch and membership fences reject before any canonical write',{timeout:60000},async t=>{
 const{db,rpc,counts}=await setup(t);
 for(const role of ['anon','service_role','hermes_store_executor'])await assert.rejects(rpc('create',input,binding,{role}),code('42501'));
 await assert.rejects(rpc('create',input,binding,{actor:FOREIGN}),code('42501'));
 await assert.rejects(rpc('create',input,binding,{session:FOREIGN}),code('42501'));
 for(const key of ['expectedEpoch','expectedPolicyVersion','expectedAuthorizationVersion','expectedSessionRevision'])await assert.rejects(rpc('create',input,{...binding,[key]:2}),code('PT409'));
 const cases=[
  ["UPDATE app_private.hermes_connections SET action_capabilities='{}'","UPDATE app_private.hermes_connections SET action_capabilities=ARRAY['tasks.create']"],
  ["UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability='tasks.create'","UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability='tasks.create'"],
  ['UPDATE public.fixture_task_acl SET allowed=false','UPDATE public.fixture_task_acl SET allowed=true'],
  ["UPDATE public.fixture_task_acl SET deadline=clock_timestamp()-interval '1 second'",'UPDATE public.fixture_task_acl SET deadline=null'],
  [`UPDATE public.authorization_scopes SET building_id='${FOREIGN}'`,`UPDATE public.authorization_scopes SET building_id='${BUILDING}'`],
  [`UPDATE public.organization_memberships SET revoked_at=clock_timestamp() WHERE user_id='${ASSIGNEE}'`,`UPDATE public.organization_memberships SET revoked_at=null WHERE user_id='${ASSIGNEE}'`],
  [`UPDATE public.organization_memberships SET organization_id='${FOREIGN}' WHERE user_id='${ASSIGNEE}'`,`UPDATE public.organization_memberships SET organization_id='${ORG}' WHERE user_id='${ASSIGNEE}'`],
  [`UPDATE public.rooms SET building_id='${FOREIGN}'`,`UPDATE public.rooms SET building_id='${BUILDING}'`],
  [`UPDATE public.job_types SET organization_id='${FOREIGN}'`,`UPDATE public.job_types SET organization_id='${ORG}'`],
  ["UPDATE public.buildings SET deleted_at=clock_timestamp()",'UPDATE public.buildings SET deleted_at=null'],
 ];
 for(const [deny,restore] of cases){await db.exec(deny);await assert.rejects(rpc('create',input),code('42501'));await db.exec(restore);assert.deepEqual(await counts(),{jobs:0,receipts:0,audits:0});}
 await db.exec(`INSERT INTO public.super_admins VALUES('${USER}');UPDATE app_private.hermes_connections SET action_capabilities='{}'`);
 await assert.rejects(rpc('create',input),code('42501'));
});

test('invalid SQL DTOs fail closed and audit/finalize failure rolls back the job and reservation',{timeout:60000},async t=>{
 const{db,rpc,counts}=await setup(t);
 for(const patch of [{actorId:USER},{organizationId:ORG},{status:'COMPLETED'},{priority:'HIGH'},{title:''},{deadline:'2026-02-30T08:00:00.000Z'},{deadline:'2026-10-14T24:00:00.000Z'}])await assert.rejects(rpc('create',{...input,...patch}),code('22023'));
 await assert.rejects(rpc('finalize',input),code('22023'));
 await db.exec(`CREATE FUNCTION public.fixture_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture_audit_failed';END$$;
  CREATE TRIGGER fixture_audit_fail BEFORE INSERT ON public.authorization_audit_events FOR EACH ROW EXECUTE FUNCTION public.fixture_audit_fail();`);
 await assert.rejects(rpc('create',input),/fixture_audit_failed/);assert.deepEqual(await counts(),{jobs:0,receipts:0,audits:0});
 await db.exec(`DROP TRIGGER fixture_audit_fail ON public.authorization_audit_events;
  CREATE FUNCTION public.fixture_job_tamper() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.assignee_id=NULL;RETURN NEW;END$$;
  CREATE TRIGGER fixture_job_tamper BEFORE INSERT ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.fixture_job_tamper();`);
 await assert.rejects(rpc('create',input),code('PT409'));assert.deepEqual(await counts(),{jobs:0,receipts:0,audits:0});
});

test('cross-connection request UUID cannot duplicate; incomplete ledger never resets or opens a blind retry',{timeout:60000},async t=>{
 const{db,rpc,counts}=await setup(t);
 await db.query(`INSERT INTO app_private.hermes_task_create_receipts(organization_id,user_id,request_id,connection_id,input)
  VALUES($1,$2,$3,$4,$5::jsonb)`,[ORG,USER,REQUEST,CONNECTION,JSON.stringify(input)]);
 assert.deepEqual(await rpc('status',{requestId:REQUEST}),{organizationId:ORG,requestId:REQUEST,outcome:'unknown',job:null});
 await assert.rejects(rpc('create',input),code('PT409'));assert.deepEqual(await counts(),{jobs:0,receipts:1,audits:0});
 // A second verified fixture connection for the same actor cannot reuse UUIDs
 // belonging to either an unknown or a completed request on the first one.
 await db.exec(`INSERT INTO app_private.hermes_connections(id,assistant_id,organization_id,user_id,state,credential_ref,intent_digest,intent_expires_at,activation_operation_id,action_capabilities,scope_ids)
  SELECT '${FOREIGN}',assistant_id,organization_id,user_id,'ACTIVE',credential_ref,repeat('c',64),clock_timestamp()+interval '1 minute','${FOREIGN}',action_capabilities,scope_ids
  FROM app_private.hermes_connections WHERE id='${CONNECTION}';
  INSERT INTO app_private.hermes_connection_tokens(token_digest,connection_id,expires_at) VALUES(repeat('e',64),'${FOREIGN}',clock_timestamp()+interval '10 minutes');`);
 const second={...binding,connectionId:FOREIGN,tokenDigest:'e'.repeat(64)};
 await assert.rejects(rpc('create',input,second),code('PT409'));await assert.rejects(rpc('status',{requestId:REQUEST},second),code('PT409'));
 const completed={...input,requestId:id('9')};await rpc('create',completed);
 await assert.rejects(rpc('create',completed,second),code('PT409'));
 assert.deepEqual(await counts(),{jobs:1,receipts:2,audits:1});
});

test('authenticated wrapper resolves prebound helpers without exposing private schema, tables or definer INSERT',{timeout:60000},async t=>{
 const{db,rpc}=await setup(t);
 const functions=(await db.query(`SELECT n.nspname,p.proname,p.prosecdef,p.provolatile FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.proname IN
  ('hermes_task_insert_v1','hermes_task_create_action_v1','hermes_task_guard_v1','hermes_task_finish_v1') ORDER BY p.proname`)).rows;
 assert.equal(functions.length,4);for(const f of functions){assert.equal(f.provolatile,'v');assert.equal(f.prosecdef,!['hermes_task_insert_v1','hermes_task_create_action_v1'].includes(f.proname));}
 const acl=(await db.query(`SELECT has_schema_privilege('authenticated','app_private','USAGE') usage,
  has_table_privilege('authenticated','app_private.hermes_task_create_receipts','SELECT') receipt_read,
  has_table_privilege('authenticated','app_private.hermes_task_create_receipts','INSERT') receipt_write,
  has_function_privilege('service_role','public.hermes_task_create_action_v1(jsonb,text,jsonb)','EXECUTE') service_exec`)).rows[0];
 assert.deepEqual(acl,{usage:false,receipt_read:false,receipt_write:false,service_exec:false});
 const applied=await rpc('create',{...input,roomId:null,assigneeId:null,description:null,deadline:null});assert.equal(applied.job.roomId,null);assert.equal(applied.job.assigneeId,null);assert.equal(applied.job.deadline,null);
});

test('transport sends one fixed user-JWT RPC, tracks acknowledged rejection and never retries ACK loss',async()=>{
 const accessToken=['header',Buffer.from(JSON.stringify({role:'authenticated',sub:USER,session_id:SESSION})).toString('base64url'),'signature'].join('.');
 let calls=0,dispatched=0,rejected=0;
 const options={url:'https://example.invalid/',publishableKey:'sb_publishable_test',dependencyScope:{track:fn=>fn()},fetch:async(url,request)=>{
  calls++;assert.equal(new URL(url).pathname,'/rest/v1/rpc/hermes_task_create_action_v1');assert.equal(request.headers.authorization,'Bearer '+accessToken);
  const body=JSON.parse(request.body);assert.deepEqual(body,{p_binding:binding,p_operation:'create',p_input:input});throw new Error('synthetic_ack_loss');}};
 const value={accessToken,binding,input};const callOptions={signal:new AbortController().signal,onDispatch(){dispatched++;},onRejected(){rejected++;}};
 await assert.rejects(createTaskReads(options).execute('create',value,callOptions),/synthetic_ack_loss/);
 assert.deepEqual({calls,dispatched,rejected},{calls:1,dispatched:1,rejected:0});
 await assert.rejects(createTaskReads({...options,fetch:async()=>Response.json({code:'PT409',message:'changed',details:null,hint:null},{status:409})}).execute('create',value,callOptions),code('context_changed'));
 assert.equal(rejected,1);await assert.rejects(createTaskReads(options).execute('finalize',value,callOptions),code('invalid_request'));
});

test('task service preserves audit seam, rechecks after audit, consumes receipts and dispatches no automatic retry',async()=>{
 const token='hc_'+'x'.repeat(43),tokenDigest=createHash('sha256').update(token).digest('hex'),assistantId=id('5');
 const expiresAt=2_000_000;let now=1_000_000,changed=false,calls=0,dispatched=0;
 const row={id:CONNECTION,assistantId,userId:USER,organizationId:ORG,state:'ACTIVE',epoch:1,expiresAt,credentialRef:SESSION,tokenDigest};
 const accessToken=['header',Buffer.from(JSON.stringify({role:'authenticated',sub:USER,session_id:SESSION})).toString('base64url'),'signature'].join('.');
 const events=[];
 const service=createTaskService({clock:()=>now,supabase:{url:'https://example.invalid/',publishableKey:'sb_publishable_test'},dependencyScope:{track:fn=>fn()},
  authority:{resolve:async()=>({...identity,row,effective:{action:['tasks.create']}}),checkUnchanged:async()=>{events.push('recheck');if(changed)throw Object.assign(new Error('context_changed'),{code:'context_changed'});}},
  connectionStore:{readConnection:async()=>({status:'active',connection:row,session:{credentialRef:SESSION,revision:1,expiresAt,envelope:{},binding:{assistantId,userId:USER,organizationId:ORG,sessionId:SESSION}},membership:{membershipId:USER,authorizationVersion:1},policy:{version:1}})},
  crypto:{open:()=>({accessToken,refreshToken:'synthetic-refresh',expiresAt})},auth:{verifySession:async()=>({userId:USER,sessionId:SESSION,expiresAt})},
  fetch:async(_url,request)=>{calls++;events.push('dispatch');const body=JSON.parse(request.body);
   if(body.p_operation==='create')throw new Error('synthetic_ack_loss');
   assert.equal(body.p_operation,'status');return Response.json({organizationId:ORG,requestId:REQUEST,outcome:'not_found',job:null});}});
 const options={signal:new AbortController().signal,onDispatch(){dispatched++;},onRejected(){assert.fail('ACK loss is not a confirmed rejection');}};
 const first=await service.prepareTask(token,'create',input,options);assert.deepEqual(first,{});assert.equal(calls,0);
 events.push('audit');changed=true;await assert.rejects(service.finalizeTask(token,first,options),code('context_changed'));assert.equal(calls,0);
 changed=false;const expired=await service.prepareTask(token,'create',input,options);now+=30000;
 await assert.rejects(service.finalizeTask(token,expired,options),code('timeout'));assert.equal(calls,0);
 const fresh=await service.prepareTask(token,'create',input,options);events.push('audit');
 await assert.rejects(service.finalizeTask(token,fresh,options),/synthetic_ack_loss/);assert.deepEqual(events.slice(-3),['audit','recheck','dispatch']);
 await assert.rejects(service.finalizeTask(token,fresh,options),code('context_changed'));assert.equal(calls,1);assert.equal(dispatched,1);
 const status=await service.prepareTask(token,'status',{requestId:REQUEST},options);
 assert.equal((await service.finalizeTask(token,status,options)).outcome,'not_found');assert.equal(calls,2);assert.equal(dispatched,1);
});

test('capability adapter binds membership/epoch and cannot convert read permission or a missing optional RPC into Action',async()=>{
 const base={membership:{membershipId:USER,authorizationVersion:1},isSuperadmin:false,permissions:{read:['tasks.view'],action:[]},companyCeilings:{read:['tasks.view'],action:[]},scopesByPermission:{},epoch:'base'};
 const cap={organizationId:ORG,userId:USER,membershipId:USER,authorizationVersion:1,isSuperadmin:false,policyVersion:0,allowed:true,companyEnabled:true,buildingIds:[BUILDING]};
 let value=null;const auth=createTaskAuth({baseAuth:{verifySession:async()=>({}),readAuthorization:async()=>structuredClone(base)},reads:{capabilities:async()=>value}});
 const request={organizationId:ORG,userId:USER,accessToken:'synthetic',signal:new AbortController().signal};
 assert.deepEqual(await auth.readAuthorization(request),base);
 value=cap;const allowed=await auth.readAuthorization(request);assert.deepEqual(allowed.permissions.action,['tasks.create']);assert.notEqual(allowed.epoch,base.epoch);
 value={...cap,allowed:false,buildingIds:[]};const denied=await auth.readAuthorization(request);assert.deepEqual(denied.permissions.action,[]);assert.notEqual(denied.epoch,allowed.epoch);
 for(const patch of [{userId:ASSIGNEE},{organizationId:FOREIGN},{membershipId:ASSIGNEE},{authorizationVersion:2},{allowed:true,companyEnabled:false},{buildingIds:[BUILDING,BUILDING]}]){
  value={...cap,...patch};await assert.rejects(auth.readAuthorization(request),code('context_changed'));
 }
});
