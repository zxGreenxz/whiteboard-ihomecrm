import test from 'node:test';
import assert from 'node:assert/strict';
import { SALE_ACTION_TOOLS, saleActionInput, saleActionResult, mayUseSaleAction } from './sale-action-contract.mjs';
import { createPublicTextGuard, splitConfirmToken } from './public-text-guard.mjs';
import { createSaleActionReads } from './sale-action-adapter.mjs';
const id = c => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`;
const roomId=id('a'),requestId=id('b'),buildingId=id('c'),organizationId=id('d'),userId=id('e');
const patch={requestId,roomId,expectedRevision:'a'.repeat(32),sale_note:'Miễn phí wifi'};
test('sale patch bounds and permission distinction never broadens image grant',()=>{
 assert.equal(SALE_ACTION_TOOLS.length,10);
 assert.deepEqual(saleActionInput('patch',patch),patch);
 for(const extra of [{status:'free'},{organizationId},{rent_price:-1},{area:1.234},{sale_note:'x'.repeat(2001)},{images:['http://example.invalid/a']}])
  assert.throws(()=>saleActionInput('patch',{...patch,...extra}));
 assert.throws(()=>saleActionInput('patch',{requestId,roomId,expectedRevision:'b'.repeat(64)}));
 const images={action:['sale_phong.manage_images']};
 assert.equal(mayUseSaleAction(images,'patch'),true);
 assert.equal(mayUseSaleAction(images,'patch',{requestId,roomId,expectedRevision:'b'.repeat(32),images:[]}),true);
 assert.equal(mayUseSaleAction(images,'patch',patch),false);
 assert.equal(mayUseSaleAction({action:['sale_phong.lock_room']},'observe'),false);
 assert.equal(mayUseSaleAction({action:['deposits.create']},'reservation_create'),false);
 assert.equal(mayUseSaleAction({action:['deposits.create','income_expenses.create']},'reservation_create'),true);
});
test('public amenities and sale text require exact one-use confirmation; private note does not',()=>{
 const guard=createPublicTextGuard({clock:()=>1000});
 for(const input of [patch,{requestId,roomId,expectedRevision:'a'.repeat(32),amenities:['Máy lạnh']}]){
  const result=guard.review('connection','crm_sale_room_patch',input);
  assert.equal(result.confirmation.applied,false);
  const split=splitConfirmToken('crm_sale_room_patch',{...input,confirmToken:result.confirmation.confirmToken});
  assert.deepEqual(split.args,input);
  assert.deepEqual(guard.review('connection','crm_sale_room_patch',input,split.confirmToken),{allow:true});
  assert.deepEqual(guard.review('connection','crm_sale_room_patch',input,split.confirmToken),{refused:true});
 }
 assert.deepEqual(guard.review('connection','crm_sale_room_patch',{...patch,sale_note:null,sale_bonus_note:'Nội bộ'}),{allow:true});
 const confirm=guard.review('connection','crm_sale_room_patch',patch).confirmation;
 assert.deepEqual(guard.review('another','crm_sale_room_patch',patch,confirm.confirmToken),{refused:true});
});
test('deposit input preserves receipt semantics and rejects no-money/create and cancellation',()=>{
 const receipt={amount:2000000,accountId:null,voucherDate:'2026-10-21',name:null,description:null};
 const input={requestId,roomId,customerId:null,customerHint:'Anh A',intendedMoveInOn:null,topupDueOn:null,depositTarget:3000000,notes:null,receipt};
 assert.deepEqual(saleActionInput('reservation_create',input),input);
 assert.throws(()=>saleActionInput('reservation_create',{...input,receipt:null}));
 assert.throws(()=>saleActionInput('reservation_create',{...input,customerId:userId}));
 assert.throws(()=>saleActionInput('reservation_topup',{requestId,reservationId:roomId,expectedRevision:1,receipt:{...receipt,voucherDate:'2026-02-30'}}));
 assert.throws(()=>saleActionInput('reservation_cancel',{requestId,reservationId:roomId,expectedRevision:1}));
});
test('receipt/result validators bind organization, scope, exact privacy and received independent of approved',()=>{
 const identity={row:{organizationId,userId},effective:{action:['deposits.create','income_expenses.create','rooms.edit']},
  scopesByPermission:{'deposits.create':{buildingIds:[buildingId]},'rooms.edit':{buildingIds:[buildingId]}}};
 const result={organizationId,requestId,operation:'reservation_create',outcome:'applied',receipt:{id:roomId,roomId,buildingId,revision:1,state:'HOLD',
  receivedAmount:0,receipts:[{voucherId:userId,amount:2000000,received:false,approvalStatus:'APPROVED'}],expiresAt:null,fields:[]}};
 assert.equal(saleActionResult('status',result,identity,{requestId}).receipt.receivedAmount,0);
 assert.throws(()=>saleActionResult('status',{...result,organizationId:userId},identity,{requestId}));
 assert.throws(()=>saleActionResult('status',{...result,receipt:{...result.receipt,customerPhone:'secret'}},identity,{requestId}));
 assert.throws(()=>saleActionResult('status',result,{...identity,scopesByPermission:{}},{requestId}));
 assert.throws(()=>saleActionResult('observe',{organizationId,room:{id:roomId,buildingId,revision:'a'.repeat(32),updatedAt:null,fields:{sale_note:'secret'}}},
  {...identity,effective:{action:['sale_phong.manage_images']},scopesByPermission:{'sale_phong.manage_images':{buildingIds:[buildingId]}}},{roomId}));
});
test('transport has one fixed caller-JWT endpoint and never retries unknown write ACK',async()=>{
 const accessToken=['header',Buffer.from(JSON.stringify({role:'authenticated',sub:userId,session_id:userId})).toString('base64url'),'signature'].join('.');
 const binding={connectionId:userId,tokenDigest:'f'.repeat(64),expectedEpoch:1,expectedPolicyVersion:1,expectedMembershipId:userId,expectedAuthorizationVersion:1,expectedSessionRevision:1};
 let calls=0,dispatched=0,rejected=0;
 const reads=createSaleActionReads({url:'https://example.invalid/',publishableKey:'sb_publishable_test',dependencyScope:{track:f=>f()},fetch:async(url,options)=>{
  calls++;assert.equal(url,'https://example.invalid/rest/v1/rpc/hermes_sale_actions_v1');
  assert.equal(options.headers.authorization,'Bearer '+accessToken);assert.equal(JSON.parse(options.body).p_operation,'lock');
  throw new Error('lost_ACK');
 }});
 await assert.rejects(()=>reads.execute('lock',{accessToken,binding,input:{requestId,roomId,hours:6,note:null}},
  {signal:new AbortController().signal,onDispatch:()=>dispatched++,onRejected:()=>rejected++}),/lost_ACK/);
 assert.equal(calls,1);assert.equal(dispatched,1);assert.equal(rejected,0);
});
