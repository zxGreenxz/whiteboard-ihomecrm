import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createBroker, BrokerError } from './broker.mjs';
import { createDependencyScope } from './dependency-scope.mjs';
import { ACTION_REASONS } from './action-reasons.mjs';
import { SALE_ACTION_TOOLS, SALE_DEPOSIT_RECEIPT_KEY } from './sale-action-contract.mjs';
import { SALE_POLICY_TOOLS } from './sale-policy-contract.mjs';
import { SALE_BULK_TOOLS } from './sale-bulk-contract.mjs';
import { SALE_RETIRED_OPERATIONS, SALE_TOOL, saleToolDefinition, saleToolInput, saleToolOperation, saleToolRetired } from './sale-tool-contract.mjs';

const all = [...SALE_ACTION_TOOLS, ...SALE_POLICY_TOOLS, ...SALE_BULK_TOOLS];
// Báo cọc / thu thêm có tiền đòi thêm khoá riêng ngoài income_expenses.create (sale-deposit-receipt-key.test.mjs).
const keys = ['rooms.edit','sale_phong.edit','sale_phong.manage_images','sale_phong.lock_room','deposits.create','deposits.edit','income_expenses.create',SALE_DEPOSIT_RECEIPT_KEY];
// 05/11: cọc và giữ / bỏ giữ phòng rời cầu crm_sale_action (SALE_RETIRED_OPERATIONS). BEFORE = operation=list của kết nối giữ mọi khoá trên
// (cả khoá riêng) ở origin/main f2473ba4a: 16 thao tác. KEPT_SHA = sha256 JSON của 10 mục còn lại trong chính danh sách đó (đo ở f2473ba4a):
// mục còn lại phải y nguyên từng byte. Sửa mô tả / khuôn một thao tác còn lại có chủ ý thì đo lại và ghi lý do.
// 11/11 (PS-D05): policy_cancel đổi CÓ CHỦ Ý bốn chỗ — mô tả thêm câu CANCEL_ADDED, khuôn thêm confirmToken và consentText (tuỳ chọn),
// reason thêm description (policy-cancel-guard.mjs: reason là lời người dùng, luôn xem trước, xác nhận bằng lời đồng ý rõ). KEPT_SHA_NOW =
// danh mục hiện tại; KEPT_SHA (đo ở f2473ba4a) vẫn phải khớp sau khi gỡ đúng bốn chỗ đó khỏi mục policy_cancel ⇒ chín mục kia y nguyên.
const KEPT_SHA_NOW='1dd5baa192cb684f3e98fb5c5010b92faa84c600aca88044dd01ae4f8635027f';
const CANCEL_ADDED=' reason = lời người dùng nói VÌ SAO dừng; họ chưa nói ⇒ hỏi trước, không tự đặt. Luôn xem trước: người dùng đồng ý rõ ở tin sau mới gửi lại y nguyên kèm confirmToken và consentText.';
const BEFORE=['room_options','room_observe','room_patch','room_lock','room_release','reservation_create','reservation_update','reservation_topup',
 'reservation_assign','action_status','policy_observe','policy_save','policy_cancel','policy_status','bulk_patch','bulk_status'];
const RETIRED={room_lock:'sale_lock_via_contract',room_release:'sale_lock_via_contract',reservation_create:'sale_deposit_web_only',
 reservation_update:'sale_deposit_web_only',reservation_topup:'sale_deposit_web_only',reservation_assign:'sale_deposit_web_only'};
const KEPT=BEFORE.filter(operation=>!Object.hasOwn(RETIRED,operation));
const KEPT_SHA='ac843e4719df453e5f366922fadaf1620b90de9755080395ec45e587e97b85be';
const room=randomUUID(),requestId=randomUUID(),reservationId=randomUUID(),policyId=randomUUID();
const revision='a'.repeat(32),receipt={amount:1000000,accountId:null,voucherDate:'2026-10-22',name:null,description:null};
const PROGRAM=Object.freeze({id:policyId,version:1,title:'Giảm 300k tháng đầu',content:'Giảm 300.000đ tiền phòng tháng đầu',
 startsAt:'2026-11-01T00:00:00+07:00',endsAt:'2026-11-30T23:59:00+07:00',status:'ACTIVE'});
