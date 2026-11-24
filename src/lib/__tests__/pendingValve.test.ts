import {describe,expect,it,vi} from 'vitest';
import {createFinancialPendingStore,FinancialPendingStorageError,PENDING_SETTLE_MS} from '../financialPending';
import {createPendingValve,pendingBlockMessage,pendingOperationName,PendingValveError,type PendingValveStore} from '../pendingValve';

// 09:00 ngày 24/11/2026 giờ Việt Nam.
const T0=Date.parse('2026-11-24T02:00:00.000Z');
const scope={namespace:'voucher-form-create',userId:'u1',organizationId:'o1',businessKey:'INCOME:b1:'};
const logStorageKey='ihome:pending-valve-log:v1:u1';
function harness(){
 const map=new Map<string,string>();
 const failing={setItem:false};
 const storage={
  getItem:(key:string)=>map.get(key)??null,
  setItem:(key:string,value:string)=>{if(failing.setItem)throw new Error('quota');map.set(key,value);},
  removeItem:(key:string)=>{map.delete(key);},
 };
 let clock=T0;const now=()=>new Date(clock);
 const store=createFinancialPendingStore({storage,now});
 const valve=createPendingValve({storage,now});
 return {map,failing,store,valve,advance:(ms:number)=>{clock+=ms;}};
}
function blocked(h:ReturnType<typeof harness>,target=scope,blockedOperation:string|null='lập phiếu thu'){
 const pending=h.store.read(target);if(!pending)throw new Error('thiếu dấu');
 h.valve.report({pending,blockedOperation,store:h.store});
 return h.valve.current()!;
}

describe('lời báo bị chặn',()=>{
 it('dấu dưới 2 phút là đang chờ, đủ 2 phút là được tự gỡ',()=>{
  const h=harness();h.store.markPending(scope,{attemptId:'a1',operation:'lập phiếu thu'});
  h.advance(PENDING_SETTLE_MS-1);expect(blocked(h).kind).toBe('waiting');
  h.advance(1);expect(blocked(h).kind).toBe('stale');
 });
 it('cùng một dấu báo nhiều lần chỉ giữ một lời báo; dấu khác xếp hàng sau',()=>{
  const h=harness();const other={...scope,businessKey:'EXPENSE:b2:'};
  h.store.markPending(scope,{attemptId:'a1'});h.store.markPending(other,{attemptId:'a2'});
  const first=blocked(h);blocked(h,other);blocked(h);
  expect(h.valve.waitingCount()).toBe(2);
  expect(h.valve.current()?.pending.attemptId).toBe('a1');
  // Lời báo đầu hàng đổi tham chiếu khi được báo lại; hàng chờ không đổi thì tham chiếu giữ nguyên.
  expect(h.valve.current()).not.toBe(first);
  expect(h.valve.current()).toBe(h.valve.current());
  h.valve.dismiss(h.valve.current()!);
  expect(h.valve.current()?.pending.attemptId).toBe('a2');
  expect(h.store.read(scope)?.attemptId).toBe('a1');
 });
 it('gọi người nghe mỗi khi hàng chờ đổi và thôi gọi sau khi huỷ đăng ký',()=>{
  const h=harness();h.store.markPending(scope,{attemptId:'a1'});const listener=vi.fn();
  const unsubscribe=h.valve.subscribe(listener);
  const notice=blocked(h);expect(listener).toHaveBeenCalledTimes(1);
  unsubscribe();h.valve.dismiss(notice);expect(listener).toHaveBeenCalledTimes(1);
 });
 it('tên việc đang kẹt lấy từ dấu; dấu cũ thì lấy nhãn namespace; namespace lạ thì không có tên',()=>{
  expect(pendingOperationName({operation:'duyệt phiếu',namespace:'voucher-lifecycle'})).toBe('duyệt phiếu');
  expect(pendingOperationName({namespace:'voucher-form-create'})).toBe('lập phiếu thu/chi');
  expect(pendingOperationName({namespace:'toString'})).toBeNull();
  const pending={...scope,attemptId:'a1',completedIds:[],startedAt:'2026-11-24T02:00:00.000Z'};
  expect(pendingBlockMessage(pending,false)).toBe('Yêu cầu lập phiếu thu/chi gửi lúc 09:00 ngày 24/11/2026 đang chờ kết quả nên chưa đối chiếu được. Thử lại sau ít phút.');
  expect(pendingBlockMessage({...pending,namespace:'la'},true)).toContain('Một yêu cầu trước đó gửi lúc 09:00 ngày 24/11/2026 chưa xác nhận xong.');
  expect(pendingBlockMessage(pending,true)).toContain('hộp cảnh báo cho phép làm tiếp');
  // Trang công khai không có hộp cảnh báo nên câu báo không được nhắc tới nó.
  const silent=pendingBlockMessage({...pending,namespace:'lucky-public-draw'},true);
  expect(silent).toBe('Yêu cầu quay số gửi lúc 09:00 ngày 24/11/2026 chưa xác nhận xong. Kiểm tra bản ghi liên quan để đối chiếu trước khi thực hiện tiếp. Tải lại trang không hủy yêu cầu đã gửi.');
 });
 it('namespace khai `silent` (trang công khai) không mở hộp cảnh báo',()=>{
  const h=harness();const publicScope={namespace:'lucky-public-draw',userId:'public-viewer',organizationId:'public-event',businessKey:'ev1'};
  h.store.markPending(publicScope,{attemptId:'a1'});h.advance(PENDING_SETTLE_MS);
  h.valve.report({pending:h.store.read(publicScope)!,blockedOperation:'xác nhận kết quả quay',store:h.store});
  expect(h.valve.current()).toBeNull();expect(h.valve.waitingCount()).toBe(0);
 });
});

