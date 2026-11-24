// @vitest-environment jsdom
// Kho dấu riêng của THU TIỀN HOÁ ĐƠN (đợt 2 plan sửa khoá vĩnh viễn, 24/11/2026).
// `record_invoice_collection_v5` chống trùng theo (tổ chức, hoá đơn, người thu, khoá): cùng khoá + cùng nội dung
// trả lại kết quả cũ, cùng khoá + khác nội dung ném 23505 «idempotency_key đã dùng với nội dung khác". Nên khi tra
// chưa thấy khoản thu, gửi lại ĐÚNG khoá của dấu là an toàn; không bao giờ được thu bằng khoá mới khi dấu còn đó.
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {runDurableCollection,reconcilePendingCollection,PendingCollectionError,PriorCollectionSettledError} from '../pendingCollection';
import {PENDING_SETTLE_MS} from '../financialPending';
import {createPendingValve} from '../pendingValve';

const scope={userId:'u1',organizationId:'o1',invoiceId:'i1'};
const storageKey='ihome:pending-collection:v1:u1:o1:i1';
// 09:00 ngày 24/11/2026 giờ Việt Nam.
const T0=Date.parse('2026-11-24T02:00:00.000Z');
let clock=T0;
const now=()=>new Date(clock);
const valve={report:vi.fn((_input:{pending:unknown})=>undefined)};
const deps={now,valve};
const receipt=(over:Record<string,unknown>={})=>({collection_id:'c1',invoice_id:'i1',applied_amount:1000,...over});
const row=(key:string,status='ACTIVE')=>({id:'c1',invoice_id:'i1',organization_id:'o1',actor_id:'u1',idempotency_key:key,status,applied_amount:1000});
const offline=()=>Promise.reject(new TypeError('Failed to fetch'));
const notFound=async()=>null;
const keyUsed={code:'23505',message:'idempotency_key đã dùng với nội dung khác'};
const marker=()=>JSON.parse(localStorage.getItem(storageKey)??'null') as {idempotencyKey:string}|null;
/** Bản trước đợt 2 ghi đúng dạng này; trình duyệt nhân viên đang giữ dấu như vậy. */
const seedOldMarker=(idempotencyKey='collect-old',startedAt='2026-11-20T01:00:00.000Z')=>localStorage.setItem(storageKey,JSON.stringify({userId:'u1',organizationId:'o1',invoiceId:'i1',idempotencyKey,startedAt}));

/** Máy chủ giả chống trùng theo khoá như `record_invoice_collection_v5`. */
function fakeServer(){
 const ops=new Map<string,{content:string;response:Record<string,unknown>}>();
 let next=1;
 return {
  ops,
  collect(key:string,content:string){
   const prior=ops.get(key);
   if(prior){if(prior.content!==content)throw keyUsed;return prior.response;}
   const response=receipt({collection_id:`c${next++}`});ops.set(key,{content,response});return response;
  },
 };
}

beforeEach(()=>{localStorage.clear();clock=T0;valve.report.mockReset();});

