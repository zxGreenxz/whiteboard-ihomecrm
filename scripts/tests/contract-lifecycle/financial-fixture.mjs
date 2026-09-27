import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const ORG='dddd0000-0000-4000-8000-000000000001';
const uuid = seed => { const h=createHash('sha256').update(seed).digest('hex'); return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`; };
export async function verifyFixtureAbsence({query}, roots) {
  if(roots.length<2 || roots.length>3) return false;
  const {rows}=await query('SELECT (SELECT count(*) FROM public.rooms WHERE id=$1)+(SELECT count(*) FROM public.customers WHERE id=$2)+(SELECT count(*) FROM public.contracts WHERE room_id=$1)+(SELECT count(*) FROM public.accounts WHERE id=$3)+(SELECT count(*) FROM app_private.personal_cash_books WHERE account_id=$3)+(SELECT count(*) FROM public.cashbook_possession_bindings WHERE cashbook_id=$3) AS n', [roots[0],roots[1],roots[2]??null]);
  return rows.length===1 && Number(rows[0].n)===0;
}

async function snapshot(query, contract) {
  const one=async(sql)=> (await query(sql,[contract])).rows;
  return {
    contracts:await one('SELECT id,status,deposit_paid,total_deposit FROM public.contracts WHERE id=$1'),
    rooms:await one('SELECT r.id,r.status FROM public.rooms r JOIN public.contracts c ON c.room_id=r.id WHERE c.id=$1'),
    invoices:await one('SELECT id,status,kind,total_amount,paid_amount,remaining_amount FROM public.invoices WHERE contract_id=$1 ORDER BY id'),
    payments:await one('SELECT p.id,p.invoice_id,p.amount,p.payment_method FROM public.payments p JOIN public.invoices i ON i.id=p.invoice_id WHERE i.contract_id=$1 ORDER BY p.id'),
    vouchers:await one('SELECT v.id,v.type,v.total_amount,v.approval_status,v.review_state,v.approval_version,v.system_source,v.posting_mode,v.posting_status,(v.account_id IS NULL) AS no_account,a.is_virtual FROM public.income_expenses v LEFT JOIN public.accounts a ON a.id=v.account_id WHERE v.contract_id=$1 ORDER BY v.id'),
    items:await one('SELECT it.id,it.income_expense_id,it.amount,it.accounting_class FROM public.income_expense_items it JOIN public.income_expenses v ON v.id=it.income_expense_id WHERE v.contract_id=$1 ORDER BY it.id'),
    postings:await one('SELECT p.id,p.voucher_id,p.direction,p.net_cash_effect,p.event_kind,p.source_kind FROM public.income_expense_postings p JOIN public.income_expenses v ON v.id=p.voucher_id WHERE v.contract_id=$1 ORDER BY p.id'),
    operations:await one('SELECT operation,idempotency_key,(completed_at IS NOT NULL) AS completed FROM app_private.canonical_write_operations WHERE subject_id=$1 ORDER BY operation,idempotency_key'),
    credit:await one('SELECT id,amount,remaining_amount,status FROM public.customer_credit_lots WHERE contract_id=$1 ORDER BY id'),
    terminations:await one('SELECT id,status,termination_type,total_deposit,outstanding_debt,refund_amount FROM public.contract_terminations WHERE contract_id=$1 ORDER BY id'),
    postingLines:await one('SELECT l.id,l.posting_id,l.line_kind,l.signed_amount FROM public.income_expense_posting_lines l JOIN public.income_expense_postings p ON p.id=l.posting_id JOIN public.income_expenses v ON v.id=p.voucher_id WHERE v.contract_id=$1 ORDER BY l.id'),
  };
}
const sum=(rows,key)=>rows.reduce((a,r)=>a+Number(r[key]),0);
const cash=s=>sum(s.postings,'net_cash_effect');
const debt=s=>s.invoices.filter(r=>r.status!=='CANCELLED').reduce((a,r)=>a+Number(r.remaining_amount),0);

export async function runFinancialScenario({query}, {name,runId,roots,stage,evidence={},assertForfeitInvoices,digest}) {
  let current='setup';
  const at=s=>{current=s;stage(s);};
  const q=async(sql,values)=>{ try{return await query(sql,values);}catch(e){stage(`${current}:SQLSTATE:${/^[A-Z0-9]{5}$/.test(e.code)?e.code:'UNKNOWN'}`);throw e;} };
  const scalar=async(sql,values)=>{const r=await q(sql,values);assert.equal(r.rows.length,1);return r.rows[0].v;};
  const key=`${runId}:${name}`;
  roots.push(uuid(key+':room'),uuid(key+':customer'));
  at('setup');
  await q("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='90s'");
  const clock=await scalar('SELECT clock_timestamp()::text AS v');
  const actor=await scalar("SELECT id AS v FROM auth.users WHERE email='demo.chunha@username.ihomecrm.local'");
  await q("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",[actor,JSON.stringify({sub:actor,role:'authenticated'})]);
  const building=await scalar("SELECT id AS v FROM public.buildings WHERE organization_id=$1 AND deleted_at IS NULL AND NOT is_virtual AND (SELECT allowed FROM app_private.authorize_tenant_action_v3($2,$1,'contracts.create',id,NULL)) ORDER BY id LIMIT 1",[ORG,actor]);
  const today=await scalar('SELECT public.org_today_v1($1)::text AS v',[ORG]);
  at('fixture-cashbook-configuration');
  const member=await scalar('SELECT app_private.member_of_org_v1($1,$2) AS v',[ORG,actor]);
  const existing=await scalar("SELECT count(*) AS v FROM app_private.personal_cash_books WHERE membership_id=$1 AND valid_to IS NULL",[member]);
  assert.equal(Number(existing),0,'Refuse replacing existing personal cashbook');
  const account=(await scalar('SELECT public.create_cashbook_v1($1,0,$2,NULL,NULL,NULL,$3,NULL,false,$4,$5) AS v',[key,today,key+':cashbook',actor,ORG])).cashbook_id;
  roots.push(account);
  await scalar('SELECT public.set_personal_cash_book_v1($1,$2) AS v',[member,account]);
  evidence.fixtureConfiguration={newCashbookId:account,initialAmount:0,personalCashbookWasAbsent:true,writers:['create_cashbook_v1','set_personal_cash_book_v1']};
  const flags=(await q('SELECT feature_key,mode,app_private.evaluate_feature_route(feature_key,$1) AS route FROM app_private.server_feature_flags ORDER BY feature_key',[ORG])).rows;
  assert(flags.length>0);
  Object.assign(evidence,{serverClock:clock,flags});
  evidence.sourceHashes=(await q("SELECT n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' AS signature,md5(pg_get_functiondef(p.oid)) AS definition_md5 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=ANY($1::text[]) ORDER BY 1",[['create_cashbook_v1','set_personal_cash_book_v1','create_contract_v2','create_invoice_v1','record_invoice_collection_v5','terminate_contract_forfeit_with_credit_v1','terminate_contract_forfeit_impl','terminate_contract_move_out_with_credit_v1','terminate_contract_move_out_impl','approve_pending_income_expense_checked_v1','approve_income_expense_v2']])).rows;
  assert(evidence.sourceHashes.length>=11,'Missing live writer source hashes');
  await q('INSERT INTO public.rooms(id,organization_id,building_id,name,rent_price,deposit_amount,status) VALUES($1,$2,$3,$4,300000,1000000,\'AVAILABLE\')',[roots[0],ORG,building,key]);
  await q('INSERT INTO public.customers(id,organization_id,user_id,full_name,phone) VALUES($1,$2,$3,$4,$5)',[roots[1],ORG,actor,key,'0000000000']);
  at('create-contract-v2');
  const created=await scalar('SELECT public.create_contract_v2($1::jsonb,$2) AS v',[JSON.stringify({contract:{room_id:roots[0],start_date:today,end_date:'2028-12-31',rent_price:300000,total_deposit:1000000,notes:key},customers:[{customer_id:roots[1],is_representative:true}],deposit_receipts:[{amount:1000000,account_id:account,received_date:today}]}),key+':create']);
  const contract=created.contract.id;
  evidence.contractId=contract;
  assert.equal(Number(created.deposit_paid),1000000);
  const invoiceIds=[];
  evidence.invoiceIds=invoiceIds;
  const amounts=name==='FORFEIT'?[100000,200000,300000]:[name==='REFUND'?200000:1500000];
  for(let i=0;i<amounts.length;i++) {
    at(`create-invoice-${i}`);
    const amount=amounts[i];
    const inv=await scalar('SELECT public.create_invoice_v1($1,$2,$3,$4,$5,$5,\'SETTLEMENT\',$6,0,$6,0,$7::jsonb,$8) AS v',[contract,building,roots[0],today.slice(0,7),today,amount,JSON.stringify([{type:'RENT',description:key,unit_price:amount,quantity:1,coefficient:1,amount,accounting_class:'REVENUE'}]),key+':invoice:'+i]);
    invoiceIds.push(inv.invoice_id);
    if(name==='FORFEIT' && i>0){
      at(`collect-invoice-${i}`);
      await scalar('SELECT public.record_invoice_collection_v5($1,$2,$3::jsonb,$4,false,$5,NULL,0,$6) AS v',[inv.invoice_id,today,JSON.stringify([{payment_method:'TM',gross_amount:i===1?50000:350000,account_id:account}]),i===2?'CREDIT':'REJECT',key,key+':collect:'+i]);
    }
  }
  at('before-snapshot');
  const before=await snapshot(q,contract);
  evidence.before=before;
  assert.equal(Number(before.contracts[0]?.deposit_paid),1000000);
  assert(before.postings.length>0 && cash(before)>0,'Nonzero real cash posting source required');
  assert(debt(before)>0,'Nonzero receivable required');
  const extra=[{type:'OTHER',description:'Synthetic extra charge',amount:75000}];
  const call=async(changed=false)=>name==='FORFEIT'
    ? scalar('SELECT public.terminate_contract_forfeit_with_credit_v1($1,$2,$3::jsonb,$4) AS v',[contract,today,JSON.stringify(changed?[]:extra),key+':settle'])
    : scalar('SELECT public.terminate_contract_move_out_with_credit_v1($1,$2,1000000,0,0,$3,$4,\'[]\'::jsonb,$5,$6,$7) AS v',[contract,today,amounts[0],changed?key+':changed':key,name==='DEBT'?'DEBT':'PAID',account,key+':settle']);
  at('settlement');const response=await call();
  at('after-snapshot');const after=await snapshot(q,contract);
  evidence.after=after;
  assert.equal(after.contracts[0]?.status,'TERMINATED');
  assert.equal(after.rooms[0]?.status,'AVAILABLE');
  assert.equal(after.terminations.length,1,'Required termination audit row');
  assert.equal(after.terminations[0].status,'COMPLETED');
  if(name==='FORFEIT'){
    assertForfeitInvoices(before.invoices,after.invoices);
    assert.equal(Number(response.termination.kept_paid_amount),50000);
    assert.equal(Number(response.termination.forfeit_amount),1000000);
    assert.equal(Number(response.termination.extra_charges_total),75000);
    const pair=after.vouchers.filter(v=>['termination.forfeit_offset','termination.forfeit_revenue'].includes(v.system_source));
    assert.equal(pair.length,2);
    assert(pair.every(v=>v.approval_status==='APPROVED' && v.posting_mode==='NON_CASH' && v.is_virtual && Number(v.total_amount)===1000000));
    assert.equal(cash(after),cash(before));
    assert.equal(sum(before.credit,'remaining_amount'),50000,'Positive CREDIT fixture required');
    assert.equal(sum(after.credit,'remaining_amount'),0,'Credit consumed by FORFEIT');
    assert.equal(Number(response.credit.applied_amount),50000);
    const corrupted=structuredClone(after.invoices);corrupted.find(v=>v.id===invoiceIds[0]).status='APPROVED';
    assert.throws(()=>assertForfeitInvoices(before.invoices,corrupted),/cancellation/);
  } else {
    assert.equal(debt(after),name==='DEBT'?500000:0);
    assert.equal(cash(after)-cash(before),name==='PAID'?500000:0);
    const receipt=after.vouchers.filter(v=>v.system_source==='termination.extra_receipt');
    assert.equal(receipt.length,name==='PAID'?1:0);
    if(name==='PAID'){
      assert.equal(Number(receipt[0].total_amount),500000);
      assert.equal(receipt[0].approval_status,'APPROVED');
      assert.equal(receipt[0].posting_status,'POSTED');
      assert.equal(receipt[0].posting_mode,'CASHBOOK');
      assert.equal(receipt[0].is_virtual,false);
    }
    const newPayments=after.payments.filter(p=>!before.payments.some(b=>b.id===p.id));
    assert(newPayments.length>0 && newPayments.every(p=>p.payment_method==='CT'),'Settlement debt must be cleared through CT only');
    assert.equal(sum(newPayments,'amount'),name==='DEBT'?1000000:amounts[0]);
    if(name==='REFUND'){
      const refund=after.vouchers.filter(v=>v.system_source==='termination.refund');
      assert.equal(refund.length,1);assert.equal(Number(refund[0].total_amount),800000);
      assert.equal(refund[0].approval_status,'UNAPPROVED');assert.equal(refund[0].no_account,true);
    }
  }
  at('idempotency-retry');assert.deepEqual(await call(),response);
  assert.equal(digest(await snapshot(q,contract)),digest(after),'Retry changed financial sources');
  at('idempotency-payload-conflict');await q('SAVEPOINT payload_conflict');
  let code;try{await call(true);}catch(e){code=e.code;}finally{await query('ROLLBACK TO SAVEPOINT payload_conflict');}
  assert.equal(code,'23505');
  assert.equal(digest(await snapshot(q,contract)),digest(after));
  let approval;
  if(name==='REFUND'){
    at('refund-approval-boundary');const v=after.vouchers.find(v=>v.system_source==='termination.refund');
    await q('SAVEPOINT approval_boundary');
    try{await scalar('SELECT public.approve_income_expense_v2($1,$2,$3) AS v',[v.id,v.approval_version,key+':approve']);approval={status:'UNEXPECTED_SUCCESS'};}
    catch(e){approval={status:'REJECTED',sqlstate:e.code};}
    finally{await query('ROLLBACK TO SAVEPOINT approval_boundary');}
    assert.equal(approval.status,'REJECTED');assert.equal(approval.sqlstate,'55000');
    assert.equal(digest(await snapshot(q,contract)),digest(after));
    approval.writer='approve_income_expense_v2';
    approval.meaning='V2 boundary rejection only; not proof of current UI approval path';
    at('refund-current-ui-approval');
    await q('SAVEPOINT ui_approval');
    let uiCode;
    try{await scalar('SELECT public.approve_pending_income_expense_checked_v1($1,$2) AS v',[v.id,v.approval_version]);}
    catch(e){uiCode=e.code;}
    finally{await query('ROLLBACK TO SAVEPOINT ui_approval');}
    assert.equal(uiCode,'P0001','Current UI writer must reject missing refund cashbook');
    assert.equal(digest(await snapshot(q,contract)),digest(after));
    approval.currentUi={writer:'approve_pending_income_expense_checked_v1',sqlstate:uiCode,condition:'NO_REFUND_CASHBOOK',effects:0};
  }
  return Object.assign(evidence,{deltas:{realCash:cash(after)-cash(before),receivable:debt(after)-debt(before)},retry:'SAME_RESPONSE_ZERO_EFFECT',payloadConflict:'23505',...(approval?{approval}:{}),...(name==='FORFEIT'?{sourceMutationOracle:'COPIED_RESULT_CANCELLATION_REJECTED'}:{})});
}