describe('«Kiểm tra lại»',()=>{
 it('chuyển từ đang chờ sang được tự gỡ khi đã đủ 2 phút, và mang theo mã bản ghi mới nhất',()=>{
  const h=harness();h.store.markPending(scope,{attemptId:'a1'});
  const notice=blocked(h);expect(notice.kind).toBe('waiting');
  expect(h.valve.recheck(notice)).toBe('waiting');
  h.store.recordCompleted(scope,'a1',['pt-01']);h.advance(PENDING_SETTLE_MS);
  expect(h.valve.recheck(h.valve.current()!)).toBe('stale');
  expect(h.valve.current()).toMatchObject({kind:'stale',pending:{completedIds:['pt-01']}});
 });
 it('thôi báo khi dấu đã được gỡ hoặc đã là dấu của lần gửi khác',()=>{
  const h=harness();h.store.markPending(scope,{attemptId:'a1'});
  const gone=blocked(h);h.store.clearConfirmed(scope,'a1');
  expect(h.valve.recheck(gone)).toBe('resolved');expect(h.valve.current()).toBeNull();
  h.store.markPending(scope,{attemptId:'a2'});const replaced=blocked(h);
  h.store.clearConfirmed(scope,'a2');h.store.markPending(scope,{attemptId:'a3'});
  expect(h.valve.recheck(replaced)).toBe('resolved');
  expect(h.store.read(scope)?.attemptId).toBe('a3');
 });
});

