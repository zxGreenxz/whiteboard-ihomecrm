import {describe,expect,it,vi} from 'vitest';
import {createFinancialPendingStore,FinancialPendingError,PENDING_SETTLE_MS} from '../financialPending';
import {runFinancialPending} from '../financialPendingAction';
import {FinancialAlreadyRecordedError} from '../financialWorkflowError';
import {createPendingValve} from '../pendingValve';
const scope={namespace:'batch',userId:'u1',organizationId:'o1',businessKey:'b1'};
// 09:00 ngày 24/11/2026 giờ Việt Nam.
const T0=Date.parse('2026-11-24T02:00:00.000Z');
function harness(){
 const map=new Map<string,string>();
 const storage={getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>{map.set(k,v)},removeItem:(k:string)=>{map.delete(k)}};
 let clock=T0;const now=()=>new Date(clock);
 const store=createFinancialPendingStore({storage,now});const valve=createPendingValve({storage,now});
 return {store,valve,now,advance:(ms:number)=>{clock+=ms;}};
}
function fixture(){return harness().store;}
const timeout=async()=>{throw new TypeError('timeout');};

it('completed step plus known later failure stays blocked across a fresh call',async()=>{const store=fixture();await expect(runFinancialPending(scope,async ctx=>{ctx.recordCompleted(['v1']);throw {code:'42501',message:'denied'};},store)).rejects.toMatchObject({code:'42501'});expect(store.read(scope)?.completedIds).toEqual(['v1']);const write=vi.fn();await expect(runFinancialPending(scope,write,store)).rejects.toThrow(/đối chiếu/);expect(write).not.toHaveBeenCalled();});
it('unknown before receipt blocks while explicit business rejection permits corrected request',async()=>{const store=fixture();await expect(runFinancialPending(scope,async()=>{throw {code:'22023'};},store)).rejects.toMatchObject({code:'22023'});expect(store.read(scope)).toBeNull();await expect(runFinancialPending(scope,async()=>{throw new TypeError('timeout');},store)).rejects.toThrow();expect(store.read(scope)).not.toBeNull();});
it('valid completed workflow releases its own attempt only',async()=>{const store=fixture();expect(await runFinancialPending(scope,async ctx=>{ctx.recordCompleted(['v1']);return 'confirmed';},store)).toBe('confirmed');expect(store.read(scope)).toBeNull();});

