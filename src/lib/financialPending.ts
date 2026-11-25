/** Durable coordination only. Domain code must verify server state before clearConfirmed. */
export interface FinancialPendingScope {namespace:string;userId:string;organizationId:string;businessKey:string}
/** Vài giá trị nguyên thuỷ nơi gọi cần nhớ để đối chiếu (ví dụ trạng thái trước khi bấm). Không chứa tên khách hay số tiền. */
export type FinancialPendingMeta=Record<string,string|number|boolean|null>;
export interface FinancialPendingRecord extends FinancialPendingScope {
  attemptId:string;requestKey?:string;completedIds:string[];startedAt:string;
  /** Lần gần nhất lượt ghi này báo xong một bước. Lượt nhiều bước (nhập Excel, đợt phiếu) chạy lâu hơn ngưỡng, nên ngưỡng tính từ đây. */
  activeAt?:string;
  /** Tên thao tác đã gửi, để câu báo gọi đúng việc đang kẹt. Dấu ghi trước 24/11/2026 không có. Không chứa tên khách hay số tiền. */
  operation?:string;
  meta?:FinancialPendingMeta;
}
/**
 * Kết luận của hàm đối chiếu sau khi đọc trạng thái thật trên máy chủ:
 * - `{result}`: đúng việc này và đã xong. Gỡ dấu, trả kết quả, không ghi lần mới.
 * - `already-written`: lần trước ĐÃ ghi. Gỡ dấu, báo người dùng kèm mã bản ghi, không ghi lần mới.
 * - `not-written`: lần trước CHƯA ghi và không bước nào của nó còn hiệu lực (kể cả các mã trong `completedIds`).
 *   Gỡ dấu rồi chạy lại với CÙNG mã yêu cầu. Chỉ được nhận khi dấu đã quá `PENDING_SETTLE_MS`, hoặc nơi gọi khai
 *   `serverDedupesRequestKey` (máy chủ chống trùng theo mã yêu cầu nên gửi lại sớm cũng không ghi hai lần).
 * - `null`: chưa kết luận được. Giữ dấu.
 */
export type PendingReconciliation<T>=
  |{result:T}
  |{outcome:'already-written';message:string;recordIds?:readonly string[]}
  |{outcome:'not-written';serverDedupesRequestKey?:boolean}
  |null;
/**
 * Quá ngưỡng này thì lần gửi trước chắc chắn đã kết thúc trên máy chủ: vai trò `authenticated` bị cắt lệnh sau
 * 8 giây (đo production 24/11/2026, không hàm public nào tự nới). Dưới ngưỡng, "chưa thấy trên máy chủ" chưa
 * chứng minh được "chưa ghi" vì lệnh có thể còn đang chạy.
 */
export const PENDING_SETTLE_MS=120_000;
// Lượt ghi đang chạy dở trong chính tab này (mỗi dấu một `attemptId`). Dấu của nó chưa thể coi là đã kết thúc dù đã
// cũ tới đâu: vòng lặp nhiều bước có thể vẫn đang gửi lệnh ở nền sau khi người dùng đóng hộp nhập.
const runningAttempts=new Map<string,number>();
/** Lõi gọi trong suốt lúc task hoặc phép đối chiếu của một dấu đang chạy; gọi hàm trả về khi xong. */
export function trackRunningAttempt(attemptId:string):()=>void{
  runningAttempts.set(attemptId,(runningAttempts.get(attemptId)??0)+1);
  let done=false;
  return ()=>{
    if(done)return;done=true;
    const left=(runningAttempts.get(attemptId)??1)-1;
    if(left>0)runningAttempts.set(attemptId,left);else runningAttempts.delete(attemptId);
  };
}
export const isAttemptRunning=(attemptId:string):boolean=>runningAttempts.has(attemptId);
/**
 * Lần gửi của dấu này chắc chắn đã kết thúc chưa: không còn chạy trong tab này VÀ đã quá ngưỡng kể từ hoạt động
 * cuối (`activeAt`, không có thì `startedAt`). Đồng hồ máy bị chỉnh lùi làm dấu mang giờ ở tương lai: lệch quá
 * ngưỡng về phía nào cũng coi là đã qua, nếu không dấu sẽ chờ tới đúng giờ đó.
 */
