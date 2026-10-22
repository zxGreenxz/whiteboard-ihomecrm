import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createBroker, BrokerError } from './broker.mjs';
import { createDependencyScope } from './dependency-scope.mjs';
import { SALE_ACTION_TOOLS } from './sale-action-contract.mjs';
import { SALE_POLICY_TOOLS } from './sale-policy-contract.mjs';
import { SALE_BULK_TOOLS } from './sale-bulk-contract.mjs';
import { SALE_TOOL, saleToolInput, saleToolOperation } from './sale-tool-contract.mjs';

const all = [...SALE_ACTION_TOOLS, ...SALE_POLICY_TOOLS, ...SALE_BULK_TOOLS];
const keys = ['rooms.edit','sale_phong.edit','sale_phong.manage_images','sale_phong.lock_room','deposits.create','deposits.edit','income_expenses.create'];
const room=randomUUID(),requestId=randomUUID(),reservationId=randomUUID(),policyId=randomUUID();
const revision='a'.repeat(32),receipt={amount:1000000,accountId:null,voucherDate:'2026-10-22',name:null,description:null};
const inputs={
 room_options:{action:'sale_phong.edit'},room_observe:{roomId:room},room_patch:{requestId,roomId:room,expectedRevision:revision,rent_price:3000000},
 room_lock:{requestId,roomId:room,hours:6,note:null},room_release:{requestId,lockId:randomUUID()},
 reservation_create:{requestId,roomId:room,customerId:null,customerHint:'Khách thử',intendedMoveInOn:null,topupDueOn:null,depositTarget:3000000,notes:null,receipt},
 reservation_update:{requestId,reservationId,expectedRevision:1,changes:{notes:'Ghi chú thử'}},
 reservation_topup:{requestId,reservationId,expectedRevision:1,receipt},reservation_assign:{requestId,reservationId,expectedRevision:1,customerId:randomUUID()},
 action_status:{requestId},policy_observe:{roomId:room},
 policy_save:{requestId,roomId:room,expectedRevision:revision,title:'Ưu đãi',content:'Miễn phí gửi xe',startsAt:'2026-11-01T00:00:00+07:00',endsAt:'2026-12-01T00:00:00+07:00'},
 policy_cancel:{requestId,policyId,expectedVersion:1,reason:'Kết thúc'},policy_status:{requestId},
 bulk_patch:{requestId,items:[{requestId:randomUUID(),roomId:room,expectedRevision:revision,rent_price:3000000}]},
 bulk_status:{requestId,items:[{requestId:randomUUID(),roomId:room}]},
};
function fixture(t,grants=keys){
 const scope=createDependencyScope();t.after(()=>scope.close());
 const connection=randomUUID(),building=randomUUID(),seen=[],events=[],logs=[],prepared=new WeakMap();
 const state={revoked:false,grants:[...grants],lost:false};
 const who=()=>({row:{id:connection,assistantId:randomUUID(),organizationId:randomUUID(),userId:randomUUID(),state:'active',epoch:1,
  expiresAt:Date.now()+3600000,restrictions:{read:[],action:state.grants}},effective:{read:[],action:state.grants},
  policyEpoch:'a'.repeat(64),contextVersion:'b'.repeat(64),assistantScopeIds:[randomUUID()],isSuperadmin:false,
  scopesByPermission:Object.fromEntries(state.grants.map(key=>[key,{buildingIds:[building],cashbookIds:[]}]))});
 const port=(family,prepare,finalize)=>({async [prepare](_token,operation,input){seen.push({family,operation,input});const value=Object.freeze({});prepared.set(value,{operation,input});return value;},
  async [finalize](_token,value,options){events.push('write');options.onDispatch();if(state.lost)throw new Error('lost ACK');return{outcome:'applied',requestId:prepared.get(value).input.requestId??null};}});
 const broker=createBroker({dependencyScope:scope,limits:{maxResultBytes:65536},audit:async event=>events.push('audit:'+event.outcome),callLog:event=>logs.push(event),
  authority:{identifyConnection:async()=>({connectionId:connection}),resolve:async()=>{if(state.revoked)throw new BrokerError('unauthorized');return who();},checkUnchanged:async()=>{}},
  saleActions:port('sale','prepareSaleAction','finalizeSaleAction'),salePolicies:port('policy','prepareSalePolicy','finalizeSalePolicy'),saleBulk:port('bulk','prepareSaleBulk','finalizeSaleBulk')});
 const token='hc_'+'A'.repeat(43),call=async(operation,input)=>JSON.parse((await broker.callTool(token,SALE_TOOL.name,{operation,...(input===undefined?{}:{input})})).content[0].text);
 return{broker,token,call,seen,events,logs,state};
}