const PREVIEW_PROGRAM={title:PROGRAM.title,status:PROGRAM.status,startsAt:PROGRAM.startsAt,endsAt:PROGRAM.endsAt};
const inputs={
 room_options:{action:'sale_phong.edit'},room_observe:{roomId:room},room_patch:{requestId,roomId:room,expectedRevision:revision,rent_price:3000000},
 room_lock:{requestId,roomId:room,hours:6,note:null},room_release:{requestId,lockId:randomUUID()},
 reservation_create:{requestId,roomId:room,customerId:null,customerHint:'Khách thử',intendedMoveInOn:null,topupDueOn:null,depositTarget:3000000,notes:null,receipt},
 reservation_update:{requestId,reservationId,expectedRevision:1,changes:{notes:'Ghi chú thử'}},
 reservation_topup:{requestId,reservationId,expectedRevision:1,receipt},reservation_assign:{requestId,reservationId,expectedRevision:1,customerId:randomUUID()},
 action_status:{requestId},policy_observe:{roomId:room},
 policy_save:{requestId,roomId:room,expectedRevision:revision,title:'Ưu đãi',content:'Miễn phí gửi xe',startsAt:'2026-11-01T00:00:00+07:00',endsAt:'2026-12-01T00:00:00+07:00'},
 policy_cancel:{requestId,policyId,expectedVersion:1,reason:'Khách chê giá cao'},policy_status:{requestId},
 bulk_patch:{requestId,items:[{requestId:randomUUID(),roomId:room,expectedRevision:revision,rent_price:3000000}]},
 bulk_status:{requestId,items:[{requestId:randomUUID(),roomId:room}]},
};
function fixture(t,grants=keys){
 const scope=createDependencyScope();t.after(()=>scope.close());
 const connection=randomUUID(),building=randomUUID(),seen=[],events=[],audits=[],logs=[],prepared=new WeakMap();
 const state={revoked:false,grants:[...grants],lost:false};
 const who=()=>({row:{id:connection,assistantId:randomUUID(),organizationId:randomUUID(),userId:randomUUID(),state:'active',epoch:1,
  expiresAt:Date.now()+3600000,restrictions:{read:[],action:state.grants}},effective:{read:[],action:state.grants},
  policyEpoch:'a'.repeat(64),contextVersion:'b'.repeat(64),assistantScopeIds:[randomUUID()],isSuperadmin:false,
  scopesByPermission:Object.fromEntries(state.grants.map(key=>[key,{buildingIds:[building],cashbookIds:[]}]))});
 // policy_observe trả thêm chương trình của phòng (khuôn room.policy của salePolicyResult) để rào dừng chương trình dựng bản xem trước.
 const port=(family,prepare,finalize)=>({async [prepare](_token,operation,input){seen.push({family,operation,input});const value=Object.freeze({});prepared.set(value,{operation,input});return value;},
  async [finalize](_token,value,options){events.push('write');options.onDispatch();if(state.lost)throw new Error('lost ACK');const{operation,input}=prepared.get(value);
   return{outcome:'applied',requestId:input.requestId??null,...(family==='policy'&&operation==='observe'?{room:{roomId:input.roomId,buildingId:building,revision,policy:PROGRAM}}:{})};}});
 const broker=createBroker({dependencyScope:scope,limits:{maxResultBytes:65536},audit:async event=>{audits.push(event);events.push('audit:'+event.outcome);},callLog:event=>logs.push(event),
  authority:{identifyConnection:async()=>({connectionId:connection}),resolve:async()=>{if(state.revoked)throw new BrokerError('unauthorized');return who();},checkUnchanged:async()=>{}},
  saleActions:port('sale','prepareSaleAction','finalizeSaleAction'),salePolicies:port('policy','prepareSalePolicy','finalizeSalePolicy'),saleBulk:port('bulk','prepareSaleBulk','finalizeSaleBulk')});
 const token='hc_'+'A'.repeat(43),call=async(operation,input)=>JSON.parse((await broker.callTool(token,SALE_TOOL.name,{operation,...(input===undefined?{}:{input})})).content[0].text);
 return{broker,token,call,seen,events,audits,logs,state};
}