describe('lệnh thu không tới máy chủ',()=>{
 it('lần bấm sau gửi lại ĐÚNG khoá của dấu, không dùng khoá mới; thu xong thì gỡ dấu',async()=>{
  await expect(runDurableCollection(scope,'k-old',vi.fn(offline),notFound,deps)).rejects.toThrow();
  expect(marker()?.idempotencyKey).toBe('k-old');
  const send=vi.fn(async()=>receipt());const lookup=vi.fn(notFound);
  await expect(runDurableCollection(scope,'k-new',send,lookup,deps)).resolves.toMatchObject({collection_id:'c1'});
  expect(lookup).toHaveBeenCalledWith(expect.objectContaining({idempotencyKey:'k-old'}));
  expect(send).toHaveBeenCalledTimes(1);expect(send).toHaveBeenCalledWith('k-old');
  expect(localStorage.getItem(storageKey)).toBeNull();
 });
 it('gửi lại vẫn rớt mạng: dấu giữ nguyên khoá cũ, lần sau lại gửi đúng khoá đó',async()=>{
  await expect(runDurableCollection(scope,'k-old',vi.fn(offline),notFound,deps)).rejects.toThrow();
  const retry=vi.fn(offline);
  await expect(runDurableCollection(scope,'k-2',retry,notFound,deps)).rejects.toThrow();
  expect(retry).toHaveBeenCalledWith('k-old');expect(marker()?.idempotencyKey).toBe('k-old');
  const send=vi.fn(async()=>receipt());
  await expect(runDurableCollection(scope,'k-3',send,notFound,deps)).resolves.toMatchObject({collection_id:'c1'});
  expect(send).toHaveBeenCalledWith('k-old');expect(localStorage.getItem(storageKey)).toBeNull();
 });
 it('gửi lại bị từ chối rõ khi dấu dưới 2 phút: giữ dấu; quá 2 phút mà vẫn chưa thấy thì gỡ',async()=>{
  await expect(runDurableCollection(scope,'k-old',vi.fn(offline),notFound,deps)).rejects.toThrow();
  const conflict={code:'PT409',message:'Số đã thu vừa thay đổi; vui lòng tải lại hóa đơn'};
  await expect(runDurableCollection(scope,'k-2',vi.fn(()=>Promise.reject(conflict)),notFound,deps)).rejects.toBe(conflict);
  expect(marker()?.idempotencyKey).toBe('k-old');
  clock+=PENDING_SETTLE_MS;
  await expect(runDurableCollection(scope,'k-3',vi.fn(()=>Promise.reject(conflict)),notFound,deps)).rejects.toBe(conflict);
  expect(localStorage.getItem(storageKey)).toBeNull();
 });
 it('gửi lại cũng rớt mạng: giờ gửi của dấu tính lại từ lần gửi lại, hộp cảnh báo chờ đủ 2 phút từ đó',async()=>{
  seedOldMarker('k-old','2026-11-24T01:00:00.000Z');
  await expect(runDurableCollection(scope,'k-new',vi.fn(offline),notFound,deps)).rejects.toThrow();
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toMatchObject({idempotencyKey:'k-old',startedAt:new Date(T0).toISOString()});
  clock+=30_000;
  const error=await runDurableCollection(scope,'k-new',vi.fn(),()=>Promise.reject(new TypeError('Failed to fetch')),deps).catch(e=>e);
  expect(error.message).toMatch(/đang chờ kết quả/);
  expect(valve.report).toHaveBeenCalledWith(expect.objectContaining({pending:expect.objectContaining({attemptId:'k-old',startedAt:new Date(T0).toISOString()})}));
 });
 it('bấm lần hai khi lần gửi trước còn chạy trong tab: chặn ngay, không tra, không gửi',async()=>{
  let finish:(value:Record<string,unknown>)=>void=()=>{};
  const first=runDurableCollection(scope,'k-old',()=>new Promise(resolve=>{finish=resolve;}),notFound,deps);
  await vi.waitFor(()=>expect(marker()).not.toBeNull());
  const send=vi.fn();const lookup=vi.fn(notFound);
  await expect(runDurableCollection(scope,'k-2',send,lookup,deps)).rejects.toBeInstanceOf(PendingCollectionError);
  expect(lookup).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();
  finish(receipt());await expect(first).resolves.toMatchObject({collection_id:'c1'});
 });
});

