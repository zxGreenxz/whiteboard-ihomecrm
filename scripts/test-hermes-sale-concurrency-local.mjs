import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {seedSaleReservationFixture} from './sale-reservation-local-fixture.mjs';
import {saleQuickClient} from './sale-quick-local-fixture.mjs';

// Loopback guard lives in the fixture. Only new synthetic organizations/actors.
// Real application writers/auth; no HTTP JWT/PostgREST or model interpretation.
const f=await seedSaleReservationFixture(),admin=await saleQuickClient(),clients=[],bindings={},hermes={};
const results=[];
const actions=['rooms.edit','sale_phong.manage_images','sale_phong.lock_room','deposits.create','deposits.edit','income_expenses.create','income_expenses.approve'];
async function client(actor){
 const db=await saleQuickClient(actor);clients.push(db);return db;
}
async function check(id,request,expected,fn){
 try{const detail=await fn();results.push({id,request,expected,status:'passed',detail});console.log(`PASS ${id} ${request}`);}
 catch(error){results.push({id,request,expected,status:'failed',error:{code:error.code??null,message:error.message}});console.log(`FAIL ${id}: ${error.message}`);}
}
async function waitForBlock(waiting,blocker){
 for(let attempt=0;attempt<150;attempt++){
  const row=(await admin.query('SELECT pg_blocking_pids($1) blockers',[waiting.processID])).rows[0];
  if(row.blockers.includes(blocker.processID))return {waitingPid:waiting.processID,blockerPid:blocker.processID};
  await new Promise(resolve=>setTimeout(resolve,20));
 }
 assert.fail('Second operation never waited on the first real database session.');
}
// Record rejection immediately to avoid unhandled promises. Commit the winner
// only after PostgreSQL confirms that the second transaction is blocked by it.
async function serialize(first,firstRun,second,secondRun){
 await first.query('BEGIN');let pending;
 try{
  const before=await firstRun();
  pending=secondRun().then(value=>({value}),error=>({error}));
  const handshake=await waitForBlock(second,first);
  await first.query('COMMIT');
  return {before,after:await pending,handshake};
 }finally{
  await first.query('ROLLBACK');
  if(pending)await pending;
 }
}
const value=result=>{if(result.error)throw result.error;return result.value;};
const receipt=amount=>({amount,account_id:f.account,voucher_date:f.today,attachments:[]});
const agentReceipt=amount=>({amount,accountId:f.account,voucherDate:f.today,name:null,description:null});
const agentCreate=(roomId,requestId=randomUUID())=>({requestId,roomId,customerId:f.customer,customerHint:null,
 intendedMoveInOn:null,topupDueOn:f.topup,depositTarget:3000000,notes:null,receipt:agentReceipt(1000000)});
const webCreate=(db,roomId)=>
 db.query('SELECT public.create_room_reservation_v1($1,$2,$3) result',[f.org,`web-race-${randomUUID()}`,
  {room_id:roomId,customer_id:f.customer,hold_until:f.deadline,topup_due_on:f.topup,deposit_target:3000000,receipt:receipt(1000000)}])
 .then(r=>r.rows[0].result);
