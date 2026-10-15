import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash,randomBytes } from 'node:crypto';
import { setup,BUILDING,LISTING,SCOPE,REQUEST,extract,forward } from './room-pass-sql-fixture.mjs';
import { USER,ORG,FOREIGN,CONNECTION,SESSION,ASSISTANT,id } from '../hermes-zalo-router/private-command-fixture.mjs';
import { createRoomPassAuth,createRoomPassReads,createRoomPassService } from './room-pass-adapter.mjs';
import { createBroker } from './broker.mjs';
import { createMcpHttpServer } from './mcp-http.mjs';
import { createDurableAuthority } from './durable-authority.mjs';
import { createDurableConnectionStore } from './durable-connection-store.mjs';
import { createSessionCrypto } from './session-crypto.mjs';
import { createDependencyScope } from './dependency-scope.mjs';
const token='hc_'+'A'.repeat(43),digest=createHash('sha256').update(token).digest('hex');
const ACTION='sale_phong.manage_pass_listings';
test('external MCP → bound JWT → audited final caller SQL: room-pass action and unknown reconciliation',{timeout:60000},async t=>{
 const {f,db,rpc}=await setup(t),events=[];
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
   // This fixture holds only the applied v1 SQL: the upsert RPC is absent
   // (PGRST202), so status must fall back to the v1 receipt reader.
   if(path==='/rest/v1/rpc/hermes_room_pass_upsert_v1'){assert.equal(args.p_operation,'status');events.push('absent:status');
     return Response.json({code:'PGRST202',message:'Could not find the function',details:null,hint:null},{status:404});}
   const capability=path==='/rest/v1/rpc/hermes_room_pass_capabilities_v1';
   assert.ok(capability||path==='/rest/v1/rpc/hermes_room_pass_action_v1');
   if(capability)assert.deepEqual(args,{p_organization_id:ORG});
   else{assert.deepEqual(Object.keys(args).sort(),['p_binding','p_input','p_operation']);if(beforeFinal){const hook=beforeFinal;beforeFinal=undefined;await hook();}}
   events.push(capability?'capability':`sql:${args.p_operation}`);
   try{
     const result=capability?await rpc('capabilities',{}):await rpc(args.p_operation,args.p_input,args.p_binding);
     if(args.p_operation==='set_active'){writes++;if(loseAck){loseAck=false;throw new Error('synthetic_ack_lost');}}
     return Response.json(result);
   }catch(error){if(!error.code)throw error;return Response.json({code:error.code,message:error.message,details:null,hint:null},{status:error.code==='42501'?403:error.code==='PT409'?409:400});}
 };
 const supabase={url:'https://example.invalid/',publishableKey:'sb_publishable_test'};
 const baseAuth={async verifySession({accessToken:provided}){assert.equal(provided,accessToken);events.push('synthetic-auth');return{userId:USER,sessionId:SESSION,expiresAt};},async readAuthorization(){return{
   userId:USER,isSuperadmin:false,activeOrganizationIds:[ORG],epoch:'base',membership:{organizationId:ORG,status:'ACTIVE',revokedAt:null,validFrom:null,validTo:null,membershipId:USER,authorizationVersion:1},
   permissions:{read:[],action:[]},companyCeilings:{read:[],action:[]},scopesByPermission:{}};}};
 const auth=createRoomPassAuth({baseAuth,reads:createRoomPassReads({...supabase,fetch:transport,dependencyScope})});
 const connectionStore=createDurableConnectionStore({transport:{async call(operation,payload){assert.equal(operation,'readConnection');return f.rpc('app_private.hermes_store_read_connection_v1',payload);}}});
 const authority=createDurableAuthority({connectionStore,crypto,auth});
 const roomPass=createRoomPassService({authority,connectionStore,crypto,auth,supabase,dependencyScope,fetch:transport});
 let afterAudit;
 const broker=createBroker({authority,roomPass,dependencyScope,audit:async entry=>{events.push(`audit:${entry.outcome}`);if(afterAudit&&entry.outcome==='prepared'){const hook=afterAudit;afterAudit=undefined;await hook();}}});
 const server=createMcpHttpServer({broker,allowedHosts:['127.0.0.1'],allowedOrigins:[]});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 let requestId=0;
 const call=async(name,args={})=>{
   const response=await fetch(`http://127.0.0.1:${server.address().port}/mcp`,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++requestId,method:'tools/call',params:{name,arguments:args}})});
   assert.equal(response.status,200);const message=await response.json();return{...message.result,value:JSON.parse(message.result.content[0].text)};
 };
 const listed=await broker.listTools(token);assert.deepEqual(listed.tools.map(tool=>tool.name).sort(),['crm_new_request_id','crm_room_lookup','crm_room_pass_observe','crm_room_pass_set_active','crm_room_pass_status','crm_room_pass_upsert']);
 const observed=await call('crm_room_pass_observe',{listingId:LISTING});assert.equal(observed.isError,false);assert.equal(observed.value.listing.active,false);
 const input={requestId:REQUEST,listingId:LISTING,active:true,expectedRevision:observed.value.listing.revision};
 events.length=0;loseAck=true;
 const unknown=await call('crm_room_pass_set_active',input);
 assert.deepEqual(unknown.value,{error:'room_pass_outcome_unknown',requestId:REQUEST});assert.equal(unknown.isError,true);assert.equal(writes,1);
 assert.ok(events.indexOf('audit:prepared')<events.indexOf('sql:set_active'));
 assert.equal(events.filter(event=>event==='sql:set_active').length,1,'ACK loss is never retried');
 const status=await call('crm_room_pass_status',{requestId:REQUEST});assert.equal(status.value.outcome,'applied');assert.equal(status.value.listing.active,true);assert.equal(writes,1);
 assert.equal((await db.query('SELECT count(*)::integer n FROM public.fixture_action_audit')).rows[0].n,1);
 assert.deepEqual((await call('crm_room_pass_status',{requestId:id('9')})).value,{requestId:id('9'),outcome:'not_found',listing:null});
 assert.equal((await call('crm_room_pass_set_active',{...input,requestId:id('8')})).value.error,'context_changed');assert.equal(writes,1);
 for(const extra of [{userId:FOREIGN},{organizationId:FOREIGN},{rpc:'arbitrary'}])assert.equal((await call('crm_room_pass_observe',{listingId:LISTING,...extra})).value.error,'invalid_request');
 afterAudit=()=>db.exec("UPDATE public.fixture_action_acl SET allowed=false");
 const denied=await call('crm_room_pass_observe',{listingId:LISTING});assert.equal(denied.value.error,'context_changed');
 assert.deepEqual((await broker.listTools(token)).tools,[]);
 await db.exec('UPDATE public.fixture_action_acl SET allowed=true');
 beforeFinal=()=>db.exec("UPDATE app_private.hermes_connections SET action_capabilities='{}'");
 assert.equal((await call('crm_room_pass_observe',{listingId:LISTING})).value.error,'forbidden');
 assert.equal(writes,1);assert.equal((await db.query('SELECT active FROM public.room_pass_listings')).rows[0].active,true);
 assert.equal(JSON.stringify(unknown).includes(accessToken),false);assert.equal(JSON.stringify(unknown).includes('SYNTHETIC_REFRESH'),false);
});