describe('đối chiếu trong runFinancialPending',()=>{
 it('chữ ký cũ ba tham số vẫn chạy; không có hàm đối chiếu thì dấu cũ chặn và giữ nguyên',async()=>{
  const h=harness();
  await expect(runFinancialPending(scope,timeout,h.store)).rejects.toThrow();
  const prior=h.store.read(scope);expect(prior?.requestKey).toEqual(expect.any(String));
  h.advance(24*60*60*1000);
  const work=vi.fn();
  const error=await runFinancialPending(scope,work,h.store).then(()=>null,(e:unknown)=>e);
  expect(error).toBeInstanceOf(FinancialPendingError);
  expect((error as FinancialPendingError).pending?.attemptId).toBe(prior?.attemptId);
  expect(work).not.toHaveBeenCalled();expect(h.store.read(scope)?.attemptId).toBe(prior?.attemptId);
 });
 it('lưu tên thao tác và ghi chú vào dấu; câu báo gọi đúng thao tác đang kẹt và giờ kẹt',async()=>{
  const h=harness();
  await expect(runFinancialPending(scope,timeout,h.store,{operation:'lập phiếu thu',meta:{type:'INCOME'},valve:h.valve,now:h.now})).rejects.toThrow();
  expect(h.store.read(scope)).toMatchObject({operation:'lập phiếu thu',meta:{type:'INCOME'}});
  expect(h.valve.current()).toBeNull();
  h.advance(30_000);
  await expect(runFinancialPending(scope,vi.fn(),h.store,{operation:'lập phiếu chi',valve:h.valve,now:h.now})).rejects.toThrow('Yêu cầu lập phiếu thu gửi lúc 09:00 ngày 24/11/2026 đang chờ kết quả nên chưa đối chiếu được. Thử lại sau ít phút.');
  expect(h.valve.current()).toMatchObject({kind:'waiting',blockedOperation:'lập phiếu chi'});
  h.advance(PENDING_SETTLE_MS);
  await expect(runFinancialPending(scope,vi.fn(),h.store,{operation:'lập phiếu chi',valve:h.valve,now:h.now})).rejects.toThrow(/Yêu cầu lập phiếu thu gửi lúc 09:00 ngày 24\/11\/2026 chưa xác nhận xong/);
  expect(h.valve.current()).toMatchObject({kind:'stale',pending:{operation:'lập phiếu thu'}});
 });
 it('(a) đúng việc này và đã xong: gỡ dấu, trả kết quả, không ghi lần mới',async()=>{
  const h=harness();h.store.markPending(scope,{requestKey:'old-key'});const work=vi.fn();
  await expect(runFinancialPending(scope,work,h.store,{reconcile:async pending=>({result:'receipt:'+pending.requestKey}),valve:h.valve,now:h.now})).resolves.toBe('receipt:old-key');
  expect(work).not.toHaveBeenCalled();expect(h.store.read(scope)).toBeNull();
 });
 it('(b) lần trước ĐÃ ghi: gỡ dấu, báo mã bản ghi, không ghi lần mới',async()=>{
  const h=harness();h.store.markPending(scope,{requestKey:'old-key'});const work=vi.fn();
  const error=await runFinancialPending(scope,work,h.store,{reconcile:async()=>({outcome:'already-written',message:'Đã có phiếu của lần gửi trước.',recordIds:['pt-11']}),valve:h.valve,now:h.now}).then(()=>null,(e:unknown)=>e);
  expect(error).toBeInstanceOf(FinancialAlreadyRecordedError);
  expect(error).toMatchObject({recordIds:['pt-11'],message:'Đã có phiếu của lần gửi trước. Mã bản ghi: pt-11.'});
  expect(work).not.toHaveBeenCalled();expect(h.store.read(scope)).toBeNull();expect(h.valve.current()).toBeNull();
 });
 it('(c) lần trước CHƯA ghi và dấu đã quá 2 phút: gỡ dấu rồi gửi lại với đúng mã yêu cầu cũ',async()=>{
  const h=harness();const prior=h.store.markPending(scope,{requestKey:'old-key'});h.advance(PENDING_SETTLE_MS);
  const seen:{requestKey:string;attemptId:string;stored:string|undefined}[]=[];
  await expect(runFinancialPending(scope,async ctx=>{seen.push({requestKey:ctx.requestKey,attemptId:ctx.attemptId,stored:h.store.read(scope)?.requestKey});return 'written';},h.store,{reconcile:async()=>({outcome:'not-written'}),valve:h.valve,now:h.now})).resolves.toBe('written');
  expect(seen).toEqual([{requestKey:'old-key',attemptId:expect.any(String),stored:'old-key'}]);
  expect(seen[0].attemptId).not.toBe(prior.attemptId);
  expect(h.store.read(scope)).toBeNull();
 });
 it('(c) chưa ghi nhưng dấu chưa quá 2 phút: giữ dấu, không gửi; đủ 2 phút mới gửi',async()=>{
  const h=harness();const prior=h.store.markPending(scope,{requestKey:'old-key'});const work=vi.fn(async()=>'written');
  const options={reconcile:async()=>({outcome:'not-written' as const}),valve:h.valve,now:h.now};
  h.advance(PENDING_SETTLE_MS-1);
  await expect(runFinancialPending(scope,work,h.store,options)).rejects.toThrow(/đang chờ kết quả/);
  expect(work).not.toHaveBeenCalled();expect(h.store.read(scope)?.attemptId).toBe(prior.attemptId);
  h.advance(1);
  await expect(runFinancialPending(scope,work,h.store,options)).resolves.toBe('written');
  expect(work).toHaveBeenCalledTimes(1);
 });
 it('(c) nơi gọi khai máy chủ chống trùng theo mã: gửi lại ngay với mã cũ',async()=>{
  const h=harness();h.store.markPending(scope,{requestKey:'old-key'});let sent='';
  await expect(runFinancialPending(scope,async ctx=>{sent=ctx.requestKey;return 'written';},h.store,{reconcile:async()=>({outcome:'not-written',serverDedupesRequestKey:true}),valve:h.valve,now:h.now})).resolves.toBe('written');
  expect(sent).toBe('old-key');
 });
 it('(d) chưa kết luận được, hoặc phép đối chiếu hỏng: giữ dấu dù đã cũ, báo hộp cảnh báo',async()=>{
  const h=harness();const prior=h.store.markPending(scope,{requestKey:'old-key',operation:'lập phiếu tổng'});h.advance(PENDING_SETTLE_MS*10);const work=vi.fn();
  await expect(runFinancialPending(scope,work,h.store,{reconcile:async()=>null,valve:h.valve,now:h.now})).rejects.toBeInstanceOf(FinancialPendingError);
  const cause=new TypeError('Failed to fetch');
  const error=await runFinancialPending(scope,work,h.store,{reconcile:async()=>{throw cause;},valve:h.valve,now:h.now}).then(()=>null,(e:unknown)=>e);
  expect(error).toBeInstanceOf(FinancialPendingError);expect((error as FinancialPendingError).cause).toBe(cause);
  expect(work).not.toHaveBeenCalled();expect(h.store.read(scope)?.attemptId).toBe(prior.attemptId);
  expect(h.valve.current()).toMatchObject({kind:'stale',pending:{attemptId:prior.attemptId}});
 });
 it('lượt mới không có dấu cũ sinh mã yêu cầu mới mỗi lần',async()=>{
  const h=harness();const keys:string[]=[];
  for(let i=0;i<2;i++)await runFinancialPending(scope,async ctx=>{keys.push(ctx.requestKey);},h.store);
  expect(new Set(keys).size).toBe(2);
 });
});

