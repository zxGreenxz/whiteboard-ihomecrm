#!/usr/bin/env node
// Disposable copied database only; every reader invocation uses a real local authenticated JWT.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import pg from 'pg';
const db = new pg.Client({ connectionString: 'postgresql://postgres@127.0.0.1:55488/settlement_t7' });
const id = Object.fromEntries(['org','owner','viewer','admin','member','ownerMember','building','hiddenBuilding','room','hiddenRoom','scope','orgScope','override','categoryOverride','receipt','account','posting','item1','item2','termination','settlementInvoice','settlementItem1','settlementItem2','hiddenSettlementInvoice','hiddenSettlementItem','refundVoucher','refundDepositItem','refundItem','missingTypeItem','depositType','refundType','obligation'].map(name => [name, randomUUID()]));
const contracts = [randomUUID(), randomUUID(), randomUUID()];
const extraIds=Array.from({length:1001},()=>randomUUID());
let seededPermission = false;
let seededCategoryPermission = false;
const fixture = async fn => { await db.query('BEGIN'); try { await db.query('SET LOCAL session_replication_role=replica'); await fn(); await db.query('COMMIT'); } catch (error) { await db.query('ROLLBACK'); throw error; } };
function jwt(actor) {
  const secret = fs.readFileSync('.superpowers/sdd/2026-09-20-hop-dong-quyet-toan/postgrest-t7.conf', 'utf8').match(/jwt-secret = "([^"]+)"/)[1];
  const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ role: 'authenticated', sub: actor, exp: Math.floor(Date.now() / 1000) + 600 });
  return body + '.' + createHmac('sha256', secret).update(body).digest('base64url');
}
async function read(room = id.room, actor = id.viewer, termination = null, voucher = null) {
  const response = await fetch('http://127.0.0.1:55490/rpc/read_contract_settlement_financial_facts_v1', { method: 'POST', headers: { Authorization: 'Bearer ' + jwt(actor), 'Content-Type': 'application/json' }, body: JSON.stringify({ p_organization_id:id.org,p_room_id:room,p_contract_id:contracts[1],p_termination_id:termination,p_voucher_id:voucher }) });
  const text = await response.text();
  let body; try { body = JSON.parse(text); } catch { body = { message: text }; }
  return { status: response.status, body };
}
await db.connect();
try {
  await fixture(async () => {
    await db.query("INSERT INTO public.organizations(id,slug,name,status) VALUES($1,$2,'T7 isolated','ACTIVE')", [id.org, 't7-' + id.org]);
    for (const actor of [id.owner,id.viewer,id.admin]) await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [actor, 't7-' + actor + '@example.invalid']);
    await db.query("INSERT INTO public.super_admins(user_id,note) VALUES($1,'T7 no membership')", [id.admin]);
    for (const [actor, member] of [[id.owner,id.ownerMember],[id.viewer,id.member]]) await db.query("INSERT INTO public.organization_memberships(id,organization_id,user_id,member_type,status) VALUES($1,$2,$3,'STAFF','ACTIVE')", [member,id.org,actor]);
    for (const building of [id.building,id.hiddenBuilding]) await db.query("INSERT INTO public.buildings(id,user_id,organization_id,name,province,district,ward) VALUES($1,$2,$3,'T7 local','','','')", [building,id.owner,id.org]);
    for (const [room,building] of [[id.room,id.building],[id.hiddenRoom,id.hiddenBuilding]]) await db.query("INSERT INTO public.rooms(id,building_id,organization_id,name,rent_price,deposit_amount) VALUES($1,$2,$3,'T7 room',4000000,4000000)", [room,building,id.org]);
    const seeded = await db.query("INSERT INTO public.permission_definitions(key,resource,action,sensitivity,permission_domain,scope_kinds,is_active) VALUES('buildings.view','buildings','view','VIEW','TENANT',ARRAY['ORGANIZATION','AREA','BUILDING'],true) ON CONFLICT(key) DO NOTHING RETURNING key"); seededPermission = seeded.rowCount > 0;
    const seededCategory = await db.query("INSERT INTO public.permission_definitions(key,resource,action,sensitivity,permission_domain,scope_kinds,is_active) VALUES('categories.view','categories','view','VIEW','TENANT',ARRAY['ORGANIZATION'],true) ON CONFLICT(key) DO NOTHING RETURNING key"); seededCategoryPermission = seededCategory.rowCount > 0;
    await db.query("INSERT INTO public.authorization_scopes(id,organization_id,scope_type,building_id) VALUES($1,$2,'BUILDING',$3)", [id.scope,id.org,id.building]);
    await db.query("INSERT INTO public.authorization_scopes(id,organization_id,scope_type) VALUES($1,$2,'ORGANIZATION')", [id.orgScope,id.org]);
    await db.query("INSERT INTO public.member_permission_overrides(id,organization_id,membership_id,permission_key,effect,reason,created_by,scope_mode) VALUES($1,$2,$3,'buildings.view','ALLOW','T7 local',$4,'SCOPED')", [id.override,id.org,id.member,id.owner]);
    await db.query("INSERT INTO public.member_permission_overrides(id,organization_id,membership_id,permission_key,effect,reason,created_by,scope_mode) VALUES($1,$2,$3,'categories.view','ALLOW','T7 local',$4,'ORGANIZATION')", [id.categoryOverride,id.org,id.member,id.owner]);
    await db.query('INSERT INTO public.member_override_scopes(organization_id,override_id,scope_id) VALUES($1,$2,$3)', [id.org,id.override,id.scope]);
    await db.query('INSERT INTO public.member_override_scopes(organization_id,override_id,scope_id) VALUES($1,$2,$3)', [id.org,id.categoryOverride,id.orgScope]);
    for (let i = 0; i < contracts.length; i++) await db.query(`INSERT INTO public.contracts(id,user_id,organization_id,room_id,contract_number,public_code,status,signed_date,start_date,end_date,actual_end_date,rent_price,total_deposit)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'2026-12-31',$10,4000000,4000000)`, [contracts[i],id.owner,id.org,id.room,'T7-HD-'+i,'T7-'+contracts[i],i===2?'ACTIVE':'TERMINATED',`2026-0${i+1}-01`,`2026-0${i+1}-10`,i===2?null:`2026-0${i+2}-10`]);
    await db.query(`INSERT INTO public.income_expenses(id,user_id,organization_id,building_id,room_id,contract_id,type,name,code,voucher_date,total_amount,approval_status,posting_mode,posting_status,review_state,review_version,approval_version,posting_version,system_source,has_restricted_item)
      VALUES($1,$2,$3,$4,$5,$6,'INCOME','T7 restricted','T7-SECRET','2026-02-10',9876543,'APPROVED','CASHBOOK','UNPOSTED','PENDING',1,1,1,'contract.deposit',true)`, [id.receipt,id.owner,id.org,id.building,id.room,contracts[1]]);
  });
  let before = (await db.query('SELECT to_jsonb(v) AS value FROM public.income_expenses v WHERE id=$1', [id.receipt])).rows[0].value;
  const result = await read(); assert.equal(result.status,200,JSON.stringify(result.body));
  assert.equal(result.body.organizationId,id.org,'room scope must identify its organization');
  assert.match(result.body.today,/^\d{4}-\d{2}-\d{2}$/,'today comes from organization timezone');
  assert.equal(result.body.targetContractId,contracts[1]);
  assert.equal(result.body.notes.signedDate,'2026-02-01'); assert.equal(result.body.receiptsComplete,false,'hidden source must not become zero');
  assert.ok(!JSON.stringify(result.body).includes('T7-SECRET'),'restricted receipt must not leak through room reader');
  await fixture(async()=>{
    await db.query("INSERT INTO public.accounts(id,user_id,organization_id,name,code) VALUES($1,$2,$3,'T7 cash','T7-CASH')",[id.account,id.owner,id.org]);
    await db.query("UPDATE public.income_expenses SET has_restricted_item=false,total_amount=6000000,posting_status='POSTED',account_id=$2,active_posting_id_v2=$3 WHERE id=$1",[id.receipt,id.account,id.posting]);
    for(const [item,kind,amount] of [[id.item1,'DEPOSIT',4000000],[id.item2,'PNL',2000000]])await db.query("INSERT INTO public.income_expense_items(id,income_expense_id,income_expense_type_id,organization_id,amount,accounting_class) VALUES($1,$2,$3,$4,$5,$6)",[item,id.receipt,randomUUID(),id.org,amount,kind]);
    await db.query("INSERT INTO public.income_expense_postings(id,organization_id,voucher_id,posting_subject_id,direction,account_id,gross_amount,voucher_amount_snapshot,amount_basis,net_cash_effect,posted_on,posted_by_membership_id,posted_by_user_id,approval_version,event_kind,idempotency_key,source_kind,posting_generation) VALUES($1,$2,$3,$3,'INCOME',$4,6000000,6000000,'VOUCHER_TOTAL',6000000,'2026-02-10',$5,$6,1,'POSTING',$7,'USER',1)",[id.posting,id.org,id.receipt,id.account,id.ownerMember,id.owner,id.posting]);
  });
  const paid=await read();assert.equal(paid.status,200,JSON.stringify(paid.body));assert.equal(paid.body.receiptsComplete,true);assert.equal(paid.body.receipts[0].ledger.active.id,id.posting);assert.equal(paid.body.receipts[0].itemsComplete,true);assert.equal(paid.body.receipts[0].items.find(x=>x.accountingClass==='DEPOSIT').amount,4000000);
  await fixture(async()=>{await db.query('UPDATE public.income_expenses SET contract_id=NULL WHERE id=$1',[id.receipt]);await db.query("INSERT INTO public.contract_deposit_links(organization_id,contract_id,income_expense_id,link_source,linked_by) VALUES($1,$2,$3,'EXPLICIT_V2',$4)",[id.org,contracts[1],id.receipt,id.owner]);});
  const linked=await read();assert.equal(linked.status,200,JSON.stringify(linked.body));assert.equal(linked.body.receipts.length,1);assert.equal(linked.body.receipts[0].id,id.receipt,'explicit reservation deposit link is retained');
  await fixture(async()=>{await db.query('UPDATE public.income_expenses SET contract_id=$1 WHERE id=$2',[contracts[1],id.receipt]);});
  const direct=await fetch('http://127.0.0.1:55490/income_expense_postings?id=eq.'+id.posting,{headers:{Authorization:'Bearer '+jwt(id.viewer)}});assert.deepEqual(await direct.json(),[],'ordinary viewer has no raw posting rows');
  await fixture(async()=>{
    await db.query("INSERT INTO public.contract_terminations(id,user_id,organization_id,contract_id,termination_date,actual_move_out_date,termination_type,total_deposit,status,outstanding_debt,early_termination_fee,rent_refund_amount,refund_method,notes) VALUES($1,$2,$3,$4,'2026-02-10','2026-02-10','NORMAL',4000000,'APPROVED',700000,500000,300000,'TM','GHI NỢ — chờ thu')",[id.termination,id.owner,id.org,contracts[1]]);
    await db.query("UPDATE public.income_expenses SET system_source='termination.refund' WHERE id=$1",[id.receipt]);
  });
  const unmapped=await read(id.room,id.viewer,id.termination);assert.equal(unmapped.status,200,JSON.stringify(unmapped.body));assert.equal(unmapped.body.termination.debt,700000);assert.equal(unmapped.body.receiptsComplete,false,'unmapped legacy refund is unknown, not zero actual refund');
  await fixture(()=>db.query("UPDATE public.income_expenses SET system_source='contract.deposit' WHERE id=$1",[id.receipt]));
  await fixture(async()=>{
    await db.query("INSERT INTO public.invoices(id,user_id,organization_id,contract_id,building_id,room_id,billing_month,issue_date,due_date,status,total_amount,kind) VALUES($1,$2,$3,$4,$5,$6,'2026-02','2026-02-10','2026-02-10','APPROVED',500000,'SETTLEMENT')",[id.settlementInvoice,id.owner,id.org,contracts[1],id.building,id.room]);
    await db.query("INSERT INTO public.invoice_items(id,invoice_id,organization_id,type,description,amount,sort_order) VALUES($1,$3,$4,'SERVICE','Tiền điện',300000,1),($2,$3,$4,'OTHER','Tiền vệ sinh',200000,2)",[id.settlementItem1,id.settlementItem2,id.settlementInvoice,id.org]);
    await db.query("INSERT INTO public.income_expense_types(id,name,type,user_id,is_deposit,organization_id) VALUES($1,$2,'expense',$3,true,$4),($5,$6,'expense',$3,false,$4)",[id.depositType,'T7 deposit '+id.depositType,id.owner,id.org,id.refundType,'T7 rent refund '+id.refundType]);
    await db.query("INSERT INTO public.income_expenses(id,user_id,organization_id,building_id,room_id,contract_id,type,name,code,voucher_date,total_amount,approval_status,posting_mode,posting_status,review_state,review_version,approval_version,posting_version,system_source,has_restricted_item) VALUES($1,$2,$3,$4,$5,$6,'EXPENSE','T7 refund','T7-REFUND','2026-02-10',3100000,'UNAPPROVED','CASHBOOK','UNPOSTED','PENDING',1,1,1,'termination.refund',false)",[id.refundVoucher,id.owner,id.org,id.building,id.room,contracts[1]]);
    await db.query("INSERT INTO public.income_expense_items(id,income_expense_id,income_expense_type_id,organization_id,description,amount,accounting_class) VALUES($1,$3,$4,$5,'Trả lại khách (cọc sau khấu trừ)',2800000,'DEPOSIT'),($2,$3,$6,$5,'Hoàn tiền phòng ngày không ở',300000,'PNL')",[id.refundDepositItem,id.refundItem,id.refundVoucher,id.depositType,id.org,id.refundType]);
    await db.query("INSERT INTO public.termination_refund_obligations(id,organization_id,termination_id,contract_id,version,requested_amount,real_held,recognized_only,basis_status,basis_fingerprint,obligation_status,snapshot,created_by,voucher_id) VALUES($1,$2,$3,$4,1,2800000,4000000,0,'POSTED','t7-breakdown','OK','{}',$5,$6)",[id.obligation,id.org,id.termination,contracts[1],id.owner,id.refundVoucher]);
  });
  const detailed=await read(id.room,id.viewer,id.termination,id.refundVoucher);assert.equal(detailed.status,200,JSON.stringify(detailed.body));
  assert.ok(detailed.body.terminationBreakdown,JSON.stringify(detailed.body));
  const {refundItems,...detailedBreakdown}=detailed.body.terminationBreakdown;
  assert.deepEqual(detailedBreakdown,{complete:true,terminationId:id.termination,contractId:contracts[1],actualMoveOutDate:'2026-02-10',depositUsed:4000000,outstandingDebt:700000,earlyTerminationFee:500000,rentRefundAmount:300000,totalDeductions:1200000,refundAmount:2800000,excessRent:0,shortfallMode:null,settlementItems:[{description:'Tiền điện',amount:300000,type:'SERVICE'},{description:'Tiền vệ sinh',amount:200000,type:'OTHER'}]},'authenticated reader returns exact selected termination detail without trusting free-form notes');
  assert.deepEqual(refundItems.toSorted((a,b)=>a.description.localeCompare(b.description)),[{description:'Hoàn tiền phòng ngày không ở',amount:300000,typeName:'T7 rent refund '+id.refundType,isDeposit:false},{description:'Trả lại khách (cọc sau khấu trừ)',amount:2800000,typeName:'T7 deposit '+id.depositType,isDeposit:true}]);
  await fixture(()=>db.query("INSERT INTO public.income_expense_items(id,income_expense_id,income_expense_type_id,organization_id,description,amount,accounting_class) VALUES($1,$2,$3,$4,'T7 hidden type zero',0,'PNL')",[id.missingTypeItem,id.refundVoucher,randomUUID(),id.org]));
  const missingType=await read(id.room,id.viewer,id.termination,id.refundVoucher);assert.equal(missingType.status,200);assert.deepEqual(missingType.body.terminationBreakdown,{complete:false,terminationId:id.termination,contractId:contracts[1],reason:'REFUND_TYPES_UNAVAILABLE'},'a zero-valued item with an unavailable category is still incomplete');
  await fixture(()=>db.query('DELETE FROM public.income_expense_items WHERE id=$1',[id.missingTypeItem]));
  await fixture(async()=>{await db.query('UPDATE public.income_expenses SET total_amount=3400000 WHERE id=$1',[id.refundVoucher]);await db.query('UPDATE public.income_expense_items SET amount=3100000 WHERE id=$1',[id.refundDepositItem]);});
  const inventedCredit=await read(id.room,id.viewer,id.termination,id.refundVoucher);assert.equal(inventedCredit.status,200);assert.deepEqual(inventedCredit.body.terminationBreakdown,{complete:false,terminationId:id.termination,contractId:contracts[1],reason:'REFUND_TOTAL_INCONSISTENT'},'a larger voucher/item total must not manufacture excess-rent evidence');
  await fixture(async()=>{await db.query('UPDATE public.income_expenses SET total_amount=3100000 WHERE id=$1',[id.refundVoucher]);await db.query('UPDATE public.income_expense_items SET amount=2800000 WHERE id=$1',[id.refundDepositItem]);});
  await fixture(()=>db.query("UPDATE public.contract_terminations SET notes='Tiền thừa (credit) áp dụng: 9.000.000đ — đã thu ngay khi thanh lý' WHERE id=$1",[id.termination]));
  const conflictingNotes=await read(id.room,id.viewer,id.termination,id.refundVoucher);assert.equal(conflictingNotes.status,200);assert.equal(conflictingNotes.body.terminationBreakdown.excessRent,0,'free-form credit is not money evidence');assert.equal(conflictingNotes.body.terminationBreakdown.shortfallMode,null,'free-form status is not payment evidence');
  await fixture(()=>db.query('UPDATE public.contract_terminations SET outstanding_debt=NULL,early_termination_fee=NULL WHERE id=$1',[id.termination]));
  const nullInputs=await read(id.room,id.viewer,id.termination,id.refundVoucher);assert.equal(nullInputs.status,200);assert.deepEqual(nullInputs.body.terminationBreakdown,{complete:false,terminationId:id.termination,contractId:contracts[1],reason:'TERMINATION_INPUTS_UNAVAILABLE'},'nullable money never becomes verified zero');
  await fixture(()=>db.query('UPDATE public.contract_terminations SET outstanding_debt=700000,early_termination_fee=500000 WHERE id=$1',[id.termination]));
  await fixture(async()=>{await db.query("INSERT INTO public.invoices(id,user_id,organization_id,contract_id,building_id,room_id,billing_month,issue_date,due_date,status,total_amount,kind,created_at) VALUES($1,$2,$3,$4,$5,$6,'2026-02','2026-02-10','2026-02-10','APPROVED',777777,'SETTLEMENT',now()+interval '1 minute')",[id.hiddenSettlementInvoice,id.owner,id.org,contracts[1],id.hiddenBuilding,id.hiddenRoom]);await db.query("INSERT INTO public.invoice_items(id,invoice_id,organization_id,type,description,amount,sort_order) VALUES($1,$2,$3,'OTHER','T7 HIDDEN SECRET',777777,1)",[id.hiddenSettlementItem,id.hiddenSettlementInvoice,id.org]);});
  const hiddenInvoice=await read(id.room,id.viewer,id.termination,id.refundVoucher);assert.equal(hiddenInvoice.status,200);assert.deepEqual(hiddenInvoice.body.terminationBreakdown,{complete:false,terminationId:id.termination,contractId:contracts[1],reason:'INVOICES_INCOMPLETE'});assert.ok(!JSON.stringify(hiddenInvoice.body).includes('T7 HIDDEN SECRET'),'hidden invoice detail must not cross RLS');
  await fixture(async()=>{await db.query('DELETE FROM public.invoice_items WHERE id=$1',[id.hiddenSettlementItem]);await db.query('DELETE FROM public.invoices WHERE id=$1',[id.hiddenSettlementInvoice]);});
  await fixture(()=>db.query('UPDATE public.invoices SET deleted_at=now() WHERE id=$1',[id.settlementInvoice]));
  const incomplete=await read(id.room,id.viewer,id.termination,id.refundVoucher);assert.equal(incomplete.status,200);assert.deepEqual(incomplete.body.terminationBreakdown,{complete:false,terminationId:id.termination,contractId:contracts[1],reason:'SETTLEMENT_ITEMS_UNAVAILABLE'},'missing detail stays unavailable instead of fabricated zero');
  await fixture(()=>db.query('UPDATE public.invoices SET deleted_at=NULL WHERE id=$1',[id.settlementInvoice]));
  await fixture(()=>db.query("INSERT INTO public.income_expenses(id,user_id,organization_id,building_id,room_id,contract_id,type,name,code,voucher_date,total_amount,approval_status,posting_mode,posting_status,review_state,review_version,approval_version,posting_version,system_source,has_restricted_item) SELECT x,$2,$3,$4,$5,$6,'INCOME','T7 bulk','T7-'||x,'2026-02-10',100,'APPROVED','CASHBOOK','UNPOSTED','PENDING',1,1,1,'contract.deposit',false FROM unnest($1::uuid[]) x",[extraIds,id.owner,id.org,id.building,id.room,contracts[1]]));
  const started=performance.now();const full=await read();assert.equal(full.status,200);assert.equal(full.body.receipts.length,1003);assert.equal(full.body.receiptsComplete,true);console.log('Full scalar JSON receipts=1003, requests=1, elapsedMs='+Math.round(performance.now()-started));
  before=(await db.query('SELECT to_jsonb(v) AS value FROM public.income_expenses v WHERE id=$1',[id.receipt])).rows[0].value;
  await fixture(()=>db.query('UPDATE public.rooms SET organization_id=$1 WHERE id=$2',[randomUUID(),id.room]));
  assert.equal((await read()).status,403,'room/building organization mismatch denied');
  await fixture(()=>db.query('UPDATE public.rooms SET organization_id=$1 WHERE id=$2',[id.org,id.room]));
  const hidden = await read(id.hiddenRoom); assert.ok([403,404].includes(hidden.status),'hidden building denied: '+JSON.stringify(hidden));
  assert.equal((await read(id.room,id.admin)).status,403,'superadmin without active membership must not bypass room scope');
  await fixture(()=>db.query("UPDATE public.organization_memberships SET revoked_at=now() WHERE id=$1",[id.member]));
  assert.equal((await read()).status,403,'revoked membership denied');
  await fixture(()=>db.query("UPDATE public.organization_memberships SET revoked_at=NULL,valid_from=now()+interval '1 day' WHERE id=$1",[id.member]));
  assert.equal((await read()).status,403,'future membership denied');
  await fixture(()=>db.query("UPDATE public.organization_memberships SET valid_from=now()-interval '1 day',valid_to=now()-interval '1 hour' WHERE id=$1",[id.member]));
  assert.equal((await read()).status,403,'expired membership denied');
  await fixture(()=>db.query("UPDATE public.organization_memberships SET valid_to=NULL WHERE id=$1",[id.member]));
  await fixture(()=>db.query("UPDATE public.organizations SET status='SUSPENDED' WHERE id=$1",[id.org]));
  assert.equal((await read()).status,403,'inactive organization denied');
  assert.deepEqual((await db.query('SELECT to_jsonb(v) AS value FROM public.income_expenses v WHERE id=$1',[id.receipt])).rows[0].value,before,'room reader must not mutate vouchers');
  console.log('T7 financial reader JWT: signed date / full history / RLS / active scope / no writes PASS');
} finally {
  await fixture(async () => {
    await db.query('DELETE FROM public.contract_deposit_links WHERE organization_id=$1',[id.org]);
    await db.query('DELETE FROM public.income_expenses WHERE id=ANY($1)',[extraIds]);
    await db.query('DELETE FROM public.income_expense_postings WHERE id=$1',[id.posting]);
    await db.query('DELETE FROM public.termination_refund_obligations WHERE id=$1',[id.obligation]);
    await db.query('DELETE FROM public.income_expense_items WHERE income_expense_id=$1',[id.refundVoucher]);
    await db.query('DELETE FROM public.income_expenses WHERE id=$1',[id.refundVoucher]);
    await db.query('DELETE FROM public.invoice_items WHERE id=ANY($1)',[[id.settlementItem1,id.settlementItem2,id.hiddenSettlementItem]]);
    await db.query('DELETE FROM public.invoices WHERE id=ANY($1)',[[id.settlementInvoice,id.hiddenSettlementInvoice]]);
    await db.query('DELETE FROM public.income_expense_items WHERE income_expense_id=$1',[id.receipt]);
    await db.query('DELETE FROM public.income_expenses WHERE id=$1',[id.receipt]);
    await db.query('DELETE FROM public.income_expense_types WHERE id=ANY($1)',[[id.depositType,id.refundType]]);
    await db.query('DELETE FROM public.accounts WHERE id=$1',[id.account]);
    await db.query('DELETE FROM public.contract_terminations WHERE id=$1',[id.termination]);
    await db.query('DELETE FROM public.contracts WHERE id=ANY($1)',[contracts]);
    await db.query('DELETE FROM public.rooms WHERE id=ANY($1)',[[id.room,id.hiddenRoom]]);
    await db.query('DELETE FROM public.member_override_scopes WHERE override_id=ANY($1)',[[id.override,id.categoryOverride]]);
    await db.query('DELETE FROM public.member_permission_overrides WHERE id=ANY($1)',[[id.override,id.categoryOverride]]);
    await db.query('DELETE FROM public.authorization_scopes WHERE id=ANY($1)',[[id.scope,id.orgScope]]);
    await db.query('DELETE FROM public.buildings WHERE id=ANY($1)',[[id.building,id.hiddenBuilding]]);
    await db.query('DELETE FROM public.organization_memberships WHERE id=ANY($1)',[[id.member,id.ownerMember]]);
    await db.query('DELETE FROM public.super_admins WHERE user_id=$1',[id.admin]);
    await db.query('DELETE FROM public.organizations WHERE id=$1',[id.org]);
    await db.query('DELETE FROM auth.users WHERE id=ANY($1)',[[id.owner,id.viewer,id.admin]]);
    if(seededPermission)await db.query("DELETE FROM public.permission_definitions WHERE key='buildings.view'");
    if(seededCategoryPermission)await db.query("DELETE FROM public.permission_definitions WHERE key='categories.view'");
    const leftovers=await db.query("SELECT (SELECT count(*)::int FROM public.invoice_items WHERE id=ANY($1)) items,(SELECT count(*)::int FROM public.invoices WHERE id=ANY($2)) invoices,(SELECT count(*)::int FROM public.organizations WHERE id=$3) org",[[id.settlementItem1,id.settlementItem2,id.hiddenSettlementItem],[id.settlementInvoice,id.hiddenSettlementInvoice],id.org]);
    assert.deepEqual(leftovers.rows[0],{items:0,invoices:0,org:0},'T7 fixture cleanup must remove children even with replica triggers disabled');
  });
  await db.end();
}
