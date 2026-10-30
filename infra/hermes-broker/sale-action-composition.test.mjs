import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash,randomBytes } from 'node:crypto';
import { saleSetup,ROOM,REQUEST,ORG,USER } from './sale-action-sql-fixture.mjs';
import { extract,forward } from './room-pass-sql-fixture.mjs';
import { SESSION,ASSISTANT,id } from '../hermes-zalo-router/private-command-fixture.mjs';
import { createSaleActionAuth,createSaleActionReads,createSaleActionService } from './sale-action-adapter.mjs';
import { createBroker } from './broker.mjs';
import { createDurableAuthority } from './durable-authority.mjs';
import { createDurableConnectionStore } from './durable-connection-store.mjs';
import { createSessionCrypto } from './session-crypto.mjs';
import { createDependencyScope } from './dependency-scope.mjs';
test('sale composition full authority → public preview → bound JWT → durable SQL receipt → unknown reconciliation',{timeout:60000},async t=>{
 const {f,db,rpc}=await saleSetup(t),token='hc_'+'A'.repeat(43),digest=createHash('sha256').update(token).digest('hex');
 await db.exec(extract(forward,'app_private.hermes_store_read_connection_v1'));
 await db.query('UPDATE app_private.hermes_connection_tokens SET token_digest=$1',[digest]);
 await db.exec("UPDATE app_private.hermes_connections SET read_capabilities='{}';UPDATE app_private.hermes_org_policies SET read_capabilities='{}'");
 const expiresAt=(Math.floor(Date.now()/1000)+3600)*1000;
 const accessToken=['header',Buffer.from(JSON.stringify({role:'authenticated',sub:USER,session_id:SESSION,exp:expiresAt/1000})).toString('base64url'),'signature'].join('.');
 const crypto=createSessionCrypto({activeKeyVersion:'test',keys:new Map([['test',randomBytes(32)]])});t.after(()=>crypto.destroy());
 const envelope=crypto.seal({accessToken,refreshToken:'SYNTHETIC_REFRESH',expiresAt},{assistantId:ASSISTANT,userId:USER,organizationId:ORG,sessionId:SESSION});
 await db.query('UPDATE app_private.hermes_sessions SET envelope=$1::jsonb,expires_at=to_timestamp($2/1000.0)',[JSON.stringify(envelope),expiresAt]);
 const dependencyScope=createDependencyScope();t.after(()=>dependencyScope.close());
 let loseAck=false,writes=0,afterAudit;const events=[];
 const transport=async(url,options)=>{
  assert.equal(options.headers.authorization,'Bearer '+accessToken);
  const args=JSON.parse(options.body),capability=new URL(url).pathname.endsWith('/hermes_sale_capabilities_v1');
  assert.ok(capability||new URL(url).pathname.endsWith('/hermes_sale_actions_v1'));
  try {
   const result=await rpc(capability?'capabilities':args.p_operation,capability?{}:args.p_input,args.p_binding);
   if(args.p_operation==='patch'){events.push('sql:patch');writes++;if(loseAck){loseAck=false;throw new Error('lost_ACK');}}
   return Response.json(result);
  } catch(error){if(!error.code)throw error;return Response.json({code:error.code,message:error.message,details:null,hint:null},
   {status:error.code==='42501'?403:error.code==='PT409'?409:400});}
 };
 const supabase={url:'https://example.invalid/',publishableKey:'sb_publishable_test'};
 const baseAuth={async verifySession({accessToken:provided}){assert.equal(provided,accessToken);return{userId:USER,sessionId:SESSION,expiresAt};},
  async readAuthorization(){return{userId:USER,isSuperadmin:false,activeOrganizationIds:[ORG],epoch:'base',
   membership:{organizationId:ORG,status:'ACTIVE',revokedAt:null,validFrom:null,validTo:null,membershipId:USER,authorizationVersion:1},
   permissions:{read:[],action:[]},companyCeilings:{read:[],action:[]},scopesByPermission:{}};}};
 const auth=createSaleActionAuth({baseAuth,reads:createSaleActionReads({...supabase,fetch:transport,dependencyScope})});
 const connectionStore=createDurableConnectionStore({transport:{async call(operation,payload){
  assert.equal(operation,'readConnection');return f.rpc('app_private.hermes_store_read_connection_v1',payload);}}});
 const authority=createDurableAuthority({connectionStore,crypto,auth});
 const saleActions=createSaleActionService({authority,connectionStore,crypto,auth,supabase,dependencyScope,fetch:transport});
 const broker=createBroker({authority,saleActions,dependencyScope,audit:async entry=>{
  events.push('audit:'+entry.outcome);if(afterAudit&&entry.outcome==='prepared'){const hook=afterAudit;afterAudit=undefined;await hook();}}});
 const call=async(name,args)=>{const result=await broker.callTool(token,'crm_sale_action',{operation:name.slice('crm_sale_'.length),input:args});return JSON.parse(result.content[0].text);};
 const listed=await broker.listTools(token);assert.ok(listed.tools.some(tool=>tool.name==='crm_sale_action'));
 const operations=JSON.parse((await broker.callTool(token,'crm_sale_action',{operation:'list'})).content[0].text).operations;
 assert.ok(operations.some(item=>item.operation==='room_patch'));
 assert.ok(!operations.some(item=>item.operation==='reservation_create'),'receipt create also requires income_expenses.create and deposits.create_receipt');
 const input={requestId:REQUEST,roomId:ROOM,expectedRevision:'a'.repeat(32),sale_note:'Wifi miễn phí'};
 const preview=await call('crm_sale_room_patch',input);
 assert.equal(preview.outcome,'confirmation_required');assert.equal(writes,0);
 events.length=0;loseAck=true;
 await assert.rejects(()=>call('crm_sale_room_patch',{...input,confirmToken:preview.confirmToken}),e=>e.code==='sale_outcome_unknown'&&e.requestId===REQUEST);
 assert.equal(writes,1);assert.ok(events.indexOf('audit:prepared')<events.indexOf('sql:patch'));
 const status=await call('crm_sale_action_status',{requestId:REQUEST});
 assert.equal(status.outcome,'applied');assert.deepEqual(status.receipt.fields,['sale_note']);assert.equal(writes,1);
 afterAudit=()=>db.exec("UPDATE public.fixture_sale_acl SET allowed=false WHERE key='rooms.edit'");
 await assert.rejects(()=>call('crm_sale_room_patch',{requestId:id('9'),roomId:ROOM,expectedRevision:'a'.repeat(32),rent_price:3100000}),e=>e.code==='context_changed');
 assert.equal(writes,1);
 assert.equal(JSON.stringify(status).includes(accessToken),false);
});
