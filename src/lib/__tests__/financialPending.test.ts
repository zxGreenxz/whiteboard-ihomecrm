import {expect,it,vi} from 'vitest';
import {createFinancialPendingStore,FinancialPendingError,formatPendingTime,isAttemptRunning,pendingHasSettled,PENDING_SETTLE_MS,trackRunningAttempt} from '../financialPending';
const scope={namespace:'voucher-create',userId:'u1',organizationId:'o1',businessKey:'b1'};
const storageKey='ihome:financial-pending:v1:voucher-create:u1:o1:b1';
function fixture(){const map=new Map<string,string>();const storage={getItem:(key:string)=>map.get(key)??null,setItem:(key:string,value:string)=>{map.set(key,value)},removeItem:(key:string)=>{map.delete(key)}};return {map,storage,store:createFinancialPendingStore({storage,now:()=>new Date('2026-09-30T00:00:00Z')})};}
it('pending sống qua store mới, chặn create mới và chỉ lưu metadata tối thiểu',()=>{const f=fixture();const first=f.store.markPending(scope,{attemptId:'a1',requestKey:'k1'});expect(first.startedAt).toBe('2026-09-30T00:00:00.000Z');const next=createFinancialPendingStore({storage:f.storage});expect(()=>next.markPending(scope)).toThrow(FinancialPendingError);expect(next.read(scope)).toMatchObject({attemptId:'a1',requestKey:'k1',completedIds:[]});expect(JSON.parse([...f.map.values()][0])).not.toHaveProperty('amount');});
it('giữ IDs partial, attempt cũ không được xóa khóa của attempt khác',()=>{const f=fixture();f.store.markPending(scope,{attemptId:'a1'});f.store.recordCompleted(scope,'a1',['v1','v2','v1']);expect(f.store.read(scope)?.completedIds).toEqual(['v1','v2']);expect(f.store.clearConfirmed(scope,'wrong')).toBe(false);expect(f.store.read(scope)).not.toBeNull();expect(f.store.clearConfirmed(scope,'a1')).toBe(true);expect(f.store.read(scope)).toBeNull();});
it('cách ly theo user/org/namespace và từ chối record malformed',()=>{const f=fixture();f.store.markPending(scope,{attemptId:'a1'});expect(f.store.read({...scope,userId:'u2'})).toBeNull();expect(f.store.read({...scope,organizationId:'o2'})).toBeNull();f.map.set([...f.map.keys()][0],'{');expect(()=>f.store.markPending(scope)).toThrow(/đối chiếu|trình duyệt/);});
it('storage lỗi chặn mark trước request và không giả clear thành công',()=>{const storage={getItem:()=>null,setItem:vi.fn(()=>{throw new Error('quota')}),removeItem:vi.fn()};const f=createFinancialPendingStore({storage});expect(()=>f.markPending(scope,{attemptId:'a1'})).toThrow(/trình duyệt/);expect(storage.removeItem).not.toHaveBeenCalled();});