export function pendingHasSettled(pending:Pick<FinancialPendingRecord,'startedAt'>&Partial<Pick<FinancialPendingRecord,'attemptId'|'activeAt'>>,now:Date=new Date()):boolean{
  if(pending.attemptId&&isAttemptRunning(pending.attemptId))return false;
  return Math.abs(now.getTime()-Date.parse(pending.activeAt??pending.startedAt))>=PENDING_SETTLE_MS;
}
const pendingClock=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Ho_Chi_Minh',hour:'2-digit',minute:'2-digit',day:'2-digit',month:'2-digit',year:'numeric',hourCycle:'h23'});
/** Giờ kẹt theo giờ Việt Nam: "09:12 ngày 24/11/2026". */
export function formatPendingTime(startedAt:string):string{
  const parts=Object.fromEntries(pendingClock.formatToParts(new Date(startedAt)).map(part=>[part.type,part.value]));
  return `${parts.hour}:${parts.minute} ngày ${parts.day}/${parts.month}/${parts.year}`;
}
export class FinancialPendingError extends TypeError {
  constructor(public readonly pending:FinancialPendingRecord|null,message='Thao tác trước chưa được đối chiếu. Mở các chứng từ đã tạo và kiểm tra với quản lý trước khi thực hiện tiếp.',public readonly cause?:unknown){super(message);this.name='FinancialPendingError';}
}
export class FinancialPendingStorageError extends TypeError {
  constructor(){super('Chưa đọc hoặc lưu được dấu vết thao tác trong trình duyệt. Kiểm tra quyền lưu dữ liệu và đối chiếu chứng từ trước khi thực hiện tiếp.');this.name='FinancialPendingStorageError';}
}
type StoragePort=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
const keyOf=(s:FinancialPendingScope)=>'ihome:financial-pending:v1:'+ [s.namespace,s.userId,s.organizationId,s.businessKey].map(encodeURIComponent).join(':');
const scopeFields=['namespace','userId','organizationId','businessKey'] as const;
const OPERATION_MAX=200;
const cleanOperation=(value:unknown):string|undefined=>typeof value==='string'&&value.trim()?value.trim().slice(0,OPERATION_MAX):undefined;
function cleanMeta(value:unknown):FinancialPendingMeta|undefined{
  if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
  const entries=Object.entries(value);
  return entries.length&&entries.every(([,item])=>item===null||['string','number','boolean'].includes(typeof item))?Object.fromEntries(entries) as FinancialPendingMeta:undefined;
}
export function createFinancialPendingStore(options:{storage?:StoragePort;now?:()=>Date}={}){
  const storage=()=>options.storage??globalThis.localStorage;
  function read(scope:FinancialPendingScope):FinancialPendingRecord|null {
    if(scopeFields.some(field=>!scope[field]))throw new FinancialPendingStorageError();
    try{
      const raw=storage().getItem(keyOf(scope));if(raw===null)return null;
      const row=JSON.parse(raw) as FinancialPendingRecord;
      if(!row||scopeFields.some(field=>row[field]!==scope[field])||typeof row.attemptId!=='string'||!row.attemptId||!Array.isArray(row.completedIds)||row.completedIds.some(id=>typeof id!=='string'||!id)||typeof row.startedAt!=='string'||!Number.isFinite(Date.parse(row.startedAt))||(row.requestKey!==undefined&&typeof row.requestKey!=='string'))throw new FinancialPendingError(null);
      // Hai ô thêm sau chỉ để hiển thị và đối chiếu: thiếu hoặc sai dạng thì bỏ ô đó, không coi cả dấu là hỏng.
      const {operation:rawOperation,meta:rawMeta,activeAt:rawActiveAt,...core}=row;
      const operation=cleanOperation(rawOperation),meta=cleanMeta(rawMeta);
      const activeAt=typeof rawActiveAt==='string'&&Number.isFinite(Date.parse(rawActiveAt))?rawActiveAt:undefined;
      return {...core,...(activeAt?{activeAt}:{}),...(operation?{operation}:{}),...(meta?{meta}:{})};
    }catch(error){if(error instanceof FinancialPendingError)throw error;throw new FinancialPendingStorageError();}
  }
  function write(scope:FinancialPendingScope,row:FinancialPendingRecord){try{storage().setItem(keyOf(scope),JSON.stringify(row));}catch{throw new FinancialPendingStorageError();}}
  function markPending(scope:FinancialPendingScope,input:{attemptId?:string;requestKey?:string;operation?:string;meta?:FinancialPendingMeta}={}):FinancialPendingRecord{
    const prior=read(scope);if(prior)throw new FinancialPendingError(prior);
    const operation=cleanOperation(input.operation),meta=cleanMeta(input.meta);
    const row:FinancialPendingRecord={...scope,attemptId:input.attemptId??crypto.randomUUID(),...(input.requestKey?{requestKey:input.requestKey}:{}),completedIds:[],startedAt:(options.now?.()??new Date()).toISOString(),...(operation?{operation}:{}),...(meta?{meta}:{})};
    write(scope,row);return row;
  }
  function recordCompleted(scope:FinancialPendingScope,attemptId:string,completedIds:readonly string[]):FinancialPendingRecord{
    const row=read(scope);if(!row||row.attemptId!==attemptId)throw new FinancialPendingError(row);
    if(completedIds.some(id=>typeof id!=='string'||!id))throw new FinancialPendingError(row);
    const merged=[...new Set([...row.completedIds,...completedIds])];
    // Chỉ một bước MỚI hoàn tất mới là hoạt động: lần bấm bị chặn ghi lại đúng các mã cũ không được làm mới đồng hồ.
    if(merged.length===row.completedIds.length)return row;
    const next={...row,completedIds:merged,activeAt:(options.now?.()??new Date()).toISOString()};write(scope,next);return next;
  }
  function clearConfirmed(scope:FinancialPendingScope,expectedAttemptId:string):boolean{
    const row=read(scope);if(!row||row.attemptId!==expectedAttemptId)return false;
    try{storage().removeItem(keyOf(scope));}catch{throw new FinancialPendingStorageError();}return true;
  }
  return {read,markPending,recordCompleted,clearConfirmed};
}
export type FinancialPendingStore=ReturnType<typeof createFinancialPendingStore>;
export const financialPending=createFinancialPendingStore();