describe('«Đã kiểm tra, cho làm tiếp»',()=>{
 it('không cho gỡ dấu chưa quá 2 phút và không ghi nhật ký',()=>{
  const h=harness();h.store.markPending(scope,{attemptId:'a1'});h.advance(PENDING_SETTLE_MS-1);
  const notice=blocked(h);
  expect(()=>h.valve.release(notice)).toThrow(PendingValveError);
  expect(()=>h.valve.release(notice)).toThrow(/chưa đầy 2 phút/);
  expect(h.store.read(scope)?.attemptId).toBe('a1');
  expect(h.valve.readLog('u1')).toEqual([]);
  expect(h.valve.current()).toBe(notice);
 });
 it('lời báo cũ từng là "được tự gỡ" vẫn bị từ chối nếu dấu hiện tại chưa quá 2 phút',()=>{
  const h=harness();h.store.markPending(scope,{attemptId:'a1'});h.advance(PENDING_SETTLE_MS);
  const stale=blocked(h);expect(stale.kind).toBe('stale');
  // Cùng mã lần gửi nhưng dấu được ghi lại gần đây: quyết định theo dấu đang nằm trong kho, không theo lời báo.
  h.store.clearConfirmed(scope,'a1');h.store.markPending(scope,{attemptId:'a1'});
  expect(()=>h.valve.release(stale)).toThrow(/chưa đầy 2 phút/);
  expect(h.store.read(scope)).not.toBeNull();expect(h.valve.readLog('u1')).toEqual([]);
 });
 it('gỡ ĐÚNG dấu đã xác nhận, không đụng dấu khác, và ghi một dòng nhật ký đủ thông tin',()=>{
  const h=harness();const other={...scope,businessKey:'EXPENSE:b2:'},otherUser={...scope,userId:'u2'};
  h.store.markPending(scope,{attemptId:'a1',requestKey:'k1',operation:'lập phiếu thu'});h.store.recordCompleted(scope,'a1',['pt-01','pt-02']);
  h.store.markPending(other,{attemptId:'a2'});h.store.markPending(otherUser,{attemptId:'a3'});
  h.advance(5*60_000);
  const notice=blocked(h);blocked(h,other);
  const entry=h.valve.release(notice);
  expect(h.store.read(scope)).toBeNull();
  expect(h.store.read(other)?.attemptId).toBe('a2');
  expect(h.store.read(otherUser)?.attemptId).toBe('a3');
  expect(entry).toEqual({
   id:expect.stringMatching(/^[a-f0-9-]{36}$/i),userId:'u1',organizationId:'o1',namespace:'voucher-form-create',businessKey:'INCOME:b1:',
   operation:'lập phiếu thu',attemptId:'a1',recordIds:['pt-01','pt-02'],stuckAt:'2026-11-24T02:00:00.000Z',releasedAt:'2026-11-24T02:05:00.000Z',
  });
  expect(h.valve.readLog('u1')).toEqual([entry]);
  expect(JSON.parse(h.map.get(logStorageKey)!)).toEqual([entry]);
  expect(h.valve.readLog('u2')).toEqual([]);
  expect(h.valve.current()?.pending.attemptId).toBe('a2');
 });
 it('dấu cũ không có tên thao tác: nhật ký ghi nhãn của namespace',()=>{
  const h=harness();
  h.map.set('ihome:financial-pending:v1:voucher-form-create:u1:o1:INCOME%3Ab1%3A',JSON.stringify({...scope,attemptId:'a-old',completedIds:[],startedAt:'2026-11-20T03:30:00.000Z'}));
  expect(h.valve.release(blocked(h))).toMatchObject({operation:'lập phiếu thu/chi',attemptId:'a-old',stuckAt:'2026-11-20T03:30:00.000Z'});
 });
 it('dấu đã là của lần gửi khác: không gỡ, không ghi nhật ký',()=>{
  const h=harness();h.store.markPending(scope,{attemptId:'a1'});h.advance(PENDING_SETTLE_MS);
  const notice=blocked(h);
  h.store.clearConfirmed(scope,'a1');h.advance(PENDING_SETTLE_MS);h.store.markPending(scope,{attemptId:'a2'});h.advance(PENDING_SETTLE_MS);
  expect(()=>h.valve.release(notice)).toThrow(/đã được xử lý ở nơi khác/);
  expect(h.store.read(scope)?.attemptId).toBe('a2');
  expect(h.valve.readLog('u1')).toEqual([]);expect(h.valve.current()).toBeNull();
 });
 it('không ghi được nhật ký thì không gỡ dấu',()=>{
  const h=harness();h.store.markPending(scope,{attemptId:'a1'});h.advance(PENDING_SETTLE_MS);
  const notice=blocked(h);h.failing.setItem=true;
  expect(()=>h.valve.release(notice)).toThrow(FinancialPendingStorageError);
  h.failing.setItem=false;
  expect(h.store.read(scope)?.attemptId).toBe('a1');
  expect(h.valve.readLog('u1')).toEqual([]);
  expect(h.valve.current()).toBe(notice);
 });
 it('nhật ký hỏng định dạng thì không gỡ dấu, không ghi đè nhật ký',()=>{
  const h=harness();h.store.markPending(scope,{attemptId:'a1'});h.advance(PENDING_SETTLE_MS);
  h.map.set(logStorageKey,'[{"id":1}]');
  expect(()=>h.valve.release(blocked(h))).toThrow(FinancialPendingStorageError);
  expect(h.store.read(scope)?.attemptId).toBe('a1');expect(h.map.get(logStorageKey)).toBe('[{"id":1}]');
 });
 it('gỡ dấu hỏng sau khi đã ghi nhật ký thì rút lại dòng nhật ký',()=>{
  const h=harness();h.store.markPending(scope,{attemptId:'a1'});h.advance(PENDING_SETTLE_MS);
  const pending=h.store.read(scope)!;
  const store={read:h.store.read,clearConfirmed:()=>{throw new FinancialPendingStorageError();}};
  h.valve.report({pending,store});
  expect(()=>h.valve.release(h.valve.current()!)).toThrow(FinancialPendingStorageError);
  expect(h.valve.readLog('u1')).toEqual([]);expect(h.store.read(scope)?.attemptId).toBe('a1');
 });
});

