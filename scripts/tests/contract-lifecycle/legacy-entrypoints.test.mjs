import test from 'node:test';
import assert from 'node:assert/strict';
import {assertEligibilityDenied,assertApprovalSources} from '../../contract-lifecycle/legacy-entrypoints.mjs';

const before={contracts:[{id:'contract',status:'TERMINATED'}],terminations:[{id:'term',status:'DRAFT'}],rooms:[{id:'room',status:'AVAILABLE'}],vouchers:[],items:[],postings:[],invoices:[],credits:[]};
test('ended-entry oracle rejects success and every observed side-effect family',()=>{
  assertEligibilityDenied({before,after:structuredClone(before),sqlstate:'55000'});
  assert.throws(()=>assertEligibilityDenied({before,after:before,sqlstate:undefined}),/eligibility/);
  for(const family of Object.keys(before)) {
    const after=structuredClone(before);after[family].push({id:'unexpected'});
    assert.throws(()=>assertEligibilityDenied({before,after,sqlstate:'55000'}),/zero effects/);
  }
  assert.throws(()=>assertEligibilityDenied({before:{contracts:[],terminations:[],rooms:[]},after:{contracts:[],terminations:[],rooms:[]},sqlstate:'55000'}),/Nonempty/);
});
function observedNegative(){
  const source=structuredClone(before);source.contracts[0].status='ACTIVE';
  const after=structuredClone(before);after.terminations[0].status='COMPLETED';
  after.vouchers=[{id:'voucher',type:'INCOME',total_amount:'100.00',approval_status:'UNAPPROVED',posting_status:'UNPOSTED',posting_mode:'CASHBOOK',system_source:null,account_id:null}];
  after.items=[{id:'item',income_expense_id:'voucher',amount:'100.00'}];
  return {before:source,after,response:{refund_amount:-100,refund_capped:false,voucher_id:'voucher'},want:-100,capped:false};
}
test('observed legacy negative approval requires actual pending voucher and item sources',()=>{
  assertApprovalSources(observedNegative());
  const mutations=[s=>s.after.vouchers=[],s=>s.response.voucher_id='other',s=>s.after.vouchers[0].total_amount='101',s=>s.after.vouchers[0].approval_status='APPROVED',s=>s.after.vouchers[0].account_id='cash',s=>s.after.items=[],s=>s.after.items[0].amount='99',s=>s.after.postings.push({voucher_id:'voucher'}),s=>s.after.contracts[0].status='ACTIVE',s=>s.after.terminations[0].status='DRAFT'];
  for(const mutate of mutations){const sample=observedNegative();mutate(sample);assert.throws(()=>assertApprovalSources(sample));}
});
