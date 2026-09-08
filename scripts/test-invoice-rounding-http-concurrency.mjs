#!/usr/bin/env node
// Post-deploy only. Real JWT / two independent PostgREST requests, DEMO fixtures.
// Run with --execute only after the reviewed rounding migration is permanently applied.
// Uses IHOMECRM_SECRET_FILE (PAT), IHOMECRM_DEMO_PASSWORD or FLEET_PASS_CHUNHA,
// and VITE_SUPABASE_PUBLISHABLE_KEY (or the local .env public key). Never logs tokens.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadSupabaseAdminConfig } from './apply-accounting-rollout.mjs';
import { DEMO_ORG_ID, DEMO_OWNER_EMAIL, runQuery, fixtureInvoiceSql,
  committedFixtureTeardownSql, fixtureMarker, newRunId, sqlLiteral, uuidLiteral } from './lib/v5-collection-harness.mjs';

if (!process.argv.includes('--execute')) {
  console.log('Prepared only. Add --execute after confirmed permanent rounding deployment.');
  process.exit(0);
}
const config=loadSupabaseAdminConfig({readFile:(p,e)=>readFileSync(
  String(p).includes('CLAUDE.local.md') && process.env.IHOMECRM_SECRET_FILE ? process.env.IHOMECRM_SECRET_FILE : p,e)});
