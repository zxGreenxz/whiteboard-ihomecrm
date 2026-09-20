#!/usr/bin/env node
// Hard-coded disposable loopback copy; no live credentials and no external writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import pg from 'pg';
const db = new pg.Client({ connectionString: 'postgresql://postgres@127.0.0.1:55488/settlement_t7' });
const names = ['org','owner','viewer','member','ownerMember','building','hiddenBuilding','room','scope','override','contract','renewed','extension1','extension2','termination','receipt','link','settlement','refund','revenue','offset','commission','hiddenCommission','receiptItem','secondItem','depositType'];
const id = Object.fromEntries(names.map(name => [name,randomUUID()]));
const extras = [];
let seededPermission = false;
const fixture = async fn => { await db.query('BEGIN'); try { await db.query('SET LOCAL session_replication_role=replica'); await fn(); await db.query('COMMIT'); } catch(error) { await db.query('ROLLBACK'); throw error; } };
function jwt(actor) {
 const secret = fs.readFileSync('.superpowers/sdd/2026-09-20-hop-dong-quyet-toan/postgrest-t7.conf','utf8').match(/jwt-secret = "([^"]+)"/)[1];
 const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
 const body = b64({alg:'HS256',typ:'JWT'})+'.'+b64({role:'authenticated',sub:actor,exp:Math.floor(Date.now()/1000)+1800});
 return body+'.'+createHmac('sha256',secret).update(body).digest('base64url');
}
async function read(args={}, actor=id.viewer) {
 const response = await fetch('http://127.0.0.1:55490/rpc/read_contract_settlement_events_v1',{method:'POST',headers:{Authorization:'Bearer '+jwt(actor),'Content-Type':'application/json'},body:JSON.stringify({p_organization_id:id.org,p_building_ids:[id.building],...args})});
 const text=await response.text(); let body;try {body=JSON.parse(text);} catch {body={message:text};}return {status:response.status,body};
}
async function insertContract(contract,number,parent=null) {
 await db.query(`INSERT INTO public.contracts(id,user_id,organization_id,room_id,contract_number,public_code,status,signed_date,start_date,end_date,actual_end_date,rent_price,total_deposit,parent_contract_id)
 VALUES($1,$2,$3,$4,$5,$6,'TERMINATED','2026-01-01','2026-01-10','2027-01-09','2026-09-01',4000000,4000000,$7)`,[contract,id.owner,id.org,id.room,number,contract,parent]);
}
async function insertVoucher(voucher,type,code,contract,restricted=false,source=null,kind=null) {
 await db.query(`INSERT INTO public.income_expenses(id,user_id,organization_id,building_id,room_id,contract_id,type,name,code,voucher_date,total_amount,approval_status,posting_mode,posting_status,review_state,review_version,approval_version,posting_version,system_source,has_restricted_item,commission_kind)
 VALUES($1,$2,$3,$4,$5,$6,$7,'T7B local',$8,'2026-01-01',4000000,'APPROVED','CASHBOOK','UNPOSTED','PENDING',1,1,1,$9,$10,$11)`,[voucher,id.owner,id.org,id.building,id.room,contract,type,code,source,restricted,kind]);
}
await db.connect();
try {
 await fixture(async()=>{
  await db.query("INSERT INTO public.organizations(id,slug,name,status) VALUES($1,$2,'T7B isolated','ACTIVE')",[id.org,'t7b-'+id.org]);
  for(const actor of [id.owner,id.viewer])await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[actor,'t7b-'+actor+'@example.invalid']);
  for(const [actor,member] of [[id.owner,id.ownerMember],[id.viewer,id.member]])await db.query("INSERT INTO public.organization_memberships(id,organization_id,user_id,member_type,status) VALUES($1,$2,$3,'STAFF','ACTIVE')",[member,id.org,actor]);
  for(const building of [id.building,id.hiddenBuilding])await db.query("INSERT INTO public.buildings(id,user_id,organization_id,name,province,district,ward) VALUES($1,$2,$3,'T7B local','','','')",[building,id.owner,id.org]);
  await db.query("INSERT INTO public.rooms(id,building_id,organization_id,name,rent_price,deposit_amount) VALUES($1,$2,$3,'T7B room',4000000,4000000)",[id.room,id.building,id.org]);
  seededPermission=(await db.query("INSERT INTO public.permission_definitions(key,resource,action,sensitivity,permission_domain,scope_kinds,is_active) VALUES('buildings.view','buildings','view','VIEW','TENANT',ARRAY['ORGANIZATION','AREA','BUILDING'],true) ON CONFLICT(key) DO NOTHING RETURNING key")).rowCount>0;
  await db.query("INSERT INTO public.authorization_scopes(id,organization_id,scope_type,building_id) VALUES($1,$2,'BUILDING',$3)",[id.scope,id.org,id.building]);
  await db.query("INSERT INTO public.member_permission_overrides(id,organization_id,membership_id,permission_key,effect,reason,created_by,scope_mode) VALUES($1,$2,$3,'buildings.view','ALLOW','T7B local',$4,'SCOPED')",[id.override,id.org,id.member,id.owner]);
  await db.query('INSERT INTO public.member_override_scopes(organization_id,override_id,scope_id) VALUES($1,$2,$3)',[id.org,id.override,id.scope]);
  await insertContract(id.contract,'T7B-HD');await insertContract(id.renewed,'T7B-RENEW',id.contract);
  for(const [extension,date,type,newId] of [[id.extension1,'2026-06-01','UPDATE_EXISTING',null],[id.extension2,'2026-07-01','CREATE_NEW',id.renewed]])await db.query(`INSERT INTO public.contract_extensions(id,user_id,organization_id,contract_id,extension_date,extension_months,extension_type,old_end_date,new_end_date,new_contract_id,status)
   VALUES($1,$2,$3,$4,$5,6,$6,'2026-06-01','2027-01-01',$7,'APPROVED')`,[extension,id.owner,id.org,id.contract,date,type,newId]);
  await db.query(`INSERT INTO public.contract_terminations(id,user_id,organization_id,contract_id,termination_date,actual_move_out_date,termination_type,status,total_deposit,refund_method)
   VALUES($1,$2,$3,$4,'2026-09-01','2026-09-03','NORMAL','APPROVED',4000000,'TM')`,[id.termination,id.owner,id.org,id.contract]);
  await insertVoucher(id.receipt,'INCOME','T7B-RESERVE',id.contract);
  await insertVoucher(id.refund,'EXPENSE','T7B-REFUND',null,false,'reservation.refund');
  await insertVoucher(id.revenue,'INCOME','T7B-REVENUE',null,false,'reservation.forfeit');
  await insertVoucher(id.offset,'EXPENSE','T7B-OFFSET',null,false,'reservation.offset');
  await db.query("UPDATE public.income_expenses SET posting_mode='NON_CASH',posting_status='NOT_APPLICABLE' WHERE id=ANY($1)",[[id.revenue,id.offset]]);
  await insertVoucher(id.commission,'EXPENSE','T7B-COMMISSION',id.contract,false,null,'broker');
  await db.query("INSERT INTO public.income_expense_types(id,user_id,organization_id,name,type) VALUES($1,$2,$3,'T7B deposit','income')",[id.depositType,id.owner,id.org]);
  for(const item of [id.receiptItem,id.secondItem])await db.query("INSERT INTO public.income_expense_items(id,organization_id,income_expense_id,income_expense_type_id,description,quantity,unit_price,amount,accounting_class) VALUES($1,$2,$3,$4,'T7B item',1,2000000,2000000,'DEPOSIT')",[item,id.org,id.receipt,id.depositType]);
  await db.query("INSERT INTO public.contract_deposit_links(id,organization_id,contract_id,income_expense_id,link_source,linked_by) VALUES($1,$2,$3,$4,'EXPLICIT_V2',$5)",[id.link,id.org,id.contract,id.receipt,id.owner]);
  await db.query(`INSERT INTO public.reservation_deposit_settlements(id,organization_id,building_id,room_id,source_voucher_id,deposit_amount,retained_amount,refund_amount,settlement_date,reason_code,reason_text,created_by,idempotency_key,request_hash,basis_fingerprint,refund_voucher_id,revenue_voucher_id,offset_voucher_id)
   VALUES($1::uuid,$2,$3,$4,$5,4000000,1000000,3000000,'2026-08-01','CHANGED_MIND','T7B settlement',$6,($1::uuid)::text,'test','test',$7,$8,$9)`,[id.settlement,id.org,id.building,id.room,id.receipt,id.owner,id.refund,id.revenue,id.offset]);
  for(const [voucher,kind] of [[id.refund,'REFUND'],[id.revenue,'REVENUE'],[id.offset,'OFFSET']])await db.query('INSERT INTO public.reservation_settlement_vouchers(organization_id,settlement_id,voucher_id,kind) VALUES($1,$2,$3,$4)',[id.org,id.settlement,voucher,kind]);
 });
 const result=await read();assert.equal(result.status,200,JSON.stringify(result.body));
 assert.equal(result.body.rows.length,6,'one sign, two renewals, one termination, one reserve, one settlement');
 const events=result.body.rows;
 assert.equal(events.filter(e=>e.type==='sign').length,1,'CREATE_NEW must not double-count signed event');
 assert.equal(events.filter(e=>e.type==='renew').length,2,'separate extension IDs survive');
 assert.equal(events.find(e=>e.sourceKind==='termination').businessDate,'2026-09-01','not actual moveout date');
 const reservation=events.find(e=>e.sourceKind==='reservation');assert.equal(reservation.sourceId,id.receipt);assert.equal(reservation.contractId,id.contract,'linked old receipt keeps reservation history');
 const end=events.find(e=>e.sourceKind==='reservation_settlement');assert.equal(end.type,'forfeit');assert.equal(end.links.vouchers.filter(v=>v.id===id.refund).length,1,'refund link not a second event');
 assert.equal(events.find(e=>e.sourceKind==='contract').links.complete,true);
 await fixture(()=>insertVoucher(id.hiddenCommission,'EXPENSE','T7B-SECRET',id.contract,true,null,'sale'));
 const hidden=await read();assert.equal(hidden.status,200,JSON.stringify(hidden.body));
 assert.ok(!JSON.stringify(hidden.body).includes('T7B-SECRET'),'hidden voucher leaked');assert.ok(!JSON.stringify(hidden.body).includes(id.hiddenCommission),'hidden voucher identity leaked');
 assert.equal(hidden.body.rows.find(e=>e.sourceKind==='contract').links.complete,false,'hidden expense cannot become no expense');
 assert.equal((await read({p_building_ids:[id.hiddenBuilding]})).status,403);
 assert.equal((await read({p_organization_id:randomUUID()})).status,403);
 const first=await read({p_limit:2});assert.equal(first.status,200);
 await fixture(()=>db.query("UPDATE public.contracts SET signed_date='2026-01-02' WHERE id=$1",[id.contract]));
 assert.equal((await read({p_limit:2,p_cursor:first.body.nextCursor,p_revision:first.body.revision})).status,409,'mid-pagination change rejects old revision');
 await fixture(()=>db.query('UPDATE public.organization_memberships SET revoked_at=now() WHERE id=$1',[id.member]));
 assert.equal((await read()).status,403,'revoked membership denied');
 await fixture(()=>db.query('UPDATE public.organization_memberships SET revoked_at=NULL WHERE id=$1',[id.member]));
 if(process.argv.includes('--large')){
  await fixture(async()=>{for(let i=0;i<1001;i++){const key=randomUUID();extras.push(key);await insertContract(key,'T7B-EXTRA-'+i);}});
  let cursor=null,revision=null,count=0,pages=0;const seen=new Set();
  do {const response=await read({p_cursor:cursor,p_revision:revision});assert.equal(response.status,200,JSON.stringify(response.body));revision??=response.body.revision;
   assert.equal(response.body.revision,revision);for(const event of response.body.rows){assert.ok(!seen.has(event.id));seen.add(event.id);}count+=response.body.rows.length;pages++;cursor=response.body.nextCursor;
  }while(cursor!==null);
  assert.equal(count,1007);assert.equal(pages,5);console.log('T7B real JWT pagination: 1007 events / 5 pages PASS');
 }
 console.log('T7B actual JWT: historical reservation, separate renewal, source dates, no duplicate legs, RLS/coverage, revision/revocation PASS');
}finally{
 await fixture(async()=>{
  for(const table of ['reservation_settlement_vouchers','reservation_deposit_settlements','contract_deposit_links','income_expense_items','income_expenses','income_expense_types','contract_extensions','contract_terminations','contracts','rooms','member_override_scopes','member_permission_overrides','authorization_scopes','buildings','organization_memberships'])await db.query(`DELETE FROM public.${table} WHERE organization_id=$1`,[id.org]);
  await db.query('DELETE FROM public.organizations WHERE id=$1',[id.org]);await db.query('DELETE FROM auth.users WHERE id=ANY($1)',[[id.owner,id.viewer]]);
  if(seededPermission)await db.query("DELETE FROM public.permission_definitions WHERE key='buildings.view'");
 });
 await db.end();
}