describe('lệnh thu tới máy chủ nhưng mất phản hồi',()=>{
 it('tra thấy khoản thu ACTIVE đúng khoá: trả biên nhận đã đối chiếu, gỡ dấu, không gửi',async()=>{
  await expect(runDurableCollection(scope,'k-old',vi.fn(offline),notFound,deps)).rejects.toThrow();
  const send=vi.fn();const lookup=vi.fn(async()=>row('k-old'));
  await expect(runDurableCollection(scope,'k-new',send,lookup,deps)).resolves.toMatchObject({collection_id:'c1',invoice_id:'i1',recovered:true});
  expect(send).not.toHaveBeenCalled();expect(localStorage.getItem(storageKey)).toBeNull();
 });
 it('tra chưa thấy, gửi lại cùng nội dung: máy chủ trả kết quả cũ, chỉ MỘT khoản thu',async()=>{
  const server=fakeServer();
  // Máy chủ đã ghi nhưng phản hồi mất trên đường về.
  await expect(runDurableCollection(scope,'k-old',async key=>{server.collect(key,'5tr TM');throw new TypeError('Failed to fetch');},notFound,deps)).rejects.toThrow();
  const result=await runDurableCollection(scope,'k-new',async key=>server.collect(key,'5tr TM'),notFound,deps);
  expect(result).toMatchObject({collection_id:'c1'});expect(server.ops.size).toBe(1);
  expect(localStorage.getItem(storageKey)).toBeNull();
 });
 it('máy chủ báo khoá đã dùng với nội dung khác: tra lại, báo lần trước đã thu, gỡ dấu, KHÔNG thu lần mới',async()=>{
  const server=fakeServer();
  await expect(runDurableCollection(scope,'k-old',async key=>{server.collect(key,'5tr TM');throw new TypeError('Failed to fetch');},notFound,deps)).rejects.toThrow();
  const send=vi.fn(async(key:string)=>server.collect(key,'4tr TK'));
  const lookup=vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(row('k-old'));
  const error=await runDurableCollection(scope,'k-new',send,lookup,deps).catch(e=>e);
  expect(error).toBeInstanceOf(PriorCollectionSettledError);
  expect(error).toMatchObject({reversed:false,collectionId:'c1',recordIds:['c1'],outcome:'failure'});
  expect(error.message).toMatch(/đã được ghi/);
  expect(send).toHaveBeenCalledTimes(1);expect(send).toHaveBeenCalledWith('k-old');
  expect(server.ops.size).toBe(1);expect(localStorage.getItem(storageKey)).toBeNull();
 });
 it('khoá đã dùng mà tra lại vẫn chưa thấy: tin máy chủ, báo đã thu, gỡ dấu',async()=>{
  seedOldMarker('k-old');
  const error=await runDurableCollection(scope,'k-new',vi.fn(()=>Promise.reject(keyUsed)),notFound,deps).catch(e=>e);
  expect(error).toBeInstanceOf(PriorCollectionSettledError);expect(error).toMatchObject({reversed:false,collectionId:null});
  expect(localStorage.getItem(storageKey)).toBeNull();
 });
 it('23505 không phải «khoá đã dùng» mà tra lại chưa thấy: chưa kết luận, giữ dấu và báo hộp cảnh báo',async()=>{
  seedOldMarker('k-old');
  const other={code:'23505',message:'duplicate key value violates unique constraint "x"'};
  await expect(runDurableCollection(scope,'k-new',vi.fn(()=>Promise.reject(other)),notFound,deps)).rejects.toBeInstanceOf(PendingCollectionError);
  expect(marker()?.idempotencyKey).toBe('k-old');expect(valve.report).toHaveBeenCalledOnce();
 });
});

