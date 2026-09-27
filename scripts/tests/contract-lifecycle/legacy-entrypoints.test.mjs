import test from 'node:test';
import assert from 'node:assert/strict';
import {assertEligibilityDenied,assertApprovalSources,observeLegacyApprovalCalls} from '../../contract-lifecycle/legacy-entrypoints.mjs';

const deferred=()=>{
  let resolve,reject;
  const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
};
const nextTurn=()=>new Promise(resolve=>setImmediate(resolve));
for(const failure of ['poll','holder','poll-and-holder'])test(`${failure} failure drains both started RPCs before cleanup`,async()=>{
  const first=deferred(),second=deferred(),holder=deferred();
  const pollError=new Error('poll failed'),holderError=new Error('holder failed'),events=[];
  const expected=failure==='holder'?holderError:pollError;
  const calls=Promise.allSettled([
    first.promise.finally(()=>events.push('first-settled')),
    second.promise.finally(()=>events.push('second-settled')),
  ]);
  const run=(async()=>{
    try{return await observeLegacyApprovalCalls({
      holder:holder.promise,calls,
      unlock:()=>{events.push('holder-released');failure.includes('holder')?holder.reject(holderError):holder.resolve();},
      pollWaiters:async()=>{if(failure.includes('poll'))throw pollError;return 2;},
    });}finally{events.push('cleanup-started');}
  })();
  // Observe rejection immediately without letting it end the test before draining.
  const outcome=run.then(value=>({value}),error=>({error}));
  try {
    await nextTurn();assert.deepEqual(events,['holder-released'],'Cleanup must wait for both pending calls');
    first.resolve('first');await nextTurn();
    assert.deepEqual(events,['holder-released','first-settled'],'Cleanup must wait for the last call too');
    second.reject(new Error('second RPC failed'));
    const result=await outcome;
    assert.equal(result.error?.cause??result.error,expected,'Original observation failure retained');
    const expectedErrors=failure==='poll-and-holder'?[pollError,holderError]:[expected];
    assert.deepEqual(result.error.errors,expectedErrors,'One failure cannot overwrite another');
    assert.deepEqual(events,['holder-released','first-settled','second-settled','cleanup-started']);
  } finally {first.resolve();second.resolve();holder.resolve();await outcome;}
});
test('successful observation still waits for the holder and returns both settled RPC outcomes',async()=>{
  const holder=deferred(),rpcError=new Error('RPC failed');let released=false;
  const run=observeLegacyApprovalCalls({holder:holder.promise,unlock:()=>{released=true;},calls:Promise.allSettled([Promise.resolve('approved'),Promise.reject(rpcError)]),pollWaiters:async()=>2});
  let finished=false;run.then(()=>{finished=true;});
  await nextTurn();assert.equal(released,true);assert.equal(finished,false);
  holder.resolve();
  assert.deepEqual(await run,{waiters:2,results:[{status:'fulfilled',value:'approved'},{status:'rejected',reason:rpcError}]});
});

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
