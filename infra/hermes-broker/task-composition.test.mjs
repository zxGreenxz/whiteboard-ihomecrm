import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash,randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setup,BUILDING,REQUEST,input } from './task-fixture.mjs';
import { prepareTaskMetadata,taskMetadataRpc } from './task-input-fixture.mjs';
import { createTaskServiceWithOptions } from './task-input-adapter.mjs';
const forward=readFileSync('supabase/migrations/20261014000503_hermes_optional_org_policy_v1.sql','utf8');
const extract=(src,name)=>src.match(new RegExp('CREATE OR REPLACE FUNCTION '+name.replaceAll('.', '\\.')+'[\\s\\S]*?\\$(?:fn)?\\$;'))[0];
import { USER,ORG,FOREIGN,CONNECTION,SESSION,ASSISTANT,id } from '../hermes-zalo-router/private-command-fixture.mjs';
import { createTaskAuth,createTaskReads } from './task-adapter.mjs';
import { createBroker } from './broker.mjs';
import { createMcpHttpServer } from './mcp-http.mjs';
import { createDurableAuthority } from './durable-authority.mjs';
import { createDurableConnectionStore } from './durable-connection-store.mjs';
import { createSessionCrypto } from './session-crypto.mjs';
import { createDependencyScope } from './dependency-scope.mjs';
const token='hc_'+'A'.repeat(43),digest=createHash('sha256').update(token).digest('hex');
const ACTION='tasks.create';
test('external MCP → bound JWT → audited final caller SQL: task-create action and unknown reconciliation',{timeout:60000},async t=>{
 const {db,rpc,counts}=await setup(t),events=[];
 await prepareTaskMetadata(db,{notifications:true});
 await db.exec(readFileSync(process.env.HERMES_TASK_OPTIONS_SQL??new URL('../../supabase/migrations/20261014094913_hermes_assistant_capabilities_v5.sql',import.meta.url),'utf8'));
 await db.exec(extract(forward,'app_private.hermes_store_read_connection_v1'));
 await db.query('UPDATE app_private.hermes_connection_tokens SET token_digest=$1',[digest]);
 await db.exec("UPDATE app_private.hermes_connections SET read_capabilities='{}';UPDATE app_private.hermes_org_policies SET read_capabilities='{}'");
 const expiresAt=(Math.floor(Date.now()/1000)+3600)*1000;
 const accessToken=['header',Buffer.from(JSON.stringify({role:'authenticated',sub:USER,session_id:SESSION,exp:expiresAt/1000})).toString('base64url'),'signature'].join('.');
 const crypto=createSessionCrypto({activeKeyVersion:'test',keys:new Map([['test',randomBytes(32)]])});t.after(()=>crypto.destroy());
 const envelope=crypto.seal({accessToken,refreshToken:'SYNTHETIC_REFRESH',expiresAt},{assistantId:ASSISTANT,userId:USER,organizationId:ORG,sessionId:SESSION});
 await db.query('UPDATE app_private.hermes_sessions SET envelope=$1::jsonb,expires_at=to_timestamp($2/1000.0)',[JSON.stringify(envelope),expiresAt]);
 const dependencyScope=createDependencyScope();t.after(()=>dependencyScope.close());
 let beforeFinal,loseAck=false,writes=0;
 const transport=async(url,options)=>{
   assert.equal(new URL(url).origin,'https://example.invalid');assert.equal(options.headers.authorization,'Bearer '+accessToken);
   assert.equal(options.headers.apikey,'sb_publishable_test');assert.equal(options.method,'POST');assert.equal(options.redirect,'error');
   const path=new URL(url).pathname,args=JSON.parse(options.body);
   // Follow SQL is a separate migration; its exact PostgREST absence keeps this
   // create-only deployment unchanged (no follow/progress/cancel grant).
   if(path==='/rest/v1/rpc/hermes_task_follow_capabilities_v1'){assert.deepEqual(args,{p_organization_id:ORG});
     return Response.json({code:'PGRST202',message:'Synthetic optional RPC absent',details:null,hint:null},{status:404});}
   const capability=path==='/rest/v1/rpc/hermes_task_create_capabilities_v1',metadata=path==='/rest/v1/rpc/hermes_task_input_options_v1';
   assert.ok(capability||metadata||path==='/rest/v1/rpc/hermes_task_create_action_v1');
   if(capability)assert.deepEqual(args,{p_organization_id:ORG});
   else{assert.deepEqual(Object.keys(args).sort(),metadata?['p_binding','p_input']:['p_binding','p_input','p_operation']);if(beforeFinal){const hook=beforeFinal;beforeFinal=undefined;await hook();}}
   events.push(capability?'capability':`sql:${args.p_operation}`);
   try{
     const result=capability?await rpc('capabilities',{}):metadata?await taskMetadataRpc(db,args.p_binding,args.p_input,{session:SESSION}):await rpc(args.p_operation,args.p_input,args.p_binding);
     if(args.p_operation==='create'){writes++;if(loseAck){loseAck=false;throw new Error('synthetic_ack_lost');}}
     return Response.json(result);
   }catch(error){if(!error.code)throw error;return Response.json({code:error.code,message:error.message,details:null,hint:null},{status:error.code==='42501'?403:error.code==='PT409'?409:400});}
 };
 const supabase={url:'https://example.invalid/',publishableKey:'sb_publishable_test'};
 const baseAuth={async verifySession({accessToken:provided}){assert.equal(provided,accessToken);events.push('synthetic-auth');return{userId:USER,sessionId:SESSION,expiresAt};},async readAuthorization(){return{
   userId:USER,isSuperadmin:false,activeOrganizationIds:[ORG],epoch:'base',membership:{organizationId:ORG,status:'ACTIVE',revokedAt:null,validFrom:null,validTo:null,membershipId:USER,authorizationVersion:1},
   permissions:{read:[],action:[]},companyCeilings:{read:[],action:[]},scopesByPermission:{}};}};
 const auth=createTaskAuth({baseAuth,reads:createTaskReads({...supabase,fetch:transport,dependencyScope})});
 const connectionStore=createDurableConnectionStore({transport:{async call(operation,payload){assert.equal(operation,'readConnection');await db.exec('BEGIN;SET LOCAL ROLE hermes_store_executor');
    await db.query("SELECT set_config('request.jwt.claim.role','hermes_store_executor',true)");
    try{const value=(await db.query('SELECT app_private.hermes_store_read_connection_v1($1::jsonb) result',[JSON.stringify(payload)])).rows[0].result;await db.exec('COMMIT');return value;}
    catch(error){await db.exec('ROLLBACK');throw error;}finally{await db.exec('RESET ROLE');}}}});
 const authority=createDurableAuthority({connectionStore,crypto,auth});
 const tasks=createTaskServiceWithOptions({authority,connectionStore,crypto,auth,supabase,dependencyScope,fetch:transport});
 let afterAudit;
 const broker=createBroker({authority,tasks,dependencyScope,audit:async entry=>{events.push(`audit:${entry.outcome}`);if(afterAudit&&entry.outcome==='prepared'){const hook=afterAudit;afterAudit=undefined;await hook();}}});
 const server=createMcpHttpServer({broker,allowedHosts:['127.0.0.1'],allowedOrigins:[]});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 let requestId=0;
 const call=async(name,args={})=>{
   const response=await fetch(`http://127.0.0.1:${server.address().port}/mcp`,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++requestId,method:'tools/call',params:{name,arguments:args}})});
   assert.equal(response.status,200);const message=await response.json();return{...message.result,value:JSON.parse(message.result.content[0].text)};
 };
 const listed=await broker.listTools(token);assert.deepEqual(listed.tools.map(tool=>tool.name).sort(),['crm_task_create','crm_task_input_options','crm_task_status']);
 const options=(kind,buildingId=null)=>call('crm_task_input_options',{kind,buildingId,query:'',limit:20,cursor:null});
 assert.deepEqual((await options('buildings')).value.items,[{id:BUILDING,label:'Nhà A'}]);
 assert.equal((await options('rooms',BUILDING)).value.items[0].id,input.roomId);
 assert.equal((await options('jobTypes',BUILDING)).value.items[0].id,input.jobTypeId);
 assert.ok((await options('assignees',BUILDING)).value.items.some(row=>row.id===input.assigneeId));
 assert.equal((await call('crm_read_tasks',{})).value.error,'tool_not_available');
 assert.equal((await call('crm_read_customers',{})).value.error,'tool_not_available');
 assert.equal(writes,0);assert.deepEqual(await counts(),{jobs:0,receipts:0,audits:0});
 events.length=0;loseAck=true;
 const unknown=await call('crm_task_create',input);
 assert.deepEqual(unknown.value,{error:'task_outcome_unknown',requestId:REQUEST});assert.equal(unknown.isError,true);assert.equal(writes,1);
 assert.ok(events.indexOf('audit:prepared')<events.indexOf('sql:create'));
 assert.equal(events.filter(event=>event==='sql:create').length,1,'ACK loss is never retried');
 const status=await call('crm_task_status',{requestId:REQUEST});assert.equal(status.value.outcome,'applied');assert.equal(status.value.job.createdBy,USER);assert.equal(status.value.job.assigneeId,input.assigneeId);assert.equal(writes,1);
 assert.deepEqual(await counts(),{jobs:1,receipts:1,audits:1});
 assert.deepEqual((await call('crm_task_status',{requestId:id('9')})).value,{organizationId:ORG,requestId:id('9'),outcome:'not_found',job:null});
 assert.equal((await call('crm_task_create',{...input,title:'Changed intent'})).value.error,'context_changed');assert.equal(writes,1);
 for(const extra of [{userId:FOREIGN},{organizationId:FOREIGN},{rpc:'arbitrary'}])assert.equal((await call('crm_task_create',{...input,...extra})).value.error,'invalid_request');
 afterAudit=()=>db.exec('UPDATE public.fixture_task_acl SET allowed=false');
 const denied=await call('crm_task_status',{requestId:REQUEST});assert.equal(denied.value.error,'context_changed');
 assert.deepEqual((await broker.listTools(token)).tools,[]);
 await db.exec('UPDATE public.fixture_task_acl SET allowed=true');
 beforeFinal=()=>db.exec("UPDATE app_private.hermes_connections SET action_capabilities='{}'");
 assert.equal((await call('crm_task_create',{...input,requestId:id('8')})).value.error,'forbidden');
 assert.equal(writes,1);assert.deepEqual(await counts(),{jobs:1,receipts:1,audits:1});
 const notices=(await db.query("SELECT user_id,metadata,push_state FROM public.notifications WHERE metadata->>'event'='E4'")).rows;
 assert.equal(notices.length,1);assert.equal(notices[0].user_id,input.assigneeId);assert.equal(notices[0].metadata.actor_id,USER);assert.equal(notices[0].push_state,'QUEUED');
 assert.equal(JSON.stringify(unknown).includes(accessToken),false);assert.equal(JSON.stringify(unknown).includes('SYNTHETIC_REFRESH'),false);
});
