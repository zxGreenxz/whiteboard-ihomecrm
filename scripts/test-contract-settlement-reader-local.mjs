/** Disposable local PostgreSQL/PostgREST only. Never targets shared Supabase. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import pg from 'pg';
const root='.superpowers/sdd/2026-09-20-hop-dong-quyet-toan';
const db=new pg.Client({connectionString:'postgresql://postgres@127.0.0.1:55488/postgres'});
const ids={org:randomUUID(),actor:randomUUID(),building:randomUUID(),otherBuilding:randomUUID(),scope:randomUUID(),membership:randomUUID(),override:randomUUID(),deposit:randomUUID(),claim:randomUUID()};
const voucherIds=Array.from({length:1001},()=>randomUUID()); let seededPermission=false;
const room=randomUUID(),contract=randomUUID(),termination=randomUUID(),obligation=randomUUID(),settlement=randomUUID(),posting=randomUUID();
function token(actor){const secret=fs.readFileSync(root+'/postgrest.conf','utf8').match(/jwt-secret = "([^"]+)"/)[1];const b64=x=>Buffer.from(JSON.stringify(x)).toString('base64url');const text=b64({alg:'HS256',typ:'JWT'})+'.'+b64({role:'authenticated',sub:actor,exp:Math.floor(Date.now()/1000)+600});return text+'.'+createHmac('sha256',secret).update(text).digest('base64url');}
async function read(patch={},actor=ids.actor){const r=await fetch('http://127.0.0.1:55489/rpc/read_contract_settlement_page_v1',{method:'POST',headers:{Authorization:'Bearer '+token(actor),'Content-Type':'application/json'},body:JSON.stringify({p_organization_id:ids.org,p_building_ids:[ids.building],p_limit:250,...patch})});return {status:r.status,body:await r.json()};}
await db.connect();
try {
 await db.query('BEGIN');await db.query('SET LOCAL session_replication_role=replica');
 await db.query("INSERT INTO public.organizations(id,slug,name,status) VALUES($1,$2,'T2 disposable reader','ACTIVE')",[ids.org,'t2-'+ids.org]);
 await db.query("INSERT INTO auth.users(id,email) VALUES($1,$2)",[ids.actor,'t2-'+ids.actor+'@example.invalid']);
 await db.query("INSERT INTO public.organization_memberships(id,organization_id,user_id,member_type,status) VALUES($1,$2,$3,'STAFF','ACTIVE')",[ids.membership,ids.org,ids.actor]);
 for(const id of [ids.building,ids.otherBuilding])await db.query("INSERT INTO public.buildings(id,user_id,organization_id,name,province,district,ward) VALUES($1,$2,$3,'T2 local','','','')",[id,ids.actor,ids.org]);
 const inserted=await db.query("INSERT INTO public.permission_definitions(key,resource,action,sensitivity,permission_domain,scope_kinds,is_active) VALUES('buildings.view','buildings','view','VIEW','TENANT',ARRAY['ORGANIZATION','AREA','BUILDING'],true) ON CONFLICT(key) DO NOTHING RETURNING key");seededPermission=inserted.rowCount>0;
 await db.query("INSERT INTO public.authorization_scopes(id,organization_id,scope_type,building_id) VALUES($1,$2,'BUILDING',$3)",[ids.scope,ids.org,ids.building]);
 await db.query("INSERT INTO public.member_permission_overrides(id,organization_id,membership_id,permission_key,effect,reason,created_by,scope_mode) VALUES($1,$2,$3,'buildings.view','ALLOW','T2 disposable fixture',$4,'SCOPED')",[ids.override,ids.org,ids.membership,ids.actor]);
 await db.query('INSERT INTO public.member_override_scopes(organization_id,override_id,scope_id) VALUES($1,$2,$3)',[ids.org,ids.override,ids.scope]);
 await db.query(`INSERT INTO public.income_expenses(id,user_id,organization_id,building_id,type,name,code,voucher_date,total_amount,approval_status,posting_mode,posting_status,review_state,review_version,approval_version,posting_version,commission_kind)
 SELECT x.id,$2,$3,$4,'EXPENSE','T2 reader','T2-'||x.n,'2026-08-31',10,'UNAPPROVED','CASHBOOK','UNPOSTED','PENDING',1,1,1,'sale' FROM unnest($1::uuid[]) WITH ORDINALITY x(id,n)`,[voucherIds,ids.actor,ids.org,ids.building]);
 await db.query("INSERT INTO public.income_expenses(id,user_id,organization_id,building_id,type,name,code,voucher_date,total_amount,approval_status,posting_mode,posting_status,review_state,review_version,approval_version,posting_version) VALUES($1,$2,$3,$4,'INCOME','T2 deposit','T2-DEP','2026-08-30',100,'UNAPPROVED','CASHBOOK','UNPOSTED','PENDING',1,1,1)",[ids.deposit,ids.actor,ids.org,ids.building]);
 await db.query('INSERT INTO app_private.sale_bonus_claims(id,organization_id,deposit_voucher_id,bonus_voucher_id,amount,created_by) VALUES($1,$2,$3,$4,10,$5)',[ids.claim,ids.org,ids.deposit,voucherIds[0],ids.actor]);
 await db.query("INSERT INTO public.rooms(id,building_id,organization_id,name,rent_price,deposit_amount) VALUES($1,$2,$3,'T2-101',4000000,4000000)",[room,ids.building,ids.org]);
 await db.query("INSERT INTO public.contracts(id,user_id,organization_id,room_id,contract_number,public_code,status,signed_date,start_date,end_date,rent_price) VALUES($1,$2,$3,$4,'HD-T2',$5,'ACTIVE','2026-08-01','2026-08-01','2027-08-01',4000000)",[contract,ids.actor,ids.org,room,'T2-'+contract]);
 await db.query('UPDATE public.income_expenses SET contract_id=$1,room_id=$2,commission_legacy_dup=true WHERE id=ANY($3)',[contract,room,voucherIds.slice(1)]);
 await db.query("INSERT INTO public.contract_terminations(id,user_id,organization_id,contract_id,termination_date,actual_move_out_date,termination_type,total_deposit,status,refund_method) VALUES($1,$2,$3,$4,'2026-08-31','2026-08-31','NORMAL',4000000,'APPROVED','TM')",[termination,ids.actor,ids.org,contract]);
 await db.query("INSERT INTO public.termination_refund_obligations(id,organization_id,termination_id,contract_id,requested_amount,real_held,recognized_only,basis_status,basis_fingerprint,obligation_status,snapshot,created_by) VALUES($1,$2,$3,$4,123,123,0,'OK','t2-basis','OK','{}',$5)",[obligation,ids.org,termination,contract,ids.actor]);
 await db.query("INSERT INTO public.reservation_deposit_settlements(id,organization_id,source_voucher_id,building_id,room_id,deposit_amount,retained_amount,refund_amount,settlement_date,reason_code,created_by,basis_fingerprint,request_hash,idempotency_key) VALUES($1,$2,$3,$4,$5,100,0,100,'2026-08-31','CHANGED_MIND',$6,'t2-reservation','t2','t2')",[settlement,ids.org,ids.deposit,ids.building,room,ids.actor]);
 await db.query("UPDATE public.income_expenses SET approval_status='APPROVED' WHERE id=ANY($1)",[[voucherIds[1],voucherIds[3],voucherIds[4],voucherIds[5]]]);
 await db.query("UPDATE public.income_expenses SET approval_status='CANCELLED' WHERE id=$1",[voucherIds[2]]);
 await db.query("UPDATE public.income_expenses SET posting_status='REVERSED' WHERE id=$1",[voucherIds[3]]);
 await db.query("UPDATE public.income_expenses SET posting_mode='NON_CASH',posting_status='NOT_APPLICABLE' WHERE id=$1",[voucherIds[4]]);
 await db.query("INSERT INTO public.income_expense_postings(id,organization_id,voucher_id,posting_subject_id,direction,account_id,gross_amount,voucher_amount_snapshot,amount_basis,net_cash_effect,posted_on,posted_by_membership_id,posted_by_user_id,approval_version,event_kind,idempotency_key,source_kind,posting_generation) VALUES($1,$2,$3,$3,'EXPENSE',$4,10,10,'VOUCHER_TOTAL',-10,'2026-08-31',$5,$6,1,'POSTING','t2-reader','TEST',1)",[posting,ids.org,voucherIds[5],randomUUID(),ids.membership,ids.actor]);
 await db.query("UPDATE public.income_expenses SET posting_status='POSTED',active_posting_id_v2=$1 WHERE id=$2",[posting,voucherIds[5]]);
 await db.query("UPDATE public.income_expenses SET notes='',payer_name='',receive_bank_name='',receive_bank_account='',system_source='' WHERE id=$1",[voucherIds[6]]);
 await db.query('COMMIT');
 let cursor=null,revision=null;const rows=[];let pages=0;const started=performance.now();
 do {const r=await read({p_cursor:cursor,p_revision:revision});assert.equal(r.status,200,JSON.stringify(r.body));revision??=r.body.revision;assert.equal(r.body.revision,revision);rows.push(...r.body.rows);cursor=r.body.nextCursor;pages++;}while(cursor);
 const readElapsed=Math.round(performance.now()-started);
 assert.equal(pages,5);assert.equal(rows.length,1004);
 const reservation=rows.find(r=>r.rowKey==='reservation:'+settlement);assert.equal(reservation.basis.amount,100);assert.equal(reservation.sourceRef.sourceVoucherId,ids.deposit);assert.equal(reservation.sourceRef.refundVoucherId,null);
 const vouchers=rows.filter(r=>r.rowType==='voucher');assert.equal(new Set(vouchers.map(r=>r.voucherId)).size,1001);
 const source=rows.find(r=>r.rowKey==='termination:'+termination);assert.equal(source.basis.amount,123);assert.equal(source.sourceRef.obligationId,obligation);assert.equal(source.buildingId,ids.building);assert.equal(source.roomId,room);
 const broker=rows.find(r=>r.rowKey==='broker:'+contract);assert.equal(broker.basis.amount,null);assert.equal(broker.createEligibility.state,'unavailable');
 const sql=await db.query('SELECT id,total_amount FROM public.income_expenses WHERE organization_id=$1 AND building_id=$2 AND commission_kind=$3 ORDER BY id',[ids.org,ids.building,'sale']);
 assert.deepEqual(vouchers.map(r=>r.voucherId).sort(),sql.rows.map(r=>r.id));assert.equal(vouchers.reduce((sum,r)=>sum+Number(r.snapshot.value.totalAmount),0),sql.rows.reduce((sum,r)=>sum+Number(r.total_amount),0));
 const linked=rows.find(r=>r.voucherId===voucherIds[0]);assert.equal(linked.snapshot.value.contractId,null);assert.equal(linked.sourceLink.sourceRef.depositVoucherId,ids.deposit);
 const paid=rows.find(r=>r.voucherId===voucherIds[5]).snapshot.value;assert.equal(paid.effectiveNetPaid,10);assert.equal(paid.postingEvidence.value.activePostingId,posting);assert.equal(paid.postedOn,'2026-08-31');
 const blank=rows.find(r=>r.voucherId===voucherIds[6]).snapshot.value;for(const key of ['notes','payerName','receiveBankName','receiveBankAccount','systemSource'])assert.equal(blank[key],null);
 assert.equal(rows.find(r=>r.voucherId===voucherIds[1]).snapshot.value.postingStatus,'UNPOSTED');assert.equal(rows.find(r=>r.voucherId===voucherIds[2]).snapshot.value.approvalStatus,'CANCELLED');assert.equal(rows.find(r=>r.voucherId===voucherIds[3]).snapshot.value.postingStatus,'REVERSED');assert.equal(rows.find(r=>r.voucherId===voucherIds[4]).snapshot.value.postingMode,'NON_CASH');
 assert.equal((await read({},randomUUID())).status,403);assert.equal((await read({p_organization_id:randomUUID()})).status,403);assert.equal((await read({p_building_ids:[ids.otherBuilding]})).status,403);
 await db.query('BEGIN');await db.query('SET LOCAL session_replication_role=replica');await db.query("UPDATE public.organization_memberships SET status='SUSPENDED' WHERE id=$1",[ids.membership]);await db.query('COMMIT');assert.equal((await read()).status,403);
 await db.query('BEGIN');await db.query('SET LOCAL session_replication_role=replica');await db.query("UPDATE public.organization_memberships SET status='ACTIVE' WHERE id=$1",[ids.membership]);await db.query('COMMIT');
 assert.equal((await read({p_revision:'stale'})).status,409);
 await db.query('BEGIN');await db.query('SET LOCAL session_replication_role=replica');await db.query('UPDATE public.income_expenses SET total_amount=11 WHERE id=$1',[voucherIds[0]]);await db.query('COMMIT');assert.equal((await read({p_revision:revision})).status,409);
 console.log(`PASS: 1001 vouchers + 3 sources / ${pages} pages; read ${readElapsed}ms, read and assertions ${Math.round(performance.now()-started)}ms. Exact SQL voucher IDs + total 10010; broker unknown tier, termination obligation, reservation LATER; paid posting evidence, cancelled/noncash/reversed; NULL-contract private Sale claim; outsider/org/building/suspended denial; stale/concurrent revision rejection.`);
} finally {
 await db.query('ROLLBACK');await db.query('BEGIN');await db.query('SET LOCAL session_replication_role=replica');
 for(const table of ['app_private.sale_bonus_claims','public.reservation_deposit_settlements','public.income_expense_postings','public.income_expenses','public.termination_refund_obligations','public.contract_terminations','public.contracts','public.rooms','public.member_override_scopes','public.member_permission_overrides','public.authorization_scopes','public.organization_memberships','public.buildings'])await db.query(`DELETE FROM ${table} WHERE organization_id=$1`,[ids.org]);
 await db.query('DELETE FROM public.organizations WHERE id=$1',[ids.org]);await db.query('DELETE FROM auth.users WHERE id=$1',[ids.actor]);
 if(seededPermission)await db.query("DELETE FROM public.permission_definitions WHERE key='buildings.view'");
 await db.query('COMMIT');await db.end();
}