test('compact catalogue lists the 10 kept operations byte-for-byte as before and none of the 6 retired ones, even holding every key',async t=>{
 // Danh mục nội bộ (thao tác SQL hermes_sale_actions_v1 + chính sách + lô) không đổi; chỉ cầu công khai bỏ sáu thao tác.
 assert.deepEqual(all.map(saleToolOperation),BEFORE);
 assert.deepEqual({...SALE_RETIRED_OPERATIONS},RETIRED);
 const f=fixture(t),listed=(await f.broker.listTools(f.token)).tools.map(x=>x.name);
 assert.deepEqual(listed.sort(),['crm_new_request_id','crm_sale_action']);
 const discovery=await f.call('list');
 assert.deepEqual(discovery.operations.map(x=>x.operation),KEPT);
 const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
 assert.equal(sha(discovery.operations),KEPT_SHA_NOW,'danh mục hiện tại: chỉ policy_cancel đổi (11/11)');
 const undone=structuredClone(discovery.operations),cancelEntry=undone.find(x=>x.operation==='policy_cancel');
 assert(cancelEntry.description.includes(CANCEL_ADDED));cancelEntry.description=cancelEntry.description.replace(CANCEL_ADDED,'');
 assert.equal(delete cancelEntry.inputSchema.properties.confirmToken&&delete cancelEntry.inputSchema.properties.consentText&&
  delete cancelEntry.inputSchema.properties.reason.description,true);
 assert.equal(sha(undone),KEPT_SHA,'gỡ bốn chỗ đổi của policy_cancel ⇒ cả 10 mục y nguyên origin/main');
 for(const tool of all.filter(item=>KEPT.includes(saleToolOperation(item)))){const operation=discovery.operations.find(x=>x.operation===saleToolOperation(tool));assert(operation);
  assert.deepEqual(operation.inputSchema,tool.inputSchema);assert.deepEqual(operation.annotations,tool.annotations);}
 assert.equal(f.seen.length,0);assert(f.events.includes('audit:prepared'));
 const id=JSON.parse((await f.broker.callTool(f.token,'crm_new_request_id',{})).content[0].text).requestId;
 assert.match(id,/^[0-9a-f-]{36}$/);
 // Mô tả tool khớp skill: chỉ sửa thông tin / ảnh / chính sách; không còn "lock".
 assert.match(SALE_TOOL.description,/^Sale phòng: sửa thông tin, ảnh, chính sách \(room sale\)\. Không cọc, không giữ phòng\./);
 assert.doesNotMatch(SALE_TOOL.description,/lock|reservation/i);
});