it('dấu lưu tên thao tác và ghi chú nguyên thuỷ, giữ qua các lần ghi mã hoàn tất; khoá lưu không đổi',()=>{
 const f=fixture();
 f.store.markPending(scope,{attemptId:'a1',requestKey:'k1',operation:'  duyệt phiếu  ',meta:{verifiedBefore:false,version:3,note:null,status:'UNAPPROVED'}});
 expect([...f.map.keys()]).toEqual([storageKey]);
 expect(f.store.read(scope)).toMatchObject({operation:'duyệt phiếu',meta:{verifiedBefore:false,version:3,note:null,status:'UNAPPROVED'}});
 expect(f.store.recordCompleted(scope,'a1',['v1'])).toMatchObject({operation:'duyệt phiếu',meta:{version:3},completedIds:['v1']});
});
it('đọc được dấu cũ không có tên thao tác và ghi chú',()=>{
 const f=fixture();
 f.map.set(storageKey,JSON.stringify({...scope,attemptId:'a-old',requestKey:'k-old',completedIds:['v9'],startedAt:'2026-09-01T00:00:00.000Z'}));
 const row=f.store.read(scope);
 expect(row).toEqual({...scope,attemptId:'a-old',requestKey:'k-old',completedIds:['v9'],startedAt:'2026-09-01T00:00:00.000Z'});
 expect(row).not.toHaveProperty('operation');expect(row).not.toHaveProperty('meta');
 expect(f.store.clearConfirmed(scope,'a-old')).toBe(true);
});
it('tên thao tác hoặc ghi chú sai dạng thì bỏ ô đó, không coi cả dấu là hỏng',()=>{
 const f=fixture();
 f.map.set(storageKey,JSON.stringify({...scope,attemptId:'a1',completedIds:[],startedAt:'2026-09-01T00:00:00.000Z',operation:42,meta:{nested:{amount:1}}}));
 const row=f.store.read(scope);
 expect(row?.attemptId).toBe('a1');expect(row).not.toHaveProperty('operation');expect(row).not.toHaveProperty('meta');
 const g=fixture();
 expect(g.store.markPending(scope,{operation:'x'.repeat(500),meta:{list:[1] as unknown as string}})).not.toHaveProperty('meta');
 expect(g.store.read(scope)?.operation).toHaveLength(200);
});
it('ngưỡng 2 phút: dưới ngưỡng là chưa chắc đã kết thúc, đủ ngưỡng là đã kết thúc',()=>{
 expect(PENDING_SETTLE_MS).toBe(120_000);
 const startedAt='2026-11-24T02:00:00.000Z',at=(ms:number)=>new Date(Date.parse(startedAt)+ms);
 expect(pendingHasSettled({startedAt},at(0))).toBe(false);
 expect(pendingHasSettled({startedAt},at(119_999))).toBe(false);
 expect(pendingHasSettled({startedAt},at(120_000))).toBe(true);
 // Đồng hồ máy bị chỉnh lùi: dấu mang giờ tương lai gần vẫn phải chờ, lệch quá ngưỡng thì không chờ tới giờ đó.
 expect(pendingHasSettled({startedAt},at(-30_000))).toBe(false);
 expect(pendingHasSettled({startedAt},at(-24*60*60*1000))).toBe(true);
});
it('giờ kẹt hiển thị theo giờ Việt Nam, không theo giờ máy',()=>{
 expect(formatPendingTime('2026-11-24T02:05:00.000Z')).toBe('09:05 ngày 24/11/2026');
 expect(formatPendingTime('2026-11-23T17:30:00.000Z')).toBe('00:30 ngày 24/11/2026');
});
it('ghi mã hoàn tất cập nhật giờ hoạt động cuối; ngưỡng tính từ đó; giờ sai dạng thì bỏ',()=>{
 let clock=Date.parse('2026-11-24T02:00:00.000Z');const map=new Map<string,string>();
 const store=createFinancialPendingStore({storage:{getItem:k=>map.get(k)??null,setItem:(k,v)=>{map.set(k,v)},removeItem:k=>{map.delete(k)}},now:()=>new Date(clock)});
 store.markPending(scope,{attemptId:'a1'});
 expect(store.read(scope)).not.toHaveProperty('activeAt');
 clock+=10*60_000;
 const row=store.recordCompleted(scope,'a1',['v1']);
 expect(row).toMatchObject({startedAt:'2026-11-24T02:00:00.000Z',activeAt:'2026-11-24T02:10:00.000Z'});
 expect(pendingHasSettled(row,new Date(clock+119_999))).toBe(false);
 expect(pendingHasSettled(row,new Date(clock+120_000))).toBe(true);
 map.set(storageKey,JSON.stringify({...row,activeAt:'hôm qua'}));
 expect(store.read(scope)).not.toHaveProperty('activeAt');
});
it('dấu của lượt đang chạy trong tab chưa kết thúc dù đã cũ; đếm theo số lượt đang chạy',()=>{
 const pending={attemptId:'dang-chay-1',startedAt:'2026-11-01T00:00:00.000Z'},now=new Date('2026-11-24T02:00:00.000Z');
 expect(pendingHasSettled(pending,now)).toBe(true);
 const stopA=trackRunningAttempt('dang-chay-1'),stopB=trackRunningAttempt('dang-chay-1');
 expect(isAttemptRunning('dang-chay-1')).toBe(true);expect(pendingHasSettled(pending,now)).toBe(false);
 stopA();stopA();
 expect(pendingHasSettled(pending,now)).toBe(false);
 stopB();
 expect(isAttemptRunning('dang-chay-1')).toBe(false);expect(pendingHasSettled(pending,now)).toBe(true);
 expect(pendingHasSettled({...pending,attemptId:'khac'},now)).toBe(true);
});
it('ghi lại đúng các mã đã có không phải hoạt động mới: đồng hồ không bị làm mới',()=>{
 let clock=Date.parse('2026-11-24T02:00:00.000Z');const map=new Map<string,string>();
 const store=createFinancialPendingStore({storage:{getItem:k=>map.get(k)??null,setItem:(k,v)=>{map.set(k,v)},removeItem:k=>{map.delete(k)}},now:()=>new Date(clock)});
 store.markPending(scope,{attemptId:'a1'});store.recordCompleted(scope,'a1',['v1']);
 clock+=10*60_000;
 expect(store.recordCompleted(scope,'a1',['v1']).activeAt).toBe('2026-11-24T02:00:00.000Z');
 expect(store.recordCompleted(scope,'a1',[]).activeAt).toBe('2026-11-24T02:00:00.000Z');
 expect(store.recordCompleted(scope,'a1',['v2']).activeAt).toBe('2026-11-24T02:10:00.000Z');
});
