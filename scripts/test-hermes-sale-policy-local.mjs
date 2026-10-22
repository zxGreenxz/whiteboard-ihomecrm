import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { seedSaleQuickFixture, saleQuickClient } from './sale-quick-local-fixture.mjs';
import { createSaleBulkService } from '../infra/hermes-broker/sale-bulk-adapter.mjs';
import { saleActionInput, saleActionResult } from '../infra/hermes-broker/sale-action-contract.mjs';
import { salePolicyResult } from '../infra/hermes-broker/sale-policy-contract.mjs';
const f=await seedSaleQuickFixture(),admin=await saleQuickClient(),clients=new Map(),bindings={},results=[];
const roles=['company','landlord','manager','saleAdmin','sale'],actions=['sale_phong.edit'];
async function check(id,request,fn){try{const detail=await fn();results.push({id,request,status:'passed',detail});}catch(error){results.push({id,request,status:'failed',error:{code:error.code??null,message:error.message}});throw error;}}
try{
 await admin.query('BEGIN');await admin.query('SET LOCAL session_replication_role=replica');
 await admin.query("UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability='sale_phong.edit'");
 const scope=(await admin.query("SELECT id FROM public.authorization_scopes WHERE organization_id=$1 AND scope_type='BUILDING' AND building_id=$2",[f.org,f.buildings[0]])).rows[0].id;
 await admin.query(`INSERT INTO app_private.hermes_org_policies(organization_id,enabled,version,action_capabilities,scope_ids,updated_by) VALUES($1,true,1,$2,$3,$4)`,[f.org,actions,[scope],f.actors.company]);
 for(const role of roles){
  // Explicit per-fixture CRM grant; default-role migration is tested separately.
  await admin.query("INSERT INTO public.role_permissions(organization_id,role_id,permission_key) VALUES($1,$2,'sale_phong.edit') ON CONFLICT DO NOTHING",[f.org,f.roles[role]]);
  const user=f.actors[role],assistant=randomUUID(),session=randomUUID(),provider=randomUUID(),connection=randomUUID(),digest=createHash('sha256').update(randomUUID()).digest('hex');
  await admin.query('INSERT INTO app_private.hermes_assistants(id,organization_id,user_id) VALUES($1,$2,$3)',[assistant,f.org,user]);
  await admin.query(`INSERT INTO app_private.hermes_sessions(id,assistant_id,organization_id,user_id,provider_session_id,state,envelope,expires_at) VALUES($1,$2,$3,$4,$5,'ACTIVE','{"synthetic_local":true}',now()+interval '1 hour')`,[session,assistant,f.org,user,provider]);
  await admin.query(`INSERT INTO app_private.hermes_connections(id,assistant_id,organization_id,user_id,state,action_capabilities,scope_ids,credential_ref,intent_digest,intent_expires_at,activation_operation_id)
   VALUES($1,$2,$3,$4,'ACTIVE',$5,$6,$7,$8,now()+interval '1 hour',$9)`,[connection,assistant,f.org,user,actions,[scope],session,digest,randomUUID()]);
  await admin.query("INSERT INTO app_private.hermes_connection_tokens(token_digest,connection_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[digest,connection]);
  bindings[role]={connectionId:connection,tokenDigest:digest,expectedEpoch:1,expectedPolicyVersion:1,expectedMembershipId:f.memberships[role],expectedAuthorizationVersion:1,expectedSessionRevision:1,provider};
 }
 await admin.query('COMMIT');
 for(const role of roles){
  const db=await saleQuickClient(f.actors[role]);clients.set(role,db);
  await db.query("SELECT set_config('request.jwt.claims',$1,false),set_config('request.jwt.claim.role','authenticated',false)",[JSON.stringify({sub:f.actors[role],role:'authenticated',session_id:bindings[role].provider})]);
  const ctx=(await db.query('SELECT public.get_authorization_context_v1($1) context',[f.org])).rows[0].context;
  bindings[role].expectedAuthorizationVersion=ctx.authorizationVersion;
 }
 const rpc=async(role,operation,input,endpoint='hermes_sale_policy_actions_v1',override={})=>{
  assert(['hermes_sale_policy_actions_v1','hermes_sale_actions_v1'].includes(endpoint));
  const {provider,...binding}=bindings[role];return(await clients.get(role).query(`SELECT public.${endpoint}($1,$2,$3) result`,[{...binding,...override},operation,input])).rows[0].result;
 };
 const observe=role=>rpc(role,'observe',{roomId:f.rooms[0]});
 let latest;
 for(const [index,role] of roles.entries())await check(`HB${String(index+1).padStart(2,'0')}`,`${role}: sửa thông tin và tạo/dừng chính sách trực tiếp bằng quyền Sale edit`,async()=>{
  let room=(await observe(role)).room;
  const patch={requestId:randomUUID(),roomId:room.roomId,expectedRevision:room.revision,rent_price:3200000+index,sale_bonus_note:'Nội bộ local'};
  const patched=await rpc(role,'patch',patch,'hermes_sale_actions_v1');assert.equal(patched.outcome,'applied');
  const legacyObserve=await rpc(role,'observe',{roomId:room.roomId},'hermes_sale_actions_v1');assert.equal(legacyObserve.room.fields.sale_bonus_note,'Nội bộ local');
  room=(await observe(role)).room;
  const input={requestId:randomUUID(),roomId:room.roomId,expectedRevision:room.revision,title:'Ưu đãi local',content:'Wifi miễn phí',
   startsAt:new Date(Date.now()-1000).toISOString(),endsAt:new Date(Date.now()+86400000).toISOString()};
  const identity={row:{organizationId:f.org},effective:{action:actions},scopesByPermission:{'sale_phong.edit':{buildingIds:[f.buildings[0]]}}};
  const saved=salePolicyResult('save',await rpc(role,'save',input),identity,input);assert.equal(saved.receipt.policy.status,'ACTIVE');
  assert.deepEqual(await rpc(role,'status',{requestId:input.requestId}),saved);assert.deepEqual(await rpc(role,'save',input),saved);
  await assert.rejects(()=>rpc(role,'save',{...input,requestId:randomUUID()}),e=>e.code==='PT409');
  room=(await observe(role)).room;assert.equal(room.policy.id,saved.receipt.policy.id);
  await assert.rejects(()=>rpc(role,'save',{...input,requestId:randomUUID(),expectedRevision:room.revision}),e=>['PT409','23505','23P01'].includes(e.code));
  const cancel={requestId:randomUUID(),policyId:saved.receipt.policy.id,expectedVersion:saved.receipt.policy.version,reason:'Kết thúc chương trình thử'};
  const cancelled=salePolicyResult('cancel',await rpc(role,'cancel',cancel),identity,cancel);assert.equal(cancelled.receipt.policy.status,'CANCELLED');
  assert.deepEqual(await rpc(role,'cancel',cancel),cancelled);
  assert.notEqual(saved.receipt.revision,cancelled.receipt.revision);
  latest={role,input,cancel};return{status:saved.receipt.policy.status,cancelled:cancelled.receipt.policy.status};
 });
 await check('HB06','Ngoài tòa/kết nối và công ty khác đều bị chặn trước khi ghi',async()=>{
  for(const role of roles)for(const roomId of [f.rooms[2],f.rooms[3]])await assert.rejects(()=>rpc(role,'observe',{roomId}),e=>e.code==='42501');
 });
 await check('HB07','Thay nội dung trên requestId cũ hoặc sai session revision không được ghi',async()=>{
  await assert.rejects(()=>rpc(latest.role,'save',{...latest.input,content:'Đổi ý định'}),e=>e.code==='PT409');
  await assert.rejects(()=>rpc(latest.role,'observe',{roomId:f.rooms[0]},'hermes_sale_policy_actions_v1',{expectedSessionRevision:2}),e=>e.code==='PT409');
 });
 await check('HB08','Quyền Sale edit không mở công cụ ghi cọc hoặc bỏ qua money overlay',async()=>{
  await assert.rejects(()=>rpc('sale','reservation_create',{requestId:randomUUID(),roomId:f.rooms[0]},'hermes_sale_actions_v1'),e=>e.code==='42501');
 });
 await check('HB09','Thu hồi phạm vi/kết nối chặn cả đối soát biên nhận chính sách cũ',async()=>{
  await admin.query("UPDATE app_private.hermes_connections SET action_capabilities='{}' WHERE id=$1",[bindings[latest.role].connectionId]);
  await assert.rejects(()=>rpc(latest.role,'status',{requestId:latest.input.requestId}),e=>['42501','PT409'].includes(e.code));
 });
 const managerIdentity={row:{organizationId:f.org,userId:f.actors.manager},effective:{action:['sale_phong.edit']},
  scopesByPermission:{'sale_phong.edit':{buildingIds:[f.buildings[0]]}}};
 let loseAck=null,dispatches=0,bridgeFailure=null;const preparedInputs=new WeakMap();
 const bulkService=createSaleBulkService({authority:{resolve:async()=>managerIdentity,checkUnchanged:async()=>{}},saleActions:{
  async prepareSaleAction(token,operation,input){const receipt=Object.freeze({});preparedInputs.set(receipt,{operation,input:saleActionInput(operation,input)});return receipt;},
  async finalizeSaleAction(token,receipt,{onDispatch,onRejected}){
   const {operation,input}=preparedInputs.get(receipt);onDispatch();dispatches++;
   let raw;try{raw=await rpc('manager',operation,input,'hermes_sale_actions_v1');}catch(error){
    bridgeFailure={code:error.code,message:error.message};if(['PT409','42501','22023'].includes(error.code)){onRejected();throw Object.assign(new Error('bounded SQL rejection'),{code:{PT409:'context_changed','42501':'forbidden','22023':'invalid_request'}[error.code]});}throw error;
   }
   if(input.requestId===loseAck)throw new Error('synthetic lost ACK after actual commit');
   try{return saleActionResult(operation,raw,managerIdentity,input);}catch(error){bridgeFailure={code:error.code,message:error.message,raw};throw error;}
  },
 }});
 const patchItem=async(roomId,stale=false)=>({requestId:randomUUID(),roomId,expectedRevision:stale?'0'.repeat(32):
  (await admin.query('SELECT md5(to_jsonb(r)::text) revision FROM public.rooms r WHERE id=$1',[roomId])).rows[0].revision,rent_price:3300000});
 const bulkCall=async input=>{const options={signal:new AbortController().signal};return bulkService.finalizeSaleBulk('synthetic-local-bulk',
  await bulkService.prepareSaleBulk('synthetic-local-bulk','patch',input,options),options);};
 await check('HB10','Bulk orchestration qua SQL thật: phòng1 ghi, phòng2 CAS cũ, phòng3 ngoài quyền',async()=>{
  const input={requestId:randomUUID(),items:[await patchItem(f.rooms[0]),await patchItem(f.rooms[1],true),await patchItem(f.rooms[2])]};
  const result=await bulkCall(input);assert.deepEqual(result.items.map(x=>x.outcome),['applied','conflict','denied'],JSON.stringify(bridgeFailure));assert.equal(result.outcome,'partial');
  assert.equal((await admin.query('SELECT count(*)::int n FROM app_private.hermes_sale_action_receipts WHERE request_id=ANY($1::uuid[])',[input.items.map(x=>x.requestId)])).rows[0].n,1);
 });
 await check('HB11','Bulk mất ACK sau commit thật dừng phòng sau và đối soát bằng mã từng phòng',async()=>{
  const input={requestId:randomUUID(),items:[await patchItem(f.rooms[0]),await patchItem(f.rooms[1]),await patchItem(f.rooms[2])]};
  loseAck=input.items[1].requestId;const before=dispatches,result=await bulkCall(input);
  assert.deepEqual(result.items.map(x=>x.outcome),['applied','unknown','not_attempted']);assert.equal(dispatches-before,2);
  assert.equal((await rpc('manager','status',{requestId:loseAck},'hermes_sale_actions_v1')).outcome,'applied');
  assert.equal((await admin.query('SELECT count(*)::int n FROM app_private.hermes_sale_action_receipts WHERE request_id=ANY($1::uuid[])',[input.items.map(x=>x.requestId)])).rows[0].n,2);
 });
 await check('HB12','Biên nhận patch cũ dạng object được đối soát/replay an toàn sau kiểm quyền, không ghi lần hai',async()=>{
  const input=await patchItem(f.rooms[0]),first=await rpc('manager','patch',input,'hermes_sale_actions_v1');
  assert.deepEqual(first.receipt.fields,['rent_price']);
  await admin.query("UPDATE app_private.hermes_sale_action_receipts SET result=jsonb_set(result,'{receipt,fields}',$2) WHERE request_id=$1",[input.requestId,{rent_price:input.rent_price}]);
  const status=await rpc('manager','status',{requestId:input.requestId},'hermes_sale_actions_v1');
  assert.deepEqual(saleActionResult('status',status,managerIdentity,{requestId:input.requestId}),first);
  assert.deepEqual(saleActionResult('patch',await rpc('manager','patch',input,'hermes_sale_actions_v1'),managerIdentity,input),first);
  await admin.query("UPDATE app_private.hermes_sale_action_receipts SET result=jsonb_set(result,'{receipt,fields}',$2) WHERE request_id=$1",[input.requestId,{rent_price:input.rent_price+1}]);
  await assert.rejects(()=>rpc('manager','status',{requestId:input.requestId},'hermes_sale_actions_v1'),e=>e.code==='PT409');
 });
 console.log(JSON.stringify({tests:results.length,passed:results.filter(x=>x.status==='passed').length,results},null,2));
}finally{
 writeFileSync(new URL('../test-results/sale-quick-local/hermes-bulk-policy-postgres.json',import.meta.url),JSON.stringify({layer:'Actual local PostgreSQL canonical writers and CRM auth; synthetic platform session; no HTTP/LLM claim',results},null,2)+'\n');
 for(const db of clients.values())await db.end();await admin.end();
}
