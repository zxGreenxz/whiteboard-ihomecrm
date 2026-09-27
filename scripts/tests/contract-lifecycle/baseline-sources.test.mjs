import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as fixture from './financial-fixture.mjs';

// Copied-result oracle sensitivity tests only: these are not live DB proofs.
const artifact=JSON.parse(readFileSync(new URL('../../../docs/generated/contract-lifecycle/2026-09-27T17-33-55.965Z-financial-baseline.json',import.meta.url),'utf8'));
function sample(name) {
  const s=structuredClone(artifact.scenarios.find(s=>s.name===name));
  const source=kind=>s.after.vouchers.find(v=>v.system_source===kind)?.id;
  // Historical evidence did not save the response; reconstruct its source pointers
  // from the observed rows for this local copied-result test only.
  s.response={termination:{
    extra_invoice_id:s.after.invoices.find(i=>Number(i.total_amount)===75000)?.id,
    settlement_invoice_id:s.after.invoices.find(i=>Number(i.total_amount)===1000000)?.id,
    pending_expense_voucher_id:source('termination.forfeit_offset'),
    pending_income_voucher_id:source('termination.forfeit_revenue'),
    refund_voucher_id:source('termination.refund'),
  }};
  return s;
}
const check=s=>fixture.assertSettlementSources(s.name,s.before,s.after,s.response);
test('observed nonempty source snapshots satisfy the shared live oracle',()=>{
  assert.equal(typeof fixture.assertSettlementSources,'function');
  check(sample('FORFEIT')); check(sample('REFUND'));
});
const extra=s=>s.after.invoices.find(i=>i.id===s.response.termination.extra_invoice_id);
const refund=s=>s.after.vouchers.find(v=>v.system_source==='termination.refund');
const offset=s=>s.after.vouchers.find(v=>v.system_source==='termination.forfeit_offset');
const cases=[
  ['FORFEIT','missing extra invoice',s=>{s.after.invoices=s.after.invoices.filter(i=>i!==extra(s));}],
  ['FORFEIT','wrong extra amount',s=>{extra(s).total_amount='0';}],
  ['FORFEIT','wrong extra remaining debt',s=>{extra(s).remaining_amount='0';}],
  ['FORFEIT','wrong extra status',s=>{extra(s).status='PAID';}],
  ['FORFEIT','wrong extra kind',s=>{extra(s).kind='MONTHLY';}],
  ['FORFEIT','rekey extra invoice',s=>{extra(s).id='rekeyed';}],
  ['FORFEIT','duplicate extra invoice',s=>{s.after.invoices.push({...extra(s)});}],
  ['FORFEIT','missing credit lot',s=>{s.after.credit=[];}],
  ['FORFEIT','rekey credit lot',s=>{s.after.credit[0].id='rekeyed';}],
  ['FORFEIT','duplicate credit lot',s=>{s.after.credit.push({...s.after.credit[0]});}],
  ['FORFEIT','changed original credit amount',s=>{s.after.credit[0].amount='0';}],
  ['FORFEIT','unconsumed credit status',s=>{s.after.credit[0].status='ACTIVE';}],
  ['FORFEIT','duplicate offset instead of revenue',s=>{s.after.vouchers.find(v=>v.system_source==='termination.forfeit_revenue').system_source='termination.forfeit_offset';}],
  ['FORFEIT','wrong offset type',s=>{offset(s).type='INCOME';}],
  ['FORFEIT','wrong pair posting status',s=>{offset(s).posting_status='UNPOSTED';}],
  ['FORFEIT','missing virtual source',s=>{offset(s).no_account=true;offset(s).is_virtual=null;}],
  ['FORFEIT','rekey offset',s=>{offset(s).id='rekeyed';}],
  ['REFUND','noncash refund',s=>{refund(s).posting_mode='NON_CASH';refund(s).posting_status='NOT_APPLICABLE';}],
  ['REFUND','wrong refund posting status',s=>{refund(s).posting_status='POSTED';}],
  ['REFUND','wrong refund type',s=>{refund(s).type='INCOME';}],
  ['REFUND','missing refund',s=>{s.after.vouchers=s.after.vouchers.filter(v=>v!==refund(s));}],
  ['REFUND','duplicate refund',s=>{s.after.vouchers.push({...refund(s)});}],
  ['REFUND','rekey refund',s=>{refund(s).id='rekeyed';}],
];
for(const [name,label,mutate] of cases) test(`copied-result rejects ${label}`,()=>{
  assert.equal(typeof fixture.assertSettlementSources,'function');
  const s=sample(name);check(s);mutate(s);assert.throws(()=>check(s),assert.AssertionError);
});