for(const operation of KEPT)test(`compact route ${operation} keeps its validator, canonical service and audit-before-write ordering`,async t=>{
 const f=fixture(t);
 // Dừng chương trình chỉ có bản xem trước cho chương trình kết nối vừa đọc (policy-cancel-guard.mjs): đọc trước, rồi đếm từ đầu.
 if(operation==='policy_cancel'){await f.call('policy_observe',inputs.policy_observe);for(const list of [f.seen,f.events,f.audits,f.logs])list.length=0;}
 let result=await f.call(operation,inputs[operation]);
 if(result.outcome==='confirmation_required'){
  assert.equal(f.seen.length,0);assert.equal(result.tool,SALE_TOOL.name);assert.equal(result.operation,operation);
  // Theo đúng huongDan: bản xem trước nào đòi consentText (dừng chương trình) thì lượt xác nhận kèm lời đồng ý của người dùng.
  result=await f.call(operation,{...inputs[operation],confirmToken:result.confirmToken,...(/consentText/.test(result.huongDan)?{consentText:'ok'}:{})});
 }
 assert.equal(result.outcome,'applied');assert.equal(f.seen.length,1);
 const expectedFamily=operation.startsWith('policy_')?'policy':operation.startsWith('bulk_')?'bulk':'sale';
 assert.equal(f.seen[0].family,expectedFamily);
 assert.equal(f.seen[0].operation,operation.startsWith('room_')?operation.slice(5):operation==='action_status'?'status':expectedFamily==='sale'?operation:operation.slice(expectedFamily.length+1));
 assert(!Object.hasOwn(f.seen[0].input,'confirmToken'));assert(!Object.hasOwn(f.seen[0].input,'consentText'));
 assert(f.events.indexOf('audit:prepared')<f.events.indexOf('write'));
 assert(f.logs.some(event=>event.tool===SALE_TOOL.name&&event.outcome==='ok'));
});