// ── Đối chiếu một lần CHUYỂN TRẠNG THÁI chưa rõ kết quả (đợt 5) ──────────────────────────────────────────────────────
// Đặt chung tệp với kho dấu (không tách module riêng) để không sinh thêm một gói dùng chung trong bảng nạp trước của gói
// entry (cửa bundle-inventory). Cách C của plan sửa khoá vĩnh viễn: trước khi ghi dấu, nơi gọi đọc trạng thái bản ghi và
// lưu chữ ký của nó vào `meta.before` của dấu; lần bấm sau đọc lại rồi so:
//   - đã ở trạng thái đích        ⇒ báo «đã ở trạng thái …», gỡ dấu, không gửi lần hai (có thể do người khác làm);
//   - vẫn đúng như trước khi bấm  ⇒ lần trước chưa ghi: gửi lại (lõi chỉ nhận khi dấu đã quá 2 phút, trừ khi máy
//                                    chủ khoá dòng rồi mới xét trạng thái nên gửi lại sớm cũng không ghi hai lần);
//   - khác hẳn                    ⇒ có ai đó đã làm việc khác: báo trạng thái hiện tại, gỡ dấu, không gửi.
// Không đọc thấy bản ghi (quyền, đã xoá) thì chưa kết luận được: giữ dấu.