async function rpc(role,operation,input){
 return(await hermes[role].query('SELECT public.hermes_sale_actions_v1($1,$2,$3) result',[bindings[role],operation,input])).rows[0].result;
}
async function revision(roomId){return(await rpc('manager','observe',{roomId})).room.revision;}
async function state(roomId){
 return(await admin.query(`SELECT
  (SELECT count(*)::int FROM room_next_claims WHERE room_id=$1 AND status='LIVE') claims,
  (SELECT count(*)::int FROM room_sale_locks WHERE room_id=$1 AND released_at IS NULL) locks,
  (SELECT count(*)::int FROM income_expenses WHERE room_id=$1 AND deleted_at IS NULL) vouchers,
  (SELECT rent_price::int FROM rooms WHERE id=$1) price`,[roomId])).rows[0];
}
try{
 const roleBody=(await admin.query("SELECT prosrc FROM pg_proc WHERE oid='auth.role()'::regprocedure")).rows[0].prosrc.trim();
 if(/^SELECT NULL::text$/i.test(roleBody))await admin.query(`CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
  $$SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.role',true),''),auth.jwt()->>'role')$$`);
 const scope=(await admin.query("SELECT id FROM authorization_scopes WHERE organization_id=$1 AND scope_type='BUILDING' AND building_id=$2",[f.org,f.buildings[0]])).rows[0].id;
 const providers={};
 await admin.query('BEGIN');
 try{
  await admin.query('SET LOCAL session_replication_role=replica');
  await admin.query('UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability=ANY($1::text[])',[actions]);
  await admin.query(`INSERT INTO app_private.hermes_org_policies(organization_id,enabled,version,action_capabilities,scope_ids,updated_by)
   VALUES($1,true,1,$2,$3,$4)`,[f.org,actions,[scope],f.actors.landlord]);
  for(const role of ['manager','sale']){
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
   providers[role]=provider;
  }
  await admin.query('COMMIT');
 }catch(error){await admin.query('ROLLBACK');throw error;}
 for(const role of Object.keys(bindings)){
  const db=await client(f.actors[role]);hermes[role]=db;
  await db.query("SELECT set_config('request.jwt.claims',$1,false),set_config('request.jwt.claim.role','authenticated',false)",[
   JSON.stringify({sub:f.actors[role],role:'authenticated',session_id:providers[role]})]);
  bindings[role].expectedAuthorizationVersion=(await db.query('SELECT public.get_authorization_context_v1($1) context',[f.org])).rows[0].context.authorizationVersion;
 }
 const webSale=await client(f.actors.sale),webManager=await client(f.actors.manager);
 const rooms=[f.rooms[0],...f.extraRooms];
 await check('HC01','Sale trên web lock phòng; đồng thời Hermes báo cọc cùng phòng',
  'Cọc tiếp quản lock sau khi giao dịch web hoàn tất; đúng một cọc, không còn lock hoạt động.',async()=>{
   const input=agentCreate(rooms[0]);
   const race=await serialize(webSale,()=>webSale.query('SELECT lock_room_for_sale_v1($1,$2,6,$3) result',[f.org,rooms[0],'Web first']).then(r=>r.rows[0].result),
    hermes.sale,()=>rpc('sale','reservation_create',input));
   const held=value(race.after);assert.equal(held.receipt.state,'HOLD');
   assert.deepEqual(await state(rooms[0]),{claims:1,locks:0,vouchers:1,price:3000000});
   const closed=(await admin.query('SELECT release_reason,reservation_id FROM room_sale_locks WHERE id=$1',[race.before.id])).rows[0];
   assert.deepEqual(closed,{release_reason:'RESERVED',reservation_id:held.receipt.id});
   return {...race.handshake,reservationId:held.receipt.id,lockId:race.before.id};
  });
 await check('HC02','Sale trên web tạo cọc; đồng thời Hermes lock cùng phòng',
  'Cọc web thành công; Hermes nhận lỗi 55000, không tạo lock hay biên nhận giả.',async()=>{
   const input={requestId:randomUUID(),roomId:rooms[1],hours:6,note:null};
   const race=await serialize(webSale,()=>webCreate(webSale,rooms[1]),hermes.sale,()=>rpc('sale','lock',input));
   assert.equal(race.after.error?.code,'55000');
   assert.deepEqual(await state(rooms[1]),{claims:1,locks:0,vouchers:1,price:3000000});
   assert.equal((await admin.query('SELECT count(*)::int n FROM app_private.hermes_sale_action_receipts WHERE request_id=$1',[input.requestId])).rows[0].n,0);
   return {...race.handshake,rejectedCode:race.after.error.code};
  });
 await check('HC03','Quản lý sửa giá trên web và Hermes từ cùng phiên bản',
  'Web ghi trước; Hermes nhận PT409, giá web còn nguyên và chỉ có một biên nhận sửa phòng.',async()=>{
   const before=await revision(rooms[2]),webId=randomUUID(),agentId=randomUUID();
   const race=await serialize(webManager,()=>webManager.query('SELECT update_room_sale_info_v1($1,$2,$3,$4,$5) result',
    [f.org,rooms[2],before,webId,{rent_price:3300000}]),hermes.manager,
    ()=>rpc('manager','patch',{requestId:agentId,roomId:rooms[2],expectedRevision:before,rent_price:3400000}));
   assert.equal(race.after.error?.code,'PT409');assert.equal((await state(rooms[2])).price,3300000);
   const counts=(await admin.query(`SELECT
    (SELECT count(*)::int FROM app_private.sale_room_change_receipts WHERE request_id=ANY($1::uuid[])) writes,
    (SELECT count(*)::int FROM app_private.hermes_sale_action_receipts WHERE request_id=$2) hermes`,[[webId,agentId],agentId])).rows[0];
   assert.deepEqual(counts,{writes:1,hermes:0});
   return {...race.handshake,rejectedCode:race.after.error.code};
  });
 await check('HC04','Quản lý sửa thông tin trên web; Sale đồng thời báo cọc qua Hermes',
  'Hai thao tác hợp lệ cùng hoàn tất sau khi nối tiếp khóa phòng; thông tin mới và cọc đều được giữ.',async()=>{
   const before=await revision(rooms[3]);
   const race=await serialize(webManager,()=>webManager.query('SELECT update_room_sale_info_v1($1,$2,$3,$4,$5) result',
    [f.org,rooms[3],before,randomUUID(),{rent_price:3500000,sale_note:'Chính sách thử local'}]),
    hermes.sale,()=>rpc('sale','reservation_create',agentCreate(rooms[3])));
   assert.equal(value(race.after).receipt.state,'HOLD');
   assert.deepEqual(await state(rooms[3]),{claims:1,locks:0,vouchers:1,price:3500000});
   assert.equal((await admin.query('SELECT sale_note FROM rooms WHERE id=$1',[rooms[3]])).rows[0].sale_note,'Chính sách thử local');
   return race.handshake;
  });
 await check('HC05','Sale web và Hermes cùng bổ sung cọc từ một revision hồ sơ',
  'Một phiếu bổ sung; yêu cầu thứ hai PT409, không thêm tiền hoặc phiếu khi revision đã đổi.',async()=>{
   const held=await webCreate(webSale,rooms[4]),agentId=randomUUID();
   const race=await serialize(webSale,()=>webSale.query("SELECT update_room_reservation_v1($1,$2,$3,$4,'TOPUP','{}',$5) result",
    [f.org,held.id,held.revision,`web-topup-${randomUUID()}`,receipt(500000)]),hermes.sale,
    ()=>rpc('sale','reservation_topup',{requestId:agentId,reservationId:held.id,expectedRevision:held.revision,receipt:agentReceipt(600000)}));
   assert.equal(race.after.error?.code,'PT409');
   const actual=(await admin.query(`SELECT
    (SELECT revision::int FROM room_reservations WHERE id=$1) revision,
    count(DISTINCT rr.source_voucher_id)::int vouchers,sum(i.amount)::bigint amount
    FROM reservation_receipts rr JOIN income_expense_items i ON i.id=rr.source_item_id WHERE rr.reservation_id=$1`,[held.id])).rows[0];
   assert.deepEqual(actual,{revision:held.revision+1,vouchers:2,amount:'1500000'});
   assert.equal((await admin.query('SELECT count(*)::int n FROM app_private.hermes_sale_action_receipts WHERE request_id=$1',[agentId])).rows[0].n,0);
   return {...race.handshake,rejectedCode:race.after.error.code,sourceVoucherCount:actual.vouchers};
  });
 await check('HC06','Thu hồi kết nối khi thao tác Hermes đang đợi khóa phòng',
  'Hàm thu hồi canonical hoàn tất trước admission; Hermes bị từ chối, giá và biên nhận không đổi.',async()=>{
   const before=await revision(rooms[5]),requestId=randomUUID();let pending;
   await webManager.query('BEGIN');
   try{
    await webManager.query('SELECT id FROM rooms WHERE id=$1 FOR NO KEY UPDATE',[rooms[5]]);
    pending=rpc('manager','patch',{requestId,roomId:rooms[5],expectedRevision:before,rent_price:3900000})
     .then(value=>({value}),error=>({error}));
    const handshake=await waitForBlock(hermes.manager,webManager);
    const revoked=(await admin.query('SELECT app_private.hermes_store_revoke_connection_v1($1) result',
     [{connectionId:bindings.manager.connectionId,expectedEpoch:bindings.manager.expectedEpoch}])).rows[0].result;
    assert.deepEqual(revoked,{ok:true,status:'revoked'});
    await webManager.query('COMMIT');
    const outcome=await pending;assert.ok(['42501','PT409','40001'].includes(outcome.error?.code));
    assert.equal((await state(rooms[5])).price,3000000);
    assert.equal((await admin.query('SELECT count(*)::int n FROM app_private.hermes_sale_action_receipts WHERE request_id=$1',[requestId])).rows[0].n,0);
    return {...handshake,rejectedCode:outcome.error.code,revocation:revoked.status};
   }finally{await webManager.query('ROLLBACK');if(pending)await pending;}
  });
}finally{
 writeFileSync(new URL('../docs/plans/sale-phong-actions-20261021/hermes-concurrency-postgres-results.json',import.meta.url),
  JSON.stringify({layer:'Actual local PostgreSQL, two concurrent authenticated sessions; canonical web/Hermes writers; synthetic claims; no HTTP/provider/model evaluation',fixtureOrganization:f.org,results},null,2)+'\n');
 await Promise.all(clients.map(db=>db.end()));await admin.end();
}
console.log(JSON.stringify({tests:results.length,passed:results.filter(r=>r.status==='passed').length}));
if(results.some(r=>r.status!=='passed'))process.exitCode=1;