describe('dấu cũ gieo sẵn (dạng ghi trước đợt 2)',()=>{
 it('trước khi tính nợ: tra chưa thấy thì cho đi tiếp; lần thu gửi lại đúng khoá của dấu cũ',async()=>{
  seedOldMarker();
  await expect(reconcilePendingCollection('u1','i1',notFound,deps)).resolves.toBeNull();
  expect(marker()?.idempotencyKey).toBe('collect-old');
  const send=vi.fn(async()=>receipt());
  await runDurableCollection(scope,'collect-new',send,notFound,deps);
  expect(send).toHaveBeenCalledWith('collect-old');expect(localStorage.getItem(storageKey)).toBeNull();
 });
 it('trước khi tính nợ: khoản thu đã có thì trả biên nhận cũ, không tính nợ lại',async()=>{
  seedOldMarker();
  await expect(reconcilePendingCollection('u1','i1',async()=>row('collect-old'),deps)).resolves.toMatchObject({collection_id:'c1',recovered:true});
  expect(localStorage.getItem(storageKey)).toBeNull();
 });
 it('dấu cũ thiếu giờ gửi vẫn đối chiếu được và coi như đã quá 2 phút',async()=>{
  localStorage.setItem(storageKey,JSON.stringify({userId:'u1',organizationId:'o1',invoiceId:'i1',idempotencyKey:'collect-old'}));
  await expect(runDurableCollection(scope,'k',vi.fn(offline),()=>Promise.reject(new TypeError('Failed to fetch')),deps)).rejects.toBeInstanceOf(PendingCollectionError);
  expect(valve.report).toHaveBeenCalledWith(expect.objectContaining({pending:expect.objectContaining({attemptId:'collect-old'})}));
  const reported=valve.report.mock.calls[0][0].pending as {startedAt:string};
  expect(Number.isFinite(Date.parse(reported.startedAt))).toBe(true);
 });
});

describe('khoản thu trước đã bị hoàn tác',()=>{
 it('gỡ dấu, báo rõ, không gửi; lần bấm sau thu bằng khoá MỚI dù nơi gọi vẫn đưa khoá cũ',async()=>{
  seedOldMarker('k-old');
  const send=vi.fn();
  const error=await runDurableCollection(scope,'k-old',send,async()=>row('k-old','REVERSED'),deps).catch(e=>e);
  expect(error).toBeInstanceOf(PriorCollectionSettledError);expect(error).toMatchObject({reversed:true,collectionId:'c1'});
  expect(error.message).toMatch(/hoàn tác/);
  expect(send).not.toHaveBeenCalled();expect(localStorage.getItem(storageKey)).toBeNull();
  // Hộp thu giữ khoá cũ trong bộ nhớ: gửi lại khoá đó thì máy chủ trả kết quả của khoản thu ĐÃ hoàn tác.
  const fresh=vi.fn(async(_key:string)=>receipt({collection_id:'c2'}));
  await expect(runDurableCollection(scope,'k-old',fresh,notFound,deps)).resolves.toMatchObject({collection_id:'c2'});
  expect(fresh).toHaveBeenCalledTimes(1);expect(fresh.mock.calls[0][0]).not.toBe('k-old');
 });
 it('trước khi tính nợ cũng nhận ra đã hoàn tác và gỡ dấu',async()=>{
  seedOldMarker('k-old');
  await expect(reconcilePendingCollection('u1','i1',async()=>row('k-old','REVERSED'),deps)).rejects.toMatchObject({reversed:true});
  expect(localStorage.getItem(storageKey)).toBeNull();
 });
});