// PS-D05 (ma trận Phòng sale lô ps08 10/11/2026 — ghi sai thật): "Ngưng chương trình ưu đãi phòng 105 toà 1392QT giúp anh" (không nêu lý do)
// ⇒ mô hình gọi policy_cancel MỘT lượt với reason tự đặt và chương trình dừng ngay, lý do bịa nằm lại trong lịch sử. Rào ở broker
// (policy-cancel-guard.mjs): reason chỉ nhắc lại lệnh ⇒ needs_input hỏi vì sao; chương trình kết nối chưa đọc ⇒ observe_required; mọi lượt
// không token ⇒ bản xem trước kèm chương trình (tên, trạng thái, thời hạn) + nguyên văn reason; lượt kèm token phải kèm consentText là câu
// đáp đồng ý thuần (câu yêu cầu ban đầu, hay câu chỉ nêu lý do, không phải) mới tới dịch vụ, câu đó vào dòng audit prepared. Đột biến bỏ
// policyCancel.review ở broker ⇒ ca đầu ra applied, có lệnh dừng tới dịch vụ ⇒ đỏ.
const policyFixture=async t=>{
 const f=fixture(t,['sale_phong.edit']),observed=await f.call('policy_observe',{roomId:room});
 assert.deepEqual(observed.room.policy,PROGRAM);
 // Lệnh dừng tới dịch vụ (chỉ đếm cancel; policy_observe là đọc).
 return{...f,cancels:()=>f.seen.filter(item=>item.operation==='cancel'),cancel:reason=>({requestId,policyId,expectedVersion:1,reason})};
};
test('PS-D05 policy_cancel: reason chỉ nhắc lại lệnh ⇒ hỏi vì sao; một lượt gọi, hay tự xác nhận bằng câu yêu cầu, không dừng được; lý do tới dịch vụ là lý do đã xem trước',async t=>{
 const f=await policyFixture(t),{cancel}=f,CF=/^cf_[A-Za-z0-9_-]{43}$/,writes=()=>f.events.filter(event=>event==='write').length,readWrites=writes();
 const REQUEST='Ngưng chương trình ưu đãi phòng 105 toà 1392QT giúp anh';
 // Đúng hai reason bot đã gửi ở lượt 1 của PS-D05 (bản ghi r3b1, r2b1).
 for(const reason of ['Ngưng chương trình ưu đãi','Ngưng chương trình ưu đãi theo yêu cầu']){
  const asked=await f.call('policy_cancel',cancel(reason));
  assert.deepEqual([asked.outcome,asked.applied,asked.reason,asked.tool,asked.operation,asked.policyId],
   ['needs_input',false,'reason_required',SALE_TOOL.name,'policy_cancel',policyId],reason);
  assert(!Object.hasOwn(asked,'confirmToken'));assert.match(asked.huongDan,/^CHƯA dừng\. Hỏi người dùng vì sao dừng chương trình/);
 }
 // Lý do bịa mà "có nghĩa" qua được lớp chữ nhưng vẫn không dừng trong một lượt gọi: chỉ ra bản xem trước kèm chương trình + nguyên văn lý do.
 const made='Hết thời gian áp dụng ưu đãi',invented=await f.call('policy_cancel',cancel(made));
 assert.deepEqual([invented.outcome,invented.applied,invented.tool,invented.operation,invented.policyId,invented.preview],
  ['confirmation_required',false,SALE_TOOL.name,'policy_cancel',policyId,{program:PREVIEW_PROGRAM,reason:made}]);
 assert.match(invented.confirmToken,CF);
 assert.match(invented.huongDan,/phải là lời NGƯỜI DÙNG đã nói; họ chưa nói vì sao dừng ⇒ hỏi họ, không dùng token này/);
 assert.match(invented.huongDan,/kèm confirmToken và consentText = NGUYÊN VĂN câu đáp đó\. Lời đồng ý là câu đáp chỉ gồm lời đồng ý/);
 // Tự xác nhận NGAY trong lượt ra lệnh: trích đúng câu yêu cầu của người dùng, hay không trích ⇒ consent_unclear, token chưa tiêu, không tới dịch vụ.
 for(const consentText of [REQUEST,undefined]){
  const held=await f.call('policy_cancel',{...cancel(made),confirmToken:invented.confirmToken,...(consentText===undefined?{}:{consentText})});
  assert.deepEqual([held.outcome,held.applied,held.reason,held.tool,held.operation,held.policyId],
   ['needs_input',false,'consent_unclear',SALE_TOOL.name,'policy_cancel',policyId],String(consentText));
  assert(!Object.hasOwn(held,'confirmToken'));
 }
 assert.equal(f.cancels().length,0);assert.equal(writes(),readWrites);
 // Token của lý do bịa không dừng được bằng lý do người dùng nói sau đó (lệch nội dung), và trình ra là tiêu: lý do bịa cũng hết đường.
 await assert.rejects(()=>f.call('policy_cancel',{...cancel('khách chê giá cao'),confirmToken:invented.confirmToken,consentText:'ok'}),e=>e.code==='confirmation_invalid');
 await assert.rejects(()=>f.call('policy_cancel',{...cancel(made),confirmToken:invented.confirmToken,consentText:'ok'}),e=>e.code==='confirmation_invalid');
 await assert.rejects(()=>f.call('policy_cancel',{...cancel(made),confirmToken:'cf_'+'x'.repeat(43),consentText:'ok'}),e=>e.code==='confirmation_invalid');
 await assert.rejects(()=>f.call('policy_cancel',{...cancel(made),confirmToken:42}),e=>e.code==='invalid_request');
 await assert.rejects(()=>f.call('policy_cancel',{...cancel(made),consentText:42}),e=>e.code==='invalid_request');
 assert.equal(f.cancels().length,0);
 // Đường đúng — lượt 2 người dùng đáp "khách chê giá cao, anh đổi chương trình khác": xem trước; tự xác nhận bằng chính câu nêu lý do đó ⇒
 // consent_unclear; lượt 3 "ok" ⇒ gửi lại y nguyên kèm token + consentText.
 const said='khách chê giá cao, anh đổi chương trình khác',preview=await f.call('policy_cancel',cancel(said));
 assert.deepEqual([preview.outcome,preview.applied,preview.preview],['confirmation_required',false,{program:PREVIEW_PROGRAM,reason:said}]);
 assert.equal(new Date(preview.expiresAt).getTime()>Date.now(),true);assert.equal(f.cancels().length,0);
 const early=await f.call('policy_cancel',{...cancel(said),confirmToken:preview.confirmToken,consentText:said});
 assert.deepEqual([early.outcome,early.reason,f.cancels().length],['needs_input','consent_unclear',0]);
 // Token hợp lệ kèm reason nhắc lại lệnh vẫn là câu hỏi vì sao, và không làm mất token của lý do thật.
 const swapped=await f.call('policy_cancel',{...cancel('Ngưng chương trình ưu đãi'),confirmToken:preview.confirmToken,consentText:'ok'});
 assert.deepEqual([swapped.outcome,swapped.reason,f.cancels().length],['needs_input','reason_required',0]);
 const done=await f.call('policy_cancel',{...cancel(said),confirmToken:preview.confirmToken,consentText:'ok'});
 assert.equal(done.outcome,'applied');
 assert.deepEqual(f.cancels(),[{family:'policy',operation:'cancel',input:cancel(said)}]);
 assert(f.events.lastIndexOf('audit:prepared')<f.events.lastIndexOf('write'));
 // Câu đồng ý chỉ nằm ở dòng prepared của lượt ghi (khuôn consent của sổ audit host: trang.thao_tác + requestId + câu).
 assert.deepEqual(f.audits.filter(event=>event.consent).map(event=>[event.outcome,event.consent]),[['prepared',{action:'sale.policy_cancel',requestId,text:'ok'}]]);
 await assert.rejects(()=>f.call('policy_cancel',{...cancel(said),confirmToken:preview.confirmToken,consentText:'ok'}),e=>e.code==='confirmation_invalid');
 assert.equal(f.cancels().length,1);assert.equal(writes(),readWrites+1);
});