/**
 * Lần gửi của dấu đang được đối chiếu đã chắc chắn kết thúc chưa, xét TỪ TRONG hàm đối chiếu. Lõi chỉ gọi hàm đối chiếu
 * khi lượt của dấu không còn chạy trong tab, rồi đánh dấu dấu đó «đang chạy» trong lúc đối chiếu; vì vậy ở đây chỉ còn
 * xét ngưỡng 2 phút kể từ hoạt động cuối (`pendingHasSettled` trên chính dấu sẽ luôn trả «chưa»).
 */
export const priorAttemptSettled = (pending: FinancialPendingRecord, now: Date = new Date()): boolean =>
  pendingHasSettled({ startedAt: pending.startedAt, activeAt: pending.activeAt }, now);

/** Khoá trong `meta` của dấu giữ chữ ký trạng thái trước khi bấm. */
export const BEFORE_STATE = 'before';

/** `meta` của dấu cho một lần chuyển trạng thái: chữ ký trạng thái đọc được ngay trước khi ghi dấu. */
export const beforeStateMeta = (signature: string, extra: FinancialPendingMeta = {}): FinancialPendingMeta => ({ ...extra, [BEFORE_STATE]: signature });

export interface TransitionCheck<T> {
  pending: FinancialPendingRecord;
  /** Chữ ký trạng thái hiện tại; `null` khi không đọc thấy bản ghi. */
  current: string | null;
  /** Bản ghi đã ở trạng thái đích của thao tác. */
  reached: boolean;
  /** Kết luận khi đã ở đích: thường là `already-written`, hoặc `{result}` khi dựng được kết quả «không thay đổi». */
  onReached: () => PendingReconciliation<T>;
  /**
   * Dấu không mang chữ ký trạng thái trước (dấu ghi trước đợt 5): trạng thái hiện tại còn đúng điều kiện của thao tác
   * không. Không khai thì dấu như vậy chỉ được kết luận khi đã ở đích.
   */
  ready?: boolean;
  /** Máy chủ khoá dòng TRƯỚC khi xét trạng thái (đã đọc thân hàm production): gửi lại sớm không ghi hai lần. */
  serverLocksFirst?: boolean;
  /** Câu báo khi trạng thái đã khác hẳn (không phải đích, không phải như trước khi bấm). */
  otherMessage: string;
  recordIds: readonly string[];
}

export function transitionVerdict<T>(check: TransitionCheck<T>): PendingReconciliation<T> {
  if (check.current === null) return null;
  if (check.reached) return check.onReached();
  const before = check.pending.meta?.[BEFORE_STATE];
  const unchanged = typeof before === 'string' ? before === check.current : check.ready === true;
  if (unchanged) return check.serverLocksFirst ? { outcome: 'not-written', serverDedupesRequestKey: true } : { outcome: 'not-written' };
  if (typeof before !== 'string' && check.ready === undefined) return null;
  return { outcome: 'already-written', message: check.otherMessage, recordIds: check.recordIds };
}

/**
 * Dấu vân tay ngắn của nội dung gửi đi (không chứa nội dung đó), để lần bấm sau biết nội dung có đổi không. Khoá của
 * object được sắp xếp; thứ tự phần tử mảng giữ nguyên (máy chủ băm cả thứ tự).
 */
export function payloadFingerprint(value: unknown): string {
  const stable = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(stable);
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.keys(input as Record<string, unknown>).sort()
        .filter(key => (input as Record<string, unknown>)[key] !== undefined)
        .map(key => [key, stable((input as Record<string, unknown>)[key])]));
    }
    return input;
  };
  const text = JSON.stringify(stable(value)) ?? 'undefined';
  // FNV-1a 32 bit hai vòng (hai hạt giống khác nhau) cộng độ dài: đủ để phân biệt «cùng nội dung» với «đã đổi».
  const fnv = (seed: number) => {
    let hash = seed >>> 0;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36);
  };
  return `${text.length.toString(36)}.${fnv(0x811c9dc5)}.${fnv(0x01000193)}`;
}