describe('kho dấu riêng dùng hộp cảnh báo chung',()=>{
 // Mẫu cho các kho không đi qua lõi (thu tiền hoá đơn, sửa hợp đồng, giấy cọc): tự viết `read` và
 // `clearConfirmed` trên kho của mình, trình dấu dưới dạng FinancialPendingRecord.
 interface OwnRow {userId:string;organizationId:string;invoiceId:string;idempotencyKey:string;startedAt:string}
 function ownStore(){
  const rows=new Map<string,OwnRow>();
  const keyOf=(userId:string,organizationId:string,invoiceId:string)=>[userId,organizationId,invoiceId].join('|');
  const asPending=(row:OwnRow)=>({namespace:'pending-collection',userId:row.userId,organizationId:row.organizationId,businessKey:row.invoiceId,attemptId:row.idempotencyKey,requestKey:row.idempotencyKey,completedIds:[] as string[],startedAt:row.startedAt,operation:'thu tiền hoá đơn'});
  const store:PendingValveStore={
   read:scope=>{const row=rows.get(keyOf(scope.userId,scope.organizationId,scope.businessKey));return row?asPending(row):null;},
   clearConfirmed:(scope,attemptId)=>{const key=keyOf(scope.userId,scope.organizationId,scope.businessKey);if(rows.get(key)?.idempotencyKey!==attemptId)return false;rows.delete(key);return true;},
  };
  return {rows,keyOf,asPending,store};
 }
 it('báo, kiểm tra lại và tự gỡ đi qua đúng hai hàm của kho riêng; nhật ký ghi như dấu của lõi',()=>{
  const h=harness();const own=ownStore();
  const row:OwnRow={userId:'u1',organizationId:'o1',invoiceId:'hd-9',idempotencyKey:'thu-1',startedAt:'2026-11-24T02:00:00.000Z'};
  own.rows.set(own.keyOf('u1','o1','hd-9'),row);
  h.advance(60_000);
  h.valve.report({pending:own.asPending(row),blockedOperation:'thu tiền hoá đơn',store:own.store});
  expect(h.valve.current()?.kind).toBe('waiting');
  expect(()=>h.valve.release(h.valve.current()!)).toThrow(/chưa đầy 2 phút/);
  h.advance(60_000);
  expect(h.valve.recheck(h.valve.current()!)).toBe('stale');
  expect(h.valve.release(h.valve.current()!)).toMatchObject({namespace:'pending-collection',businessKey:'hd-9',attemptId:'thu-1',operation:'thu tiền hoá đơn',stuckAt:row.startedAt});
  expect(own.rows.size).toBe(0);expect(h.valve.readLog('u1')).toHaveLength(1);
 });
 it('kho riêng đã ghi dấu của lần gửi khác thì không gỡ',()=>{
  const h=harness();const own=ownStore();
  const row:OwnRow={userId:'u1',organizationId:'o1',invoiceId:'hd-9',idempotencyKey:'thu-1',startedAt:'2026-11-24T01:00:00.000Z'};
  own.rows.set(own.keyOf('u1','o1','hd-9'),row);
  h.valve.report({pending:own.asPending(row),store:own.store});
  own.rows.set(own.keyOf('u1','o1','hd-9'),{...row,idempotencyKey:'thu-2'});
  expect(()=>h.valve.release(h.valve.current()!)).toThrow(/đã được xử lý ở nơi khác/);
  expect(own.rows.get(own.keyOf('u1','o1','hd-9'))?.idempotencyKey).toBe('thu-2');expect(h.valve.readLog('u1')).toEqual([]);
 });
});