test('compact catalogue discovers all 16 unchanged schemas and keeps request-ID issuance available',async t=>{
 const f=fixture(t),listed=(await f.broker.listTools(f.token)).tools.map(x=>x.name);
 assert.deepEqual(listed.sort(),['crm_new_request_id','crm_sale_action']);
 const discovery=await f.call('list');assert.equal(discovery.operations.length,16);
 for(const tool of all){const operation=discovery.operations.find(x=>x.operation===saleToolOperation(tool));assert(operation);
  assert.deepEqual(operation.inputSchema,tool.inputSchema);assert.deepEqual(operation.annotations,tool.annotations);}
 assert.equal(f.seen.length,0);assert(f.events.includes('audit:prepared'));
 const id=JSON.parse((await f.broker.callTool(f.token,'crm_new_request_id',{})).content[0].text).requestId;
 assert.match(id,/^[0-9a-f-]{36}$/);
});

for(const operation of Object.keys(inputs))test(`compact route ${operation} keeps its validator, canonical service and audit-before-write ordering`,async t=>{
 const f=fixture(t);let result=await f.call(operation,inputs[operation]);
 if(result.outcome==='confirmation_required'){
  assert.equal(f.seen.length,0);assert.equal(result.tool,SALE_TOOL.name);assert.equal(result.operation,operation);
  result=await f.call(operation,{...inputs[operation],confirmToken:result.confirmToken});
 }
 assert.equal(result.outcome,'applied');assert.equal(f.seen.length,1);
 const expectedFamily=operation.startsWith('policy_')?'policy':operation.startsWith('bulk_')?'bulk':'sale';
 assert.equal(f.seen[0].family,expectedFamily);
 assert.equal(f.seen[0].operation,operation.startsWith('room_')?operation.slice(5):operation==='action_status'?'status':expectedFamily==='sale'?operation:operation.slice(expectedFamily.length+1));
 assert(!Object.hasOwn(f.seen[0].input,'confirmToken'));
 assert(f.events.indexOf('audit:prepared')<f.events.indexOf('write'));
 assert(f.logs.some(event=>event.tool===SALE_TOOL.name&&event.outcome==='ok'));
});

test('discovery filters live grants; hidden direct identifiers and denied operations never reach a service',async t=>{
 const f=fixture(t,['sale_phong.edit']);let discovered=(await f.call('list')).operations.map(x=>x.operation);
 for(const operation of ['room_patch','policy_save','bulk_patch'])assert(discovered.includes(operation));
 for(const operation of ['room_lock','room_release','reservation_create','reservation_update','reservation_topup','reservation_assign'])assert(!discovered.includes(operation));
 await assert.rejects(()=>f.call('room_lock',inputs.room_lock),e=>e.code==='tool_not_available');
 for(const tool of all)await assert.rejects(()=>f.broker.callTool(f.token,tool.name,inputs[saleToolOperation(tool)]),e=>e.code==='tool_not_available');
 assert.equal(f.seen.length,0);
 f.state.grants=[];assert.equal((await f.broker.listTools(f.token)).tools.length,0);
 await assert.rejects(()=>f.call('list'),e=>e.code==='tool_not_available');
 f.state.revoked=true;await assert.rejects(()=>f.call('list'),e=>e.code==='unauthorized');
});

test('strict outer envelope, unchanged inner validation and unknown request identity cannot be bypassed',async t=>{
 const f=fixture(t);
 for(const value of [{operation:'unknown'},{operation:'list',input:{role:'owner'}},{operation:'list',admin:true},{operation:'room_patch',input:[]},
  Object.defineProperty({operation:'list'},'input',{enumerable:true,get(){throw Error('getter must not execute');}})]){
  assert.throws(()=>saleToolInput(value),/invalid_sale_tool/);
  await assert.rejects(()=>f.broker.callTool(f.token,SALE_TOOL.name,value),e=>e.code==='invalid_request');
 }
 await assert.rejects(()=>f.call('room_patch',{...inputs.room_patch,status:'AVAILABLE'}),e=>e.code==='invalid_request');
 assert.equal(f.seen.length,0);
 f.state.lost=true;await assert.rejects(()=>f.call('room_patch',inputs.room_patch),e=>e.code==='sale_outcome_unknown'&&e.requestId===requestId);
 assert.equal(f.seen.length,1);assert.equal(f.seen[0].input.requestId,requestId);
});