describe('lượt đang chạy và kết luận lạ dạng',()=>{
 it('bấm lần hai khi lần đầu chưa xong: bị chặn ở trạng thái chờ, không đối chiếu, không cho tự gỡ dù dấu đã cũ',async()=>{
  const h=harness();let finish:(value:string)=>void=()=>{};
  const first=runFinancialPending(scope,()=>new Promise<string>(resolve=>{finish=resolve;}),h.store,{operation:'lập phiếu tổng',valve:h.valve,now:h.now});
  h.advance(PENDING_SETTLE_MS*3);
  const work=vi.fn();const reconcile=vi.fn(async()=>({outcome:'not-written' as const,serverDedupesRequestKey:true}));
  await expect(runFinancialPending(scope,work,h.store,{reconcile,valve:h.valve,now:h.now})).rejects.toThrow(/đang chờ kết quả/);
  expect(work).not.toHaveBeenCalled();expect(reconcile).not.toHaveBeenCalled();
  expect(h.valve.current()?.kind).toBe('waiting');
  expect(()=>h.valve.release(h.valve.current()!)).toThrow(/còn đang chạy/);
  finish('done');await expect(first).resolves.toBe('done');
  expect(h.store.read(scope)).toBeNull();
  expect(h.valve.recheck(h.valve.current()!)).toBe('resolved');
 });
 it('kết luận lạ dạng không được coi là "chưa ghi": giữ dấu, không gửi',async()=>{
  const h=harness();const prior=h.store.markPending(scope);h.advance(PENDING_SETTLE_MS*5);const work=vi.fn();
  for(const strange of [{},{outcome:'done'}]){
   await expect(runFinancialPending(scope,work,h.store,{reconcile:async()=>strange as never,valve:h.valve,now:h.now})).rejects.toBeInstanceOf(FinancialPendingError);
  }
  expect(work).not.toHaveBeenCalled();expect(h.store.read(scope)?.attemptId).toBe(prior.attemptId);
 });
});

describe('releaseCompleted: các bước đã hoàn tất đã được dọn sạch và kiểm lại (đợt 3, phiếu tổng)',()=>{
 it('dọn sạch rồi ném lỗi từ chối rõ ⇒ gỡ dấu như chưa ghi gì',async()=>{
  const h=harness();
  await expect(runFinancialPending(scope,async ctx=>{ctx.recordCompleted(['batch1','v1']);ctx.releaseCompleted();throw {code:'55000',message:'Sổ quỹ đã khoá'};},h.store)).rejects.toMatchObject({code:'55000'});
  expect(h.store.read(scope)).toBeNull();
 });
 it('dọn sạch nhưng lỗi chưa rõ kết quả ⇒ vẫn giữ dấu',async()=>{
  const h=harness();
  await expect(runFinancialPending(scope,async ctx=>{ctx.recordCompleted(['batch1']);ctx.releaseCompleted();throw new TypeError('Failed to fetch');},h.store)).rejects.toThrow();
  expect(h.store.read(scope)?.completedIds).toEqual(['batch1']);
 });
 it('không gọi releaseCompleted ⇒ lỗi từ chối rõ sau bước đã hoàn tất vẫn giữ dấu (như cũ)',async()=>{
  const h=harness();
  await expect(runFinancialPending(scope,async ctx=>{ctx.recordCompleted(['batch1']);throw {code:'55000'};},h.store)).rejects.toMatchObject({code:'55000'});
  expect(h.store.read(scope)?.completedIds).toEqual(['batch1']);
 });
});