// Note 1 (review #416, kịch bản người review chạy trên broker thật): câu ra lệnh MỞ ĐẦU bằng lời đồng ý + lý do bịa. Trước: bản xem trước, rồi
// xác nhận bằng chính câu đó ⇒ applied. Nay: câu nêu chương trình / phòng không phải câu đáp đồng ý ⇒ consent_unclear, không dừng.
test('Note 1: "Vâng, ngưng chương trình ưu đãi phòng 105 giúp anh" + lý do bịa ⇒ bản xem trước; tự xác nhận bằng chính câu đó ⇒ KHÔNG dừng',async t=>{
 const f=await policyFixture(t),{cancel}=f,said='Vâng, ngưng chương trình ưu đãi phòng 105 giúp anh',made='Hết thời gian áp dụng ưu đãi';
 const preview=await f.call('policy_cancel',cancel(made));
 assert.deepEqual([preview.outcome,preview.preview],['confirmation_required',{program:PREVIEW_PROGRAM,reason:made}]);
 for(const consentText of [said,'Ok em, dừng chương trình ưu đãi phòng 105 nhé','ok dừng chương trình đó đi']){
  const held=await f.call('policy_cancel',{...cancel(made),confirmToken:preview.confirmToken,consentText});
  assert.deepEqual([held.outcome,held.reason,held.applied],['needs_input','consent_unclear',false],consentText);
 }
 assert.equal(f.cancels().length,0);assert(f.audits.every(event=>!Object.hasOwn(event,'consent')));
});

// B1 (review #416): lời đáp tự nhiên cho "anh đồng ý dừng không?" từng bị consent_unclear vì "dừng" là dấu hiệu chưa đồng ý của luật chung.
test('B1: "đồng ý dừng", "ok dừng đi", "ừ dừng đi em", "dừng luôn", "ừ ngưng đi" dừng được; "không dừng nữa", "thôi đừng dừng", "khoan đã" thì không',async t=>{
 const f=await policyFixture(t),{cancel}=f;
 const held=await f.call('policy_cancel',cancel('khách chê giá cao'));
 for(const consentText of ['không dừng nữa','thôi đừng dừng','khoan đã','dừng hả','dừng lại']){
  const asked=await f.call('policy_cancel',{...cancel('khách chê giá cao'),confirmToken:held.confirmToken,consentText});
  assert.deepEqual([asked.outcome,asked.reason],['needs_input','consent_unclear'],consentText);
 }
 assert.equal(f.cancels().length,0);
 for(const [index,consentText] of ['đồng ý dừng','ok dừng đi','ừ dừng đi em','dừng luôn','ừ ngưng đi'].entries()){
  const input=cancel(`khách chê giá cao ${index}`),preview=await f.call('policy_cancel',input);
  const done=await f.call('policy_cancel',{...input,confirmToken:preview.confirmToken,consentText});
  assert.equal(done.outcome,'applied',consentText);
 }
 assert.equal(f.cancels().length,5);
 assert.deepEqual(f.audits.filter(event=>event.consent).map(event=>event.consent.text),['đồng ý dừng','ok dừng đi','ừ dừng đi em','dừng luôn','ừ ngưng đi']);
});

