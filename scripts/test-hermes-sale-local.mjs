import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {seedSaleReservationFixture} from './sale-reservation-local-fixture.mjs';
import {saleQuickClient} from './sale-quick-local-fixture.mjs';

// Disposable loopback DB only, real application auth and canonical writers.
// A synthetic platform session/claims replaces no application authorization.
const f=await seedSaleReservationFixture(),admin=await saleQuickClient(),clients=new Map(),bindings={};
const results=[];
const actions=['rooms.edit','sale_phong.manage_images','sale_phong.lock_room','deposits.create','deposits.edit','income_expenses.create','income_expenses.approve'];
async function check(id,request,fn){
 try{const detail=await fn();results.push({id,request,status:'passed',detail});}
 catch(error){results.push({id,request,status:'failed',error:{code:error.code??null,message:error.message}});throw error;}
}
try{
 const roleBody=(await admin.query("SELECT prosrc FROM pg_proc WHERE oid='auth.role()'::regprocedure")).rows[0].prosrc.trim();
 if(/^SELECT NULL::text$/i.test(roleBody))await admin.query(`CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
  $$SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.role',true),''),auth.jwt()->>'role')$$`);
 const scope=(await admin.query("SELECT id FROM public.authorization_scopes WHERE organization_id=$1 AND scope_type='BUILDING' AND building_id=$2",[f.org,f.buildings[0]])).rows[0].id;
 await admin.query('BEGIN');await admin.query('SET LOCAL session_replication_role=replica');
 await admin.query('UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability=ANY($1::text[])',[actions]);
 await admin.query(`INSERT INTO app_private.hermes_org_policies(organization_id,enabled,version,action_capabilities,scope_ids,updated_by)
  VALUES($1,true,1,$2,$3,$4)`,[f.org,actions,[scope],f.actors.landlord]);
 for(const role of ['manager','saleAdmin','sale']){
  const user=f.actors[role],assistant=randomUUID(),session=randomUUID(),provider=randomUUID(),connection=randomUUID();
  const digest=createHash('sha256').update(randomUUID()).digest('hex');
  await admin.query('INSERT INTO app_private.hermes_assistants(id,organization_id,user_id) VALUES($1,$2,$3)',[assistant,f.org,user]);
  await admin.query(`INSERT INTO app_private.hermes_sessions(id,assistant_id,organization_id,user_id,provider_session_id,state,envelope,expires_at)
   VALUES($1,$2,$3,$4,$5,'ACTIVE','{"synthetic_local":true}',now()+interval '1 hour')`,[session,assistant,f.org,user,provider]);
  await admin.query(`INSERT INTO app_private.hermes_connections(id,assistant_id,organization_id,user_id,state,action_capabilities,scope_ids,
   credential_ref,intent_digest,intent_expires_at,activation_operation_id)
   VALUES($1,$2,$3,$4,'ACTIVE',$5,$6,$7,$8,now()+interval '1 hour',$9)`,
  [connection,assistant,f.org,user,actions,[scope],session,digest,randomUUID()]);
  await admin.query("INSERT INTO app_private.hermes_connection_tokens(token_digest,connection_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[digest,connection]);
  bindings[role]={connectionId:connection,tokenDigest:digest,expectedEpoch:1,expectedPolicyVersion:1,
   expectedMembershipId:f.memberships[role],expectedAuthorizationVersion:1,expectedSessionRevision:1};
  bindings[role].provider=provider;
 }
 await admin.query('COMMIT');
 for(const role of Object.keys(bindings)){
  const db=await saleQuickClient(f.actors[role]);clients.set(role,db);
  await db.query("SELECT set_config('request.jwt.claims',$1,false),set_config('request.jwt.claim.role','authenticated',false)",[
   JSON.stringify({sub:f.actors[role],role:'authenticated',session_id:bindings[role].provider})]);
  const ctx=(await db.query('SELECT public.get_authorization_context_v1($1) context',[f.org])).rows[0].context;
  bindings[role].expectedAuthorizationVersion=ctx.authorizationVersion;
 }
 const rpc=async(role,operation,input,override={})=>{
  const {provider,...binding}=bindings[role];
  return(await clients.get(role).query('SELECT public.hermes_sale_actions_v1($1,$2,$3) result',[{...binding,...override},operation,input])).rows[0].result;
 };
 const observe=async role=>(await rpc(role,'observe',{roomId:f.rooms[0]})).room;
 let patched,lock,deposit,topup;
 await check('HP01','Quản lý đọc phiên bản phòng và sửa giá bằng writer CRM thật',async()=>{
  const room=await observe('manager');patched={requestId:randomUUID(),roomId:room.id,expectedRevision:room.revision,rent_price:3100000};
  const result=await rpc('manager','patch',patched);
  assert.equal(result.receipt.state,'UPDATED');assert.equal((await admin.query('SELECT rent_price::int price FROM public.rooms WHERE id=$1',[room.id])).rows[0].price,3100000);
  return{outcome:result.outcome};
 });
 await check('HP02','Mất phản hồi sau ghi: đối soát và thử lại giữ đúng requestId',async()=>{
  const status=await rpc('manager','status',{requestId:patched.requestId});
  assert.deepEqual(await rpc('manager','patch',patched),status);
  assert.equal((await admin.query('SELECT count(*)::int n FROM app_private.sale_room_change_receipts WHERE request_id=$1',[patched.requestId])).rows[0].n,1);
 });
 await check('HP03','Giá cũ phải bị từ chối sau một cập nhật khác',async()=>{
  await assert.rejects(()=>rpc('manager','patch',{...patched,requestId:randomUUID(),rent_price:3200000}),e=>e.code==='PT409');
 });
 await check('HP04','Sale Admin chỉ sửa ảnh: không được xem thưởng nội bộ hay đổi giá',async()=>{
  const room=await observe('saleAdmin');assert.deepEqual(Object.keys(room.fields),['images']);
  const input={requestId:randomUUID(),roomId:room.id,expectedRevision:room.revision,images:['https://example.invalid/local-room.jpg']};
  assert.equal((await rpc('saleAdmin','patch',input)).outcome,'applied');
  await assert.rejects(()=>rpc('saleAdmin','patch',{...input,requestId:randomUUID(),rent_price:1}),e=>e.code==='42501');
 });
 await check('HP05','Sale lock tạm 6 giờ: một lock, không tạo phiếu thu',async()=>{
  const input={requestId:randomUUID(),roomId:f.extraRooms[0],hours:6,note:'Khách xem local'};
  lock=await rpc('sale','lock',input);assert.equal(lock.receipt.state,'LOCKED');
  assert.deepEqual(await rpc('sale','lock',input),lock);
  assert.equal((await admin.query('SELECT count(*)::int n FROM public.room_sale_locks WHERE room_id=$1',[f.extraRooms[0]])).rows[0].n,1);
 });
 await check('HP06','Sale gỡ chính lock của mình đúng ID',async()=>{
  assert.equal((await rpc('sale','release',{requestId:randomUUID(),lockId:lock.receipt.id})).receipt.state,'RELEASED');
 });
 await check('HP07','Sale báo cọc bằng tên gợi nhớ qua phiếu thu CRM thật',async()=>{
  const input={requestId:randomUUID(),roomId:f.extraRooms[1],customerId:null,customerHint:'Khách Hermes local',intendedMoveInOn:null,
   topupDueOn:f.topup,depositTarget:3000000,notes:null,
   receipt:{amount:1000000,accountId:f.account,voucherDate:f.today,name:null,description:null}};
  deposit=await rpc('sale','reservation_create',input);assert.equal(deposit.receipt.state,'HOLD');
  const canonical=(await clients.get('sale').query('SELECT public.list_room_reservations_v1($1,$2,null,null,100) result',[f.org,f.extraRooms[1]])).rows[0].result.reservations[0];
  assert.equal(deposit.receipt.receivedAmount,canonical.received_amount);
  assert.equal(deposit.receipt.receipts[0].received,canonical.receipts[0].received);
  assert.equal(deposit.receipt.receipts[0].approvalStatus,canonical.receipts[0].approval_status);
  return{approvalStatus:deposit.receipt.receipts[0].approvalStatus,received:deposit.receipt.receipts[0].received,receivedAmount:deposit.receipt.receivedAmount};
 });
 await check('HP08','Sale thu thêm vào đúng hồ sơ cọc qua TOPUP thật',async()=>{
  topup=await rpc('sale','reservation_topup',{requestId:randomUUID(),reservationId:deposit.receipt.id,expectedRevision:deposit.receipt.revision,
   receipt:{amount:500000,accountId:f.account,voucherDate:f.today,name:null,description:null}});
  assert.ok(topup.receipt.revision>deposit.receipt.revision);assert.equal(topup.receipt.id,deposit.receipt.id);
 });
 await check('HP09','Quản lý gắn khách danh bạ và sửa hạn cọc theo revision',async()=>{
  const assigned=await rpc('manager','reservation_assign',{requestId:randomUUID(),reservationId:deposit.receipt.id,expectedRevision:topup.receipt.revision,customerId:f.customer});
  const updated=await rpc('manager','reservation_update',{requestId:randomUUID(),reservationId:deposit.receipt.id,expectedRevision:assigned.receipt.revision,
   changes:{topup_due_on:f.deadline,notes:'Đã hẹn thu thêm'}});
  assert.ok(updated.receipt.revision>assigned.receipt.revision);
 });
 await check('HP10','Sale bị chặn phòng tòa ngoài scope và phòng công ty khác',async()=>{
  for(const roomId of [f.rooms[2],f.rooms[3]])await assert.rejects(()=>rpc('sale','lock',{requestId:randomUUID(),roomId,hours:6,note:null}),e=>e.code==='42501');
 });
 await check('HP11','Phiên binding sai không ghi được',async()=>{
  await assert.rejects(()=>rpc('manager','observe',{roomId:f.rooms[0]},{expectedSessionRevision:2}),e=>e.code==='PT409');
 });
 await check('HP12','Thu hồi action khỏi kết nối: biên nhận cũ không bỏ qua quyền',async()=>{
  await admin.query("UPDATE app_private.hermes_connections SET action_capabilities=array_remove(action_capabilities,'rooms.edit') WHERE id=$1",[bindings.manager.connectionId]);
  await assert.rejects(()=>rpc('manager','status',{requestId:patched.requestId}),e=>['42501','PT409'].includes(e.code));
 });
 console.log(JSON.stringify({tests:results.length,passed:results.filter(r=>r.status==='passed').length,results},null,2));
}finally{
 writeFileSync(new URL('../docs/plans/sale-phong-actions-20261021/hermes-local-postgres-results.json',import.meta.url),
  JSON.stringify({layer:'Actual PostgreSQL canonical writers and application auth, synthetic platform claims, loopback only',results},null,2)+'\n');
 for(const db of clients.values())await db.end();await admin.end();
}