describe('phép tra hỏng',()=>{
 it('giữ dấu, báo hộp cảnh báo chung bằng dấu trình dưới dạng chung, không gửi',async()=>{
  seedOldMarker('k-old','2026-11-24T01:59:00.000Z');
  const send=vi.fn();
  const error=await runDurableCollection(scope,'k-new',send,()=>Promise.reject(new TypeError('Failed to fetch')),deps).catch(e=>e);
  expect(error).toBeInstanceOf(PendingCollectionError);
  expect(error.message).toMatch(/thu tiền hoá đơn/);expect(error.message).toMatch(/đang chờ kết quả/);
  expect(send).not.toHaveBeenCalled();expect(marker()?.idempotencyKey).toBe('k-old');
  expect(valve.report).toHaveBeenCalledWith(expect.objectContaining({
   blockedOperation:'thu tiền hoá đơn',
   pending:expect.objectContaining({namespace:'pending-collection',userId:'u1',organizationId:'o1',businessKey:'i1',attemptId:'k-old',requestKey:'k-old',operation:'thu tiền hoá đơn',completedIds:[]}),
  }));
 });
 it('quá 2 phút: hộp cảnh báo cho tự gỡ đúng dấu, có nhật ký; lần sau thu được',async()=>{
  seedOldMarker('k-old','2026-11-24T01:00:00.000Z');
  const real=createPendingValve({now});
  await expect(runDurableCollection(scope,'k-new',vi.fn(),()=>Promise.reject(new TypeError('Failed to fetch')),{now,valve:real})).rejects.toThrow(/đối chiếu/);
  const notice=real.current()!;expect(notice.kind).toBe('stale');
  expect(real.release(notice)).toMatchObject({namespace:'pending-collection',attemptId:'k-old',operation:'thu tiền hoá đơn'});
  expect(localStorage.getItem(storageKey)).toBeNull();expect(real.readLog('u1')).toHaveLength(1);
  const send=vi.fn(async()=>receipt());
  await runDurableCollection(scope,'k-new',send,notFound,{now,valve:real});
  expect(send).toHaveBeenCalledWith('k-new');
 });
 it('dấu đã là của lần gửi khác thì hộp cảnh báo không gỡ',async()=>{
  seedOldMarker('k-old','2026-11-24T01:00:00.000Z');
  const real=createPendingValve({now});
  await expect(runDurableCollection(scope,'k-new',vi.fn(),()=>Promise.reject(new TypeError('Failed to fetch')),{now,valve:real})).rejects.toThrow();
  seedOldMarker('k-other','2026-11-24T01:00:00.000Z');
  expect(()=>real.release(real.current()!)).toThrow(/đã được xử lý ở nơi khác/);
  expect(marker()?.idempotencyKey).toBe('k-other');
 });
});

describe('biên nhận và lưu trữ',()=>{
 it('biên nhận trả nhầm hoá đơn: giữ dấu; lần sau đối chiếu rồi gửi lại khoá cũ, không khoá mới',async()=>{
  const send=vi.fn(async(_key:string)=>receipt({invoice_id:'wrong'}));
  await expect(runDurableCollection(scope,'k1',send,notFound,deps)).rejects.toBeInstanceOf(PendingCollectionError);
  expect(marker()?.idempotencyKey).toBe('k1');
  await expect(runDurableCollection(scope,'k2',send,notFound,deps)).rejects.toBeInstanceOf(PendingCollectionError);
  expect(send.mock.calls.map(call=>call[0])).toEqual(['k1','k1']);
 });
 it('lookup sai hoá đơn/khoá không mở khoá và không gửi',async()=>{
  seedOldMarker('key-old');const send=vi.fn();
  await expect(runDurableCollection(scope,'key-new',send,async()=>({id:'wrong',invoice_id:'i2'}),deps)).rejects.toBeInstanceOf(PendingCollectionError);
  expect(send).not.toHaveBeenCalled();expect(marker()?.idempotencyKey).toBe('key-old');
 });
 it('dấu chỉ lưu định danh lần thu, không lưu số tiền',async()=>{
  await expect(runDurableCollection(scope,'key-old',vi.fn(offline),notFound,deps)).rejects.toThrow();
  expect(Object.keys(marker()!).sort()).toEqual(['idempotencyKey','invoiceId','organizationId','startedAt','userId']);
 });
 it('lỗi nghiệp vụ đã từ chối ở lần gửi đầu không giữ dấu; lỗi lưu trình duyệt chặn trước RPC',async()=>{
  const error={code:'22023',message:'bad input'};
  await expect(runDurableCollection(scope,'key-old',async()=>{throw error;},notFound,deps)).rejects.toBe(error);
  expect(localStorage.length).toBe(0);
  const spy=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('quota');});
  const send=vi.fn();
  await expect(runDurableCollection(scope,'key-new',send,notFound,deps)).rejects.toThrow(/trình duyệt/);
  expect(send).not.toHaveBeenCalled();spy.mockRestore();
 });
});