// Note 2 (review #416): bản xem trước nêu CHƯƠNG TRÌNH sẽ dừng, lấy từ lần đọc của chính kết nối qua broker. Chưa đọc ⇒ needs_input
// observe_required (tên cầu + operation), không token, không tới dịch vụ; đọc rồi ⇒ bản xem trước có tên / trạng thái / thời hạn.
test('Note 2: dừng chương trình chưa đọc ⇒ observe_required qua cầu, không token; đọc xong ⇒ bản xem trước nêu đúng chương trình',async t=>{
 const f=fixture(t,['sale_phong.edit']),input={requestId,policyId,expectedVersion:1,reason:'khách chê giá cao'};
 const asked=await f.call('policy_cancel',input);
 assert.deepEqual([asked.outcome,asked.applied,asked.reason,asked.tool,asked.operation,asked.policyId],
  ['needs_input',false,'observe_required',SALE_TOOL.name,'policy_cancel',policyId]);
 assert(!Object.hasOwn(asked,'confirmToken'));assert.match(asked.huongDan,/Gọi crm_sale_action operation=policy_observe với roomId/);
 assert.equal(f.seen.length,0);
 await f.call('policy_observe',{roomId:room});
 const preview=await f.call('policy_cancel',input);
 assert.deepEqual([preview.outcome,preview.preview],['confirmation_required',{program:PREVIEW_PROGRAM,reason:'khách chê giá cao'}]);
 // Version khác bản vừa đọc (chương trình đã sửa) ⇒ đọc lại.
 assert.equal((await f.call('policy_cancel',{...input,expectedVersion:2})).reason,'observe_required');
 assert.deepEqual(f.seen.map(item=>item.operation),['observe']);
});

// Gọi thẳng operation đã rời cầu (mô hình theo skill tự học cũ): lỗi rõ có lý do + câu tĩnh chỉ chỗ làm đúng, ghi sổ audit denied kèm
// lý do; input hợp lệ, rỗng hay rác đều cùng một lỗi (không validator nào chạy), không có prepare / ghi nào tới dịch vụ.
for(const [operation,reason] of Object.entries(RETIRED))test(`retired ${operation}: action_rejected ${reason}, audited, never validated nor sent to a service`,async t=>{
 const f=fixture(t);
 for(const input of [inputs[operation],undefined,{},{requestId,status:'AVAILABLE'}])
  await assert.rejects(()=>f.call(operation,input),e=>e instanceof BrokerError&&e.code==='action_rejected'&&e.reason===reason&&
   e.detail===ACTION_REASONS[reason].text&&!Object.hasOwn(e,'link'),JSON.stringify(input));
 assert.deepEqual(f.seen,[]);assert(!f.events.includes('write'));
 assert.deepEqual(f.audits.map(event=>[event.outcome,event.code,event.reason]),Array(4).fill(['denied','action_rejected',reason]));
 assert.equal(f.logs.length,4);assert(f.logs.every(event=>event.tool===SALE_TOOL.name&&event.outcome==='error'&&event.code==='action_rejected'));
});