describe('hàng đợi nhật ký chờ đẩy lên máy chủ',()=>{
 it('giữ thứ tự cũ trước; xác nhận đã đẩy thì chỉ bỏ đúng các dòng đó',()=>{
  const h=harness();const other={...scope,businessKey:'EXPENSE:b2:'};
  h.store.markPending(scope,{attemptId:'a1'});h.store.markPending(other,{attemptId:'a2'});h.advance(PENDING_SETTLE_MS);
  const first=h.valve.release(blocked(h));h.advance(1000);const second=h.valve.release(blocked(h,other));
  expect(h.valve.readLog('u1').map(entry=>entry.attemptId)).toEqual(['a1','a2']);
  h.valve.acknowledgeLog('u1',[first.id]);
  expect(h.valve.readLog('u1')).toEqual([second]);
  h.valve.acknowledgeLog('u1',['khong-co']);
  expect(h.valve.readLog('u1')).toEqual([second]);
 });
});

describe('đẩy nhật ký lên máy chủ (đợt 1b)',()=>{
 function withHook(onRelease:(entry:unknown)=>void){
  const h=harness();
  const map=h.map;const storage={getItem:(key:string)=>map.get(key)??null,setItem:(key:string,value:string)=>{if(h.failing.setItem)throw new Error('quota');map.set(key,value);}};
  const valve=createPendingValve({storage,now:()=>new Date(T0+PENDING_SETTLE_MS),onRelease});
  return {...h,valve};
 }
 it('báo cho bên đẩy SAU khi đã ghi nhật ký và gỡ dấu, với đúng dòng vừa ghi',()=>{
  const seen:unknown[]=[];let clearedWhenNotified:boolean|null=null;let loggedWhenNotified=0;
  const h=withHook(entry=>{seen.push(entry);clearedWhenNotified=h.store.read(scope)===null;loggedWhenNotified=h.valve.readLog('u1').length;});
  h.store.markPending(scope,{attemptId:'a1'});
  h.valve.report({pending:h.store.read(scope)!,store:h.store});
  const entry=h.valve.release(h.valve.current()!);
  expect(seen).toEqual([entry]);expect(clearedWhenNotified).toBe(true);expect(loggedWhenNotified).toBe(1);
  expect(h.valve.readLog('u1')).toEqual([entry]);
 });
 it('bên đẩy lỗi không làm hỏng lần gỡ; gỡ không thành thì không báo đẩy',()=>{
  const onRelease=vi.fn(()=>{throw new Error('không nạp được module đẩy');});
  const h=withHook(onRelease);
  h.store.markPending(scope,{attemptId:'a1'});
  h.valve.report({pending:h.store.read(scope)!,store:h.store});
  const entry=h.valve.release(h.valve.current()!);
  expect(entry.attemptId).toBe('a1');expect(h.store.read(scope)).toBeNull();expect(onRelease).toHaveBeenCalledTimes(1);
  h.store.markPending(scope,{attemptId:'a2'});
  h.valve.report({pending:h.store.read(scope)!,store:h.store});
  h.failing.setItem=true;
  expect(()=>h.valve.release(h.valve.current()!)).toThrow(FinancialPendingStorageError);
  expect(onRelease).toHaveBeenCalledTimes(1);
  // Kho báo dấu đã là của lần gửi khác ngay lúc gỡ: không gỡ, dòng nhật ký bị rút lại, không báo đẩy.
  h.failing.setItem=false;
  const pending=h.store.read(scope)!;
  h.valve.report({pending,store:{read:h.store.read,clearConfirmed:()=>false}});
  expect(()=>h.valve.release(h.valve.current()!)).toThrow(/đã được xử lý ở nơi khác/);
  expect(onRelease).toHaveBeenCalledTimes(1);
  expect(h.valve.readLog('u1')).toHaveLength(1);
 });
});

describe('tín hiệu nạp hộp cảnh báo',()=>{
 it('mỗi lời báo gọi onReport một lần; namespace silent thì không',()=>{
  const map=new Map<string,string>();const storage={getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>{map.set(k,v);},removeItem:(k:string)=>{map.delete(k);}};
  const store=createFinancialPendingStore({storage,now:()=>new Date(T0)});const onReport=vi.fn();
  const valve=createPendingValve({storage,now:()=>new Date(T0),onReport});
  store.markPending(scope,{attemptId:'a1'});
  valve.report({pending:store.read(scope)!,store});valve.report({pending:store.read(scope)!,store});
  expect(onReport).toHaveBeenCalledTimes(2);
  const publicScope={namespace:'lucky-public-draw',userId:'public-viewer',organizationId:'public-event',businessKey:'ev1'};
  store.markPending(publicScope,{attemptId:'p1'});valve.report({pending:store.read(publicScope)!,store});
  expect(onReport).toHaveBeenCalledTimes(2);
 });
});
