// Shared assertions for copied synthetic evidence and the explicit live runner.
import assert from 'node:assert/strict';
// The live runner's bounded lock-observation region; calls is already allSettled.
export async function observeLegacyApprovalCalls({holder,unlock,calls,pollWaiters}) {
  // Observe both promises immediately; a holder rejection must never skip RPC drain.
  const settled=Promise.allSettled([holder,calls]),failures=[];
  let waiters,outcomes;
  try {waiters=await pollWaiters();}
  catch(error){failures.push({stage:'poll',error});}
  finally {
    try {unlock();}catch(error){failures.push({stage:'release',error});}
    outcomes=await settled;
  }
  for(const [index,stage]of ['holder','calls'].entries()) {
    if(outcomes[index].status==='rejected')failures.push({stage,error:outcomes[index].reason});
  }
  if(failures.length) {
    const error=new AggregateError(failures.map(f=>f.error),'Legacy approval concurrency failed',{cause:failures[0].error});
    error.failures=failures;
    throw error;
  }
  return {waiters,results:outcomes[1].value};
}
export function assertEligibilityDenied({before,after,sqlstate}) {
  assert.equal(sqlstate,'55000','Ended contract must reject new approval with eligibility SQLSTATE');
  assert(before.contracts.length>0&&before.terminations.length>0&&before.rooms.length>0,'Nonempty fixture roots required');
  assert.deepEqual(after,before,'Denied approval must have zero effects');
}
export function assertApprovalSources({before,after,response,want,capped}) {
  assert.equal(before.contracts.length,1);assert.equal(before.terminations.length,1);assert.equal(after.contracts.length,1);
  assert.equal(response.refund_amount,want);assert.equal(response.refund_capped,capped);
  assert.equal(after.contracts[0].status,'TERMINATED');assert.equal(after.terminations[0].status,'COMPLETED');
  assert.equal(after.rooms[0].status,'AVAILABLE');
  const vouchers=after.vouchers.filter(v=>!before.vouchers.some(b=>b.id===v.id));
  assert.equal(vouchers.length,want===0?0:1,'Exact new financial source count');
  if(want===0)assert.equal(response.voucher_id,null);
  else {
    const v=vouchers[0];assert.equal(v.id,response.voucher_id,'Writer source identity');
    assert.equal(v.type,want>0?'EXPENSE':'INCOME');assert.equal(Number(v.total_amount),Math.abs(want));
    assert.equal(v.approval_status,'UNAPPROVED');assert.equal(v.posting_status,'UNPOSTED');assert.equal(v.posting_mode,'CASHBOOK');
    assert.equal(v.system_source,null);assert.equal(v.account_id,null);
    const items=after.items.filter(i=>i.income_expense_id===v.id);assert.equal(items.length,1);assert.equal(Number(items[0].amount),Math.abs(want));
    assert.equal(after.postings.filter(p=>p.voucher_id===v.id).length,0,'Pending legacy approval cannot move cash');
  }
}
