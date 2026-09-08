// Bounded, SELECT-only verifier. Default reports readiness; --after asserts deployed state.
// Output deliberately omits full snapshots, names, phones and tenant details.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { runQuery } from './lib/v5-collection-harness.mjs';

const migration = readFileSync(new URL('../supabase/migrations/20260908052713_repair_invoice_deposit_classification_history.sql',import.meta.url),'utf8');
const manifest = JSON.parse(migration.match(/v_manifest constant jsonb := '([^']+)'/)[1]);
const literal = value=>"'"+String(value).replaceAll("'","''")+"'";
const query = `WITH cohort AS (
 SELECT * FROM jsonb_to_recordset(${literal(JSON.stringify(manifest))}::jsonb) m(invoice_id uuid,item_id uuid,contract_id uuid,voucher_id uuid,payment_id uuid,collection_id uuid,deposit numeric,total numeric)
), audited AS (
 SELECT c.*,a.before_snapshot,a.after_snapshot,a.details FROM cohort c LEFT JOIN public.accounting_repair_audit a
 ON a.entity_type='invoice' AND a.entity_id=c.invoice_id AND a.organization_id='aaaa0000-0000-4000-8000-000000000001'
 AND a.repair_code='INVOICE_DEPOSIT_CLASS_HISTORY_20260908'
), measured AS (
 SELECT a.*,i.invoice_number,it.accounting_class,v.total_amount,v.kqkd_amount,
 (SELECT COALESCE(sum(x.amount),0) FROM public.income_expense_items x WHERE x.income_expense_id=a.voucher_id AND x.accounting_class='DEPOSIT') deposit_now,
 (SELECT COALESCE(sum(x.amount),0) FROM public.income_expense_items x WHERE x.income_expense_id=a.voucher_id AND x.accounting_class='PNL') pnl_now,
 jsonb_build_object(
 'payments',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM public.payments p WHERE p.invoice_id=a.invoice_id),
 'postings',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM public.income_expense_postings p WHERE p.voucher_id=a.voucher_id),
 'posting_lines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM public.income_expense_posting_lines l WHERE l.posting_id IN(SELECT p.id FROM public.income_expense_postings p WHERE p.voucher_id=a.voucher_id)),
 'collection',(SELECT to_jsonb(c) FROM public.invoice_payment_collections c WHERE c.id=a.collection_id),
 'tenders',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.invoice_payment_tenders t WHERE t.collection_id=a.collection_id),
 'ownership',(SELECT to_jsonb(o) FROM app_private.income_expense_flow_ownership o WHERE o.income_expense_id=a.voucher_id),
 'components',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM public.finance_invoice_components c WHERE c.invoice_id=a.invoice_id),
 'termination',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.contract_terminations t WHERE t.contract_id=a.contract_id),
 'other_vouchers',(SELECT jsonb_agg(to_jsonb(v) ORDER BY v.id) FROM public.income_expenses v WHERE v.contract_id=a.contract_id AND v.id<>a.voucher_id),
 'obligations',(SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id) FROM public.termination_refund_obligations o WHERE o.contract_id=a.contract_id),
 'manifests',(SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) FROM public.finance_invoice_component_manifests m WHERE m.invoice_id=a.invoice_id)
 ) stable_now,
 to_jsonb(v)-ARRAY['updated_at','kqkd_amount','counts_in_business_result','has_restricted_item'] header_cash_now
 FROM audited a JOIN public.invoices i ON i.id=a.invoice_id JOIN public.invoice_items it ON it.id=a.item_id JOIN public.income_expenses v ON v.id=a.voucher_id
 WHERE i.organization_id='aaaa0000-0000-4000-8000-000000000001' AND v.organization_id=i.organization_id
), contracts AS (
 SELECT label,expected,app_private.commission_contract_facts_v1(id) facts,
 (SELECT COALESCE(sum(s.signed_amount) FILTER(WHERE s.bucket<>'EXCLUDED'),0) FROM app_private.contract_deposit_sources_v1('aaaa0000-0000-4000-8000-000000000001',id,now()) s) basis
 FROM (VALUES ('501',4200000::numeric,'6d504199-ed9c-467a-ac5f-c8cac680f544'::uuid),
 ('305',3600000::numeric,'890c9f1b-554d-44be-be2a-7bbd375e1379'::uuid),
 ('505',4926000::numeric,'ee266051-f0ae-441b-9ecc-8e033818f0ed'::uuid)) c(label,expected,id)
), cash_before AS (
 SELECT (l.value->>'account_id')::uuid account_id,sum((l.value->>'signed_amount')::numeric) amount
 FROM audited a CROSS JOIN LATERAL jsonb_array_elements(a.before_snapshot->'posting_lines') l(value)
 JOIN public.accounts acc ON acc.id=(l.value->>'account_id')::uuid AND NOT COALESCE(acc.is_virtual,false)
 GROUP BY 1
), cash_now AS (
 SELECT l.account_id,sum(l.signed_amount) amount FROM public.income_expense_posting_lines l
 JOIN public.income_expense_postings p ON p.id=l.posting_id JOIN cohort c ON c.voucher_id=p.voucher_id
 JOIN public.accounts acc ON acc.id=l.account_id AND NOT COALESCE(acc.is_virtual,false) GROUP BY 1
)
SELECT jsonb_build_object(
 'audit_count',(SELECT count(*) FROM audited WHERE before_snapshot IS NOT NULL),
 'audit_deposit_total',(SELECT COALESCE(sum((details->>'deposit_amount')::numeric),0) FROM audited),
 'invoices',(SELECT jsonb_agg(jsonb_build_object('invoice',invoice_number,'class',accounting_class,'total',total_amount,
   'deposit',deposit_now,'pnl',pnl_now,'kqkd',kqkd_amount,
   'classification_ok',accounting_class='DEPOSIT' AND deposit_now=deposit AND pnl_now=total-deposit AND total_amount=total AND kqkd_amount=total-deposit,
   'snapshot_invariants_ok',before_snapshot IS NOT NULL AND stable_now=before_snapshot-ARRAY['invoice','invoice_item','voucher','items']
     AND header_cash_now=(before_snapshot->'voucher')-ARRAY['updated_at','kqkd_amount','counts_in_business_result','has_restricted_item']
 ) ORDER BY invoice_number) FROM measured),
 'contracts',(SELECT jsonb_agg(jsonb_build_object('room',label,'deposit',facts->'deposit_paid','net_held',basis,
   'shortfall',(facts->>'total_deposit')::numeric-(facts->>'deposit_paid')::numeric,'deposit_enough',facts->'deposit_enough',
   'seven_days_date',facts->'seven_days_date','seven_days_ok',facts->'seven_days_ok',
   'expected_ok',(facts->>'deposit_paid')::numeric=expected AND basis=expected)) FROM contracts),
 'affected_real_cash',(SELECT jsonb_agg(jsonb_build_object('account_id',COALESCE(b.account_id,n.account_id),'before',b.amount,'now',n.amount,
   'unchanged',b.amount IS NOT DISTINCT FROM n.amount)) FROM cash_before b FULL JOIN cash_now n USING(account_id)),
 'settlement',(SELECT jsonb_build_object('status',t.status,'refund',t.refund_amount,'rent_refund',t.rent_refund_amount,
   'pending_refund_amount',v.total_amount,'pending_approval',v.approval_status,'pending_posting',v.posting_status,
   'open_exception_count',(SELECT count(*) FROM public.accounting_integrity_exceptions e WHERE e.entity_id=t.contract_id
     AND e.organization_id=t.organization_id AND e.exception_code='RESTORED_DEPOSIT_REQUIRES_SETTLEMENT_REVIEW' AND e.status='OPEN'))
   FROM public.contract_terminations t CROSS JOIN public.income_expenses v WHERE t.id='5489bd49-b982-4157-a436-cf5a45e567d6'
   AND v.id='f773c0ab-04e8-42a5-883e-be881e95529d')
) result;`;
if(process.argv.includes('--sql')) {writeFileSync('.tmp/history-verifier.sql',query);process.exit(0);}
const rows=await runQuery(query);
const result=rows[0]?.result;
console.log(JSON.stringify({mode:process.argv.includes('--after')?'after':'readiness',...result},null,2));
if(process.argv.includes('--after')) {
 assert.equal(result.audit_count,4); assert.equal(result.audit_deposit_total,11300000);
 assert.equal(result.invoices.length,4);
 for(const invoice of result.invoices) {assert.equal(invoice.classification_ok,true,invoice.invoice);assert.equal(invoice.snapshot_invariants_ok,true,invoice.invoice);}
 for(const contract of result.contracts) assert.equal(contract.expected_ok,true,contract.room);
 assert.equal(result.contracts.find(x=>x.room==='505').shortfall,74000);
 assert.ok(result.affected_real_cash.length>0);
 for(const account of result.affected_real_cash) assert.equal(account.unchanged,true,account.account_id);
 assert.deepEqual(result.settlement,{status:'COMPLETED',refund:-58500,rent_refund:1950000,pending_refund_amount:1891500,pending_approval:'UNAPPROVED',pending_posting:'UNPOSTED',open_exception_count:1});
 console.log('PASS: exact history cohort, cash invariants, deposit basis and preserved settlement');
}