test('keys of the retired operations alone open no Sale write: only the room lookup and request reconciliation stay listed',async t=>{
 const f=fixture(t,['sale_phong.lock_room','deposits.create','deposits.edit','income_expenses.create',SALE_DEPOSIT_RECEIPT_KEY]);
 assert.deepEqual((await f.call('list')).operations.map(x=>x.operation),['room_options','action_status']);
 for(const [operation,reason] of Object.entries(RETIRED))
  await assert.rejects(()=>f.call(operation,inputs[operation]),e=>e.code==='action_rejected'&&e.reason===reason,operation);
 assert.equal(f.seen.length,0);
 // Không còn thao tác nào khởi tạo lệnh ghi ⇒ crm_new_request_id cũng không hiện.
 assert.deepEqual((await f.broker.listTools(f.token)).tools.map(x=>x.name),['crm_sale_action']);
});

test('discovery filters live grants; hidden direct identifiers and denied operations never reach a service',async t=>{
 const f=fixture(t,['sale_phong.edit']);let discovered=(await f.call('list')).operations.map(x=>x.operation);
 for(const operation of ['room_patch','policy_save','bulk_patch'])assert(discovered.includes(operation));
 for(const operation of Object.keys(RETIRED))assert(!discovered.includes(operation));
 // Còn thao tác Sale khác ⇒ operation đã rời cầu nhận lỗi rõ thay vì tool_not_available.
 await assert.rejects(()=>f.call('room_lock',inputs.room_lock),e=>e.code==='action_rejected'&&e.reason==='sale_lock_via_contract');
 for(const tool of all)await assert.rejects(()=>f.broker.callTool(f.token,tool.name,inputs[saleToolOperation(tool)]),e=>e.code==='tool_not_available');
 assert.equal(f.seen.length,0);
 f.state.grants=[];assert.equal((await f.broker.listTools(f.token)).tools.length,0);
 await assert.rejects(()=>f.call('list'),e=>e.code==='tool_not_available');
 // Không còn thao tác Sale nào ⇒ crm_sale_action vắng hẳn; operation đã rời cầu cũng chỉ là tool_not_available.
 await assert.rejects(()=>f.call('reservation_create',inputs.reservation_create),e=>e.code==='tool_not_available');
 f.state.revoked=true;await assert.rejects(()=>f.call('list'),e=>e.code==='unauthorized');
});

test('strict outer envelope, unchanged inner validation and unknown request identity cannot be bypassed',async t=>{
 const f=fixture(t);
 for(const value of [{operation:'unknown'},{operation:'list',input:{role:'owner'}},{operation:'list',admin:true},{operation:'room_patch',input:[]},
  {operation:'room_lock',input:[]},{operation:'reservation_create',admin:true},
  Object.defineProperty({operation:'list'},'input',{enumerable:true,get(){throw Error('getter must not execute');}})]){
  assert.throws(()=>saleToolInput(value),/invalid_sale_tool/);
  await assert.rejects(()=>f.broker.callTool(f.token,SALE_TOOL.name,value),e=>e.code==='invalid_request');
 }
 // Vỏ đúng của operation đã rời cầu được nhận chỉ để trả lỗi rõ: không có định nghĩa nào để chuyển tới CRM.
 assert.deepEqual(saleToolInput({operation:'room_lock'}),{operation:'room_lock',input:{}});
 for(const [operation,reason] of Object.entries(RETIRED)){assert.equal(saleToolDefinition(operation),undefined,operation);assert.equal(saleToolRetired(operation),reason);}
 for(const operation of [...KEPT,'list','toString','__proto__','lock',1,null])assert.equal(saleToolRetired(operation),undefined,String(operation));
 await assert.rejects(()=>f.call('room_patch',{...inputs.room_patch,status:'AVAILABLE'}),e=>e.code==='invalid_request');
 assert.equal(f.seen.length,0);
 f.state.lost=true;await assert.rejects(()=>f.call('room_patch',inputs.room_patch),e=>e.code==='sale_outcome_unknown'&&e.requestId===requestId);
 assert.equal(f.seen.length,1);assert.equal(f.seen[0].input.requestId,requestId);
});
