import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { saleBulkInput, mayUseSaleBulk } from './sale-bulk-contract.mjs';
import { createSaleBulkService } from './sale-bulk-adapter.mjs';
import { salePolicyInput, salePolicyResult, mayUseSalePolicy } from './sale-policy-contract.mjs';
import { mayUseSaleAction, saleActionResult } from './sale-action-contract.mjs';
import { createSalePolicyAuth, createSalePolicyReads } from './sale-policy-adapter.mjs';
import { createPublicTextGuard } from './public-text-guard.mjs';
import { createBroker } from './broker.mjs';
import { createDependencyScope } from './dependency-scope.mjs';
const org=randomUUID(),building=randomUUID(),room=randomUUID(),user=randomUUID();
const one=()=>({requestId:randomUUID(),roomId:randomUUID(),expectedRevision:'a'.repeat(32),sale_note:'Miễn phí wifi'});
const bulk=()=>({requestId:randomUUID(),items:[one(),one(),one()]});
const save=()=>({requestId:randomUUID(),roomId:room,expectedRevision:'a'.repeat(32),title:'Ưu đãi tháng 11',content:'Miễn phí wifi',startsAt:'2026-11-01T00:00:00+07:00',endsAt:'2026-12-01T00:00:00+07:00'});
const policy={id:randomUUID(),version:1,title:'Ưu đãi tháng 11',content:'Miễn phí wifi',startsAt:'2026-11-01T00:00:00+07:00',endsAt:'2026-12-01T00:00:00+07:00',status:'SCHEDULED'};
const identity=action=>({row:{organizationId:org,userId:user},effective:{action},scopesByPermission:Object.fromEntries(action.map(k=>[k,{buildingIds:[building]}]))});
test('bulk manifest enforces count, byte budget, unique item keys and exact patches before any write',()=>{
 assert.equal(saleBulkInput('patch',bulk()).items.length,3);
 for(const mutate of [x=>x.items=[],x=>x.items=Array.from({length:11},one),x=>x.items[1].roomId=x.items[0].roomId,
  x=>x.items[1].requestId=x.items[0].requestId,x=>x.items[0].requestId=x.requestId,x=>x.items[0].status='AVAILABLE',
  x=>x.items=Array.from({length:10},()=>({...one(),sale_note:'đ'.repeat(2000)}))]){
  const input=bulk();mutate(input);assert.throws(()=>saleBulkInput('patch',input));
 }
});
test('bulk preview binds every item, price, request key and revision while hiding internal note',()=>{
 const guard=createPublicTextGuard({clock:()=>1}),input=bulk();input.items[0].sale_bonus_note='Nội bộ 500k';
 const preview=guard.review('connection','crm_sale_bulk_patch',input).confirmation;
 assert.equal(preview.applied,false);assert.equal(preview.preview.items.length,3);assert(!JSON.stringify(preview.preview).includes('500k'));
 const changed=structuredClone(input);changed.items[1].rent_price=1;
 assert.deepEqual(guard.review('connection','crm_sale_bulk_patch',changed,preview.confirmToken),{refused:true});
 const second=guard.review('connection','crm_sale_bulk_patch',input).confirmation;
 assert.deepEqual(guard.review('connection','crm_sale_bulk_patch',input,second.confirmToken),{allow:true});
});
test('policy direct save validates time window and exact public preview has no approval state',()=>{
 const input=save();assert.deepEqual(salePolicyInput('save',input),input);
 for(const extra of [{approved:true},{startsAt:input.endsAt},{endsAt:'2026-10-01T00:00:00Z'},{title:''},{content:'x'.repeat(2001)}])assert.throws(()=>salePolicyInput('save',{...input,...extra}));
 const guard=createPublicTextGuard({clock:()=>100});const preview=guard.review('c','crm_sale_policy_save',input).confirmation;
 assert.deepEqual(preview.preview,{title:input.title,content:input.content});
 assert.deepEqual(guard.review('c','crm_sale_policy_save',{...input,endsAt:'2026-12-02T00:00:00Z'},preview.confirmToken),{refused:true});
 assert.throws(()=>salePolicyInput('approve',{requestId:randomUUID()}));
});
test('policy receipts must confirm the exact canonical content/window or cancelled next version',()=>{
 const input=save(),who=identity(['sale_phong.edit']);
 const result={organizationId:org,requestId:input.requestId,operation:'save',outcome:'applied',receipt:{roomId:room,buildingId:building,revision:'b'.repeat(32),policy}};
 const equivalent={...result,receipt:{...result.receipt,policy:{...policy,startsAt:new Date(input.startsAt).toISOString(),endsAt:new Date(input.endsAt).toISOString()}}};
 assert.equal(salePolicyResult('save',equivalent,who,{...input,title:' '+input.title+' ',content:' '+input.content+' '}).outcome,'applied');
 for(const changed of [{title:'Nội dung khác'},{content:'Thông tin khác'},{startsAt:'2026-11-02T00:00:00+07:00'},
  {endsAt:'2026-12-02T00:00:00+07:00'},{version:2},{status:'CANCELLED'}])
  assert.throws(()=>salePolicyResult('save',{...result,receipt:{...result.receipt,policy:{...policy,...changed}}},who,input));
 const cancel={requestId:randomUUID(),policyId:policy.id,expectedVersion:1,reason:'Dừng chương trình'};
 const stopped={...result,requestId:cancel.requestId,operation:'cancel',receipt:{...result.receipt,policy:{...policy,version:2,status:'CANCELLED'}}};
 assert.equal(salePolicyResult('cancel',stopped,who,cancel).outcome,'applied');
 for(const changed of [{id:randomUUID()},{version:1},{version:3},{status:'ACTIVE'}])
  assert.throws(()=>salePolicyResult('cancel',{...stopped,receipt:{...stopped.receipt,policy:{...stopped.receipt.policy,...changed}}},who,cancel));
});
for(const role of ['Chủ công ty','Chủ trọ','Quản lý','Sale Admin','Sale'])test(`${role}: explicit Sale edit permits metadata/policy only in its building and implies no finance`,()=>{
 const who=identity(['sale_phong.edit']),input=save();
 assert(mayUseSaleBulk(who.effective,'patch',bulk()));assert(mayUseSalePolicy(who.effective));
 assert(mayUseSaleAction(who.effective,'patch',one()));assert(!mayUseSaleAction(who.effective,'reservation_create'));
 const result={organizationId:org,requestId:input.requestId,operation:'save',outcome:'applied',receipt:{roomId:room,buildingId:building,revision:'b'.repeat(32),policy}};
 assert.equal(salePolicyResult('save',result,who,input).receipt.policy.status,'SCHEDULED');
 assert.throws(()=>salePolicyResult('save',{...result,receipt:{...result.receipt,buildingId:randomUUID()}},who,input));
 assert.throws(()=>salePolicyResult('save',result,identity(['sale_phong.manage_images']),input));
 assert.equal(mayUseSalePolicy({action:[]}),false);
 const observed={organizationId:org,room:{id:room,buildingId:building,revision:'a'.repeat(32),updatedAt:null,fields:{sale_bonus_note:'nội bộ'}}};
 assert.equal(saleActionResult('observe',observed,who,{roomId:room}).room.fields.sale_bonus_note,'nội bộ');
 assert.throws(()=>saleActionResult('observe',observed,{...who,scopesByPermission:{'sale_phong.edit':{buildingIds:[]}}},{roomId:room}));
});
function bulkFixture(behaviors){
 const calls=[],who=identity(['sale_phong.edit']),prepared=new WeakMap();
 const authority={resolve:async()=>who,checkUnchanged:async()=>{}};
 const saleActions={async prepareSaleAction(token,op,input){calls.push({kind:'prepare',op,input});const r=Object.freeze({});prepared.set(r,{op,input});return r;},
  async finalizeSaleAction(token,r,options){const {op,input}=prepared.get(r);const n=calls.filter(c=>c.kind==='write').length;calls.push({kind:'write',op,input});
   const mode=behaviors[n]??'applied';if(op!=='status')options.onDispatch();
   if(mode==='lost'){throw Error('network secret');}if(mode==='conflict'){options.onRejected();throw Object.assign(Error(),{code:'context_changed'});}
   if(mode==='denied'){options.onRejected();throw Object.assign(Error(),{code:'forbidden'});}
   return{organizationId:org,requestId:input.requestId,operation:'patch',outcome:'applied',receipt:{roomId:input.roomId,buildingId:building}};
  }};
 return{calls,service:createSaleBulkService({authority,saleActions})};
}
test('bulk preserves per-item partial outcomes with fresh full service admission for every attempted write',async()=>{
 const f=bulkFixture(['applied','conflict','applied']),input=bulk(),options={signal:new AbortController().signal};
 const prepared=await f.service.prepareSaleBulk('token','patch',input,options);const result=await f.service.finalizeSaleBulk('token',prepared,options);
 assert.equal(result.outcome,'partial');assert.deepEqual(result.items.map(x=>x.outcome),['applied','conflict','applied']);
 assert.deepEqual(f.calls.map(x=>x.kind),['prepare','write','prepare','write','prepare','write']);
 assert.deepEqual(f.calls.filter(x=>x.kind==='write').map(x=>x.input.requestId),input.items.map(x=>x.requestId));
});
test('bulk lost ACK stops later rooms and carries exact request IDs for reconciliation without retry',async()=>{
 const f=bulkFixture(['applied','lost']),input=bulk(),options={signal:new AbortController().signal};
 const result=await f.service.finalizeSaleBulk('token',await f.service.prepareSaleBulk('token','patch',input,options),options);
 assert.equal(result.outcome,'unknown');assert.deepEqual(result.items.map(x=>x.outcome),['applied','unknown','not_attempted']);
 assert.equal(f.calls.filter(x=>x.kind==='write').length,2);assert.equal(result.items[1].requestId,input.items[1].requestId);
 assert(!JSON.stringify(result).includes('network secret'));
});
test('bulk status denial or changed context preserves unknown and stops further reconciliation',async()=>{
 for(const mode of ['denied','conflict']){
  const f=bulkFixture([mode]),input=bulk();input.items=input.items.map(({requestId,roomId})=>({requestId,roomId}));
  const options={signal:new AbortController().signal};
  const result=await f.service.finalizeSaleBulk('token',await f.service.prepareSaleBulk('token','status',input,options),options);
  assert.equal(result.outcome,'unknown');assert.deepEqual(result.items.map(x=>x.outcome),['unknown','not_attempted','not_attempted']);
  assert.equal(result.items[0].code,'sale_outcome_unknown');assert.equal(f.calls.filter(x=>x.kind==='write').length,1);
 }
});
test('policy capability absence never grants edit, and malformed scopes never extend authority',async()=>{
 const base={userId:user,isSuperadmin:false,epoch:'base',membership:{membershipId:user,authorizationVersion:1},permissions:{read:[],action:[]},companyCeilings:{read:[],action:[]},scopesByPermission:{}};
 let cap=null;const auth=createSalePolicyAuth({baseAuth:{verifySession:async()=>{},readAuthorization:async()=>base},reads:{capabilities:async()=>cap}});
 const input={userId:user,organizationId:org,signal:new AbortController().signal};assert.deepEqual(await auth.readAuthorization(input),base);
 cap={organizationId:org,userId:user,membershipId:user,authorizationVersion:1,isSuperadmin:false,policyVersion:1,permissions:{'sale_phong.edit':{allowed:true,companyEnabled:true,buildingIds:[building]}}};
 assert.deepEqual((await auth.readAuthorization(input)).permissions.action,['sale_phong.edit']);
 cap.permissions['sale_phong.edit'].companyEnabled=false;await assert.rejects(()=>auth.readAuthorization(input),e=>e.code==='context_changed');
});
test('policy transport uses only bound caller JWT and does not retry a lost write acknowledgement',async()=>{
 let count=0,dispatch=0;const accessToken=['header',Buffer.from(JSON.stringify({role:'authenticated',sub:user,session_id:user})).toString('base64url'),'signature'].join('.');
 const binding={connectionId:user,tokenDigest:'a'.repeat(64),expectedEpoch:1,expectedPolicyVersion:1,expectedMembershipId:user,expectedAuthorizationVersion:1,expectedSessionRevision:1};
 const reads=createSalePolicyReads({url:'https://example.invalid/',publishableKey:'sb_publishable_test',dependencyScope:{track:f=>f()},fetch:async(url,options)=>{
  count++;assert.equal(url,'https://example.invalid/rest/v1/rpc/hermes_sale_policy_actions_v1');assert.equal(options.headers.authorization,'Bearer '+accessToken);throw Error('lost');
 }});
 await assert.rejects(()=>reads.execute('save',{accessToken,binding,input:save()},{signal:new AbortController().signal,onDispatch:()=>dispatch++,onRejected:()=>{}}),/lost/);
 assert.equal(count,1);assert.equal(dispatch,1);
});
test('broker mounts direct policy and bulk tools and enforces preview before any trusted write port',async t=>{
 const dependencyScope=createDependencyScope();t.after(()=>dependencyScope.close());const token='hc_'+'A'.repeat(43),connection=randomUUID();
 const who={...identity(['sale_phong.edit']),row:{id:connection,assistantId:randomUUID(),organizationId:org,userId:user,state:'active',epoch:1,
  expiresAt:Date.now()+3600000,restrictions:{read:[],action:['sale_phong.edit']}},policyEpoch:'a'.repeat(64),contextVersion:'b'.repeat(64),assistantScopeIds:[randomUUID()],isSuperadmin:false};
 who.effective.read=[];who.scopesByPermission['sale_phong.edit'].cashbookIds=[];const calls=[];const port=kind=>({async prepare(token,op,input){calls.push({kind,op,input});return Object.freeze({});},async finalize(token,receipt,{onDispatch}){onDispatch();return{outcome:'applied'};}});
 const policyPort=port('policy'),bulkPort=port('bulk'),logs=[];
 const broker=createBroker({dependencyScope,audit:async()=>{},callLog:event=>logs.push(event),authority:{identifyConnection:async()=>({connectionId:connection}),resolve:async()=>who,checkUnchanged:async()=>{}},
  salePolicies:{prepareSalePolicy:policyPort.prepare,finalizeSalePolicy:policyPort.finalize},saleBulk:{prepareSaleBulk:bulkPort.prepare,finalizeSaleBulk:bulkPort.finalize}});
 const call=(name,input)=>broker.callTool(token,'crm_sale_action',{operation:name.slice('crm_sale_'.length),input});
 for(const [name,input] of [['crm_sale_policy_save',save()],['crm_sale_bulk_patch',bulk()]]){
  const before=calls.length,result=await call(name,input),preview=JSON.parse(result.content[0].text);
  assert.equal(preview.outcome,'confirmation_required');assert.equal(calls.length,before);
  assert.equal(preview.tool,'crm_sale_action');assert.equal(preview.operation,name.slice('crm_sale_'.length));
  await call(name,{...input,confirmToken:preview.confirmToken});assert.equal(calls.length,before+1);
  assert(!Object.hasOwn(calls.at(-1).input,'confirmToken'));
  assert(logs.some(event=>event.operation==='tools/call'&&event.tool==='crm_sale_action'),'mounted tools retain their names in the timing journal');
 }
 // Read-only policy observe follows the shared advertised-schema shaping, including the documented snake_case alias.
 await call('crm_sale_policy_observe',{room_id:room});
 assert.equal(calls.at(-1).op,'observe');assert.deepEqual(calls.at(-1).input,{roomId:room});
 const names=(await broker.listTools(token)).tools.map(tool=>tool.name);assert(names.includes('crm_sale_action'));
 const operations=JSON.parse((await broker.callTool(token,'crm_sale_action',{operation:'list'})).content[0].text).operations;
 assert(operations.some(item=>item.operation==='policy_cancel'));assert(operations.some(item=>item.operation==='bulk_status'));
 assert(!operations.some(item=>item.operation.includes('policy_approve')||item.operation.includes('policy_request')));
});