const query=sql=>runQuery(sql,config);
const origin=`https://${config.projectRef}.supabase.co`;
const localEnv=readFileSync(new URL('../.env',import.meta.url),'utf8');
const key=process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? localEnv.match(/^VITE_SUPABASE_PUBLISHABLE_KEY=["']?([^"'\r\n]+)/m)?.[1];
const password=process.env.IHOMECRM_DEMO_PASSWORD ?? process.env.FLEET_PASS_CHUNHA;
assert(key && password,'Missing public API key or DEMO owner password; no fixture created');
const pre=(await query(`SELECT
 md5(pg_get_functiondef('public.record_invoice_collection_v5(uuid,date,jsonb,text,boolean,text,text,numeric,text)'::regprocedure)) AS writer,
 app_private.evaluate_feature_route('invoice.collection.v5','${DEMO_ORG_ID}') AS writer_route,
 app_private.evaluate_feature_route('invoice.collection.reverse.v5','${DEMO_ORG_ID}') AS reverse_route,
 (SELECT id FROM auth.users WHERE email=${sqlLiteral(DEMO_OWNER_EMAIL)}) AS actor_id,
 public.org_today_v1('${DEMO_ORG_ID}') AS today;`))[0];
assert.equal(pre.writer,'2e1a40ef39d7a373dcdba3e83a0e60f5','Reviewed rounding writer is not deployed');
assert.equal(pre.writer_route,'CANONICAL'); assert.equal(pre.reverse_route,'CANONICAL');
const login=await fetch(`${origin}/auth/v1/token?grant_type=password`,{method:'POST',
 headers:{apikey:key,'Content-Type':'application/json'},body:JSON.stringify({email:DEMO_OWNER_EMAIL,password}),signal:AbortSignal.timeout(30000)});
assert(login.ok,`DEMO authentication failed (${login.status}); no fixture created`);
const session=await login.json();
assert.equal(session.user?.id,pre.actor_id,'JWT must belong to the DEMO owner');
const token=session.access_token;
async function rpc(name,body){
 const response=await fetch(`${origin}/rest/v1/rpc/${name}`,{method:'POST',
  headers:{apikey:key,Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
  body:JSON.stringify(body),signal:AbortSignal.timeout(45000)});
 const data=await response.json();
 return {ok:response.ok,status:response.status,data};
}
const run=newRunId(),marker=fixtureMarker(`rounding-http-${run}`),month='2095-08';
let fixture;
try {
 const rows=await query(`BEGIN; SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='60s';
 ${fixtureInvoiceSql({marker,billingMonth:month,rent:3008000,deposit:0})}
 INSERT INTO public.cashbook_possession_bindings(organization_id,cashbook_id,membership_id,possession_kind,valid_from,reason)
 SELECT m.organization_id,current_setting('v5h.account_tm')::uuid,m.id,'KNOWER',now()-interval '1 minute',${sqlLiteral(marker)}
 FROM public.organization_memberships m WHERE m.organization_id='${DEMO_ORG_ID}'
 AND m.user_id=current_setting('v5h.actor')::uuid AND m.status='ACTIVE'
 AND NOT app_private.ie_has_cashbook_possession_v1(m.organization_id,current_setting('v5h.account_tm')::uuid,m.id);
 SELECT current_setting('v5h.actor') AS actor_id,current_setting('v5h.invoice') AS invoice_id,
 current_setting('v5h.building') AS building_id,current_setting('v5h.account_tm') AS account_id,
 current_setting('v5h.virtual_account') AS virtual_id;
 COMMIT;`);
 fixture=rows.find(r=>r.invoice_id); assert(fixture,'Fixture result missing');
 assert.equal(fixture.actor_id,pre.actor_id);
 const payload={p_invoice_id:fixture.invoice_id,p_collection_date:pre.today,
  p_tenders:[{payment_method:'TM',gross_amount:3200000,requested_change_amount:200000,
   account_id:fixture.account_id,change_account_id:fixture.virtual_id,rounding_account_id:fixture.virtual_id}],
  p_overpay_action:'REFUND',p_allow_rounding:true,p_notes:marker,p_receipt_image_url:null,p_expected_paid_amount:0};
 for(const scenario of ['same-key','different-key']){
  const keyA=`rounding-http-${run}-${scenario}-a`,keyB=scenario==='same-key'?keyA:`rounding-http-${run}-${scenario}-b`;
  const pair=await Promise.all([rpc('record_invoice_collection_v5',{...payload,p_idempotency_key:keyA}),
   rpc('record_invoice_collection_v5',{...payload,p_idempotency_key:keyB})]);
  const winners=pair.filter(r=>r.ok),losers=pair.filter(r=>!r.ok);
  assert.equal(winners.length,scenario==='same-key'?2:1,`${scenario}: unexpected HTTP winners ${pair.map(r=>r.status)}`);
  if(scenario==='same-key') assert.deepEqual(winners[0].data,winners[1].data,'Concurrent retry changed response');
  else assert(losers.every(r=>r.data.code==='40001' || (r.data.code==='55000' && /Trạng thái.*PAID/.test(r.data.message))),
   'Competing collection failed for an unexpected reason');
  const result=winners[0].data;
  assert.equal(Number(result.applied_amount),3000000);assert.equal(Number(result.change_amount),200000);
  assert.equal(Number(result.rounding_amount),8000);assert.equal(result.invoice.status,'PAID');
  const state=(await query(`SELECT i.paid_amount,
   (SELECT count(*) FROM public.invoice_payment_collections c WHERE c.invoice_id=i.id AND c.status='ACTIVE') AS active,
   (SELECT sum(c.rounding_amount) FROM public.invoice_payment_collections c WHERE c.invoice_id=i.id AND c.status='ACTIVE') AS rounding,
   (SELECT count(*) FROM public.payments p WHERE p.collection_id=${uuidLiteral(result.collection_id)}) AS payments,
   (SELECT sum(l.signed_amount) FROM public.income_expense_posting_lines l
    JOIN public.income_expense_postings p ON p.id=l.posting_id JOIN public.income_expenses ie ON ie.id=p.voucher_id
    JOIN public.accounts a ON a.id=l.account_id
    WHERE ie.payment_collection_id=${uuidLiteral(result.collection_id)} AND NOT a.is_virtual) AS cash
   FROM public.invoices i WHERE i.id=${uuidLiteral(fixture.invoice_id)} AND i.organization_id='${DEMO_ORG_ID}';`))[0];
  assert.equal(Number(state.active),1);assert.equal(Number(state.rounding),8000);
  assert.equal(Number(state.paid_amount),3000000);assert.equal(Number(state.payments),1);assert.equal(Number(state.cash),3000000);
  const reportBody={p_billing_month:month,p_collector_id:fixture.actor_id,p_building_id:fixture.building_id,p_offset:0,p_limit:500};
  const report=await rpc('get_invoice_rounding_report_v1',reportBody);assert(report.ok,'Report HTTP failed');
  const own=report.data.rows.filter(r=>r.invoice_id===fixture.invoice_id);
  assert.equal(own.length,1);assert.equal(Number(own[0].rounding_amount),8000);
  const reversed=await rpc('reverse_invoice_collection_v5',{p_collection_id:result.collection_id,
   p_reversal_date:pre.today,p_reason:'Post-deploy DEMO concurrency cleanup',p_idempotency_key:`rounding-http-${run}-${scenario}-reverse`});
  assert(reversed.ok,`HTTP reversal failed (${reversed.status})`);
  const after=await rpc('get_invoice_rounding_report_v1',reportBody);assert(after.ok);
  assert.equal(after.data.rows.filter(r=>r.invoice_id===fixture.invoice_id).length,0);
  const cash=(await query(`SELECT coalesce(sum(l.signed_amount),0) AS amount FROM public.income_expense_posting_lines l
   JOIN public.income_expense_postings p ON p.id=l.posting_id JOIN public.income_expenses ie ON ie.id=p.voucher_id
   WHERE ie.payment_collection_id=${uuidLiteral(result.collection_id)};`))[0];
  assert.equal(Number(cash.amount),0,'Reversal must neutralize all posting lines');
  console.log(`PASS ${scenario}: independent HTTP requests, one collection/payment, 8000 waiver, one report row, reversal neutralized`);
 }
} finally {
 // Discover by unique marker even when fixture setup committed but its response was lost.
 const existing=(await query(`SELECT i.id,i.user_id FROM public.invoices i WHERE i.organization_id='${DEMO_ORG_ID}' AND i.notes=${sqlLiteral(marker)};`));
 if(existing.length){
  await query(committedFixtureTeardownSql({marker,actorId:pre.actor_id}));
 }
 await query(`DELETE FROM public.cashbook_possession_bindings WHERE organization_id='${DEMO_ORG_ID}' AND reason=${sqlLiteral(marker)};`);
 console.log('DEMO fixture reversed and cleaned; marker-scoped possession binding removed');
}
