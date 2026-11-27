// Dấu «chờ đối chiếu» của luồng chuyển khách hẹn thành đặt cọc BẢN TRƯỚC (namespace `lead-conversion`, khoá theo khách hẹn).
//
// Bản trước (tới 25/11/2026) chạy ba bước trong một dấu: tạo khách thuê → tạo phiếu cọc ở bảng `deposits` → đánh dấu khách
// hẹn đã chuyển, mỗi bước ghi tiến độ vào một vết riêng (`ihome:lead-conversion-trace:v1:<mã yêu cầu>`). Luồng hiện hành
// (#499) nhận cọc qua Thu chi bằng một mã yêu cầu cố định theo khách hẹn nên không còn ghi dấu này; nhưng dấu cũ vẫn có thể
// nằm trong trình duyệt nhân viên và trước đợt 7 nó chặn hộp chuyển khách hẹn đó VĨNH VIỄN.
//
// Đợt 7: hộp chuyển khách hẹn đọc dấu cũ một lần và kết luận bằng `resolveLegacyLeadConversion`:
//   - vết cho biết phiếu cọc đã có (mã trong dấu) và đọc thấy phiếu ⇒ chỉ còn bước đánh dấu khách hẹn;
//   - vết cho biết bước tạo phiếu CHƯA bắt đầu ⇒ lần trước chưa ghi tiền: gỡ dấu, làm như bình thường;
//   - bước tạo phiếu đã gửi mà chưa rõ kết quả ⇒ tra gần đúng phiếu cọc của khách thuê đó (mới nhất trước): thấy thì chỉ
//     báo «có thể đã ghi (mã …)», không tự tạo phiếu khác; không thấy thì gỡ dấu, làm như bình thường;
//   - không đọc được vết ⇒ chưa kết luận được: chặn đúng khách hẹn đó qua hộp cảnh báo (sau 2 phút người dùng tự gỡ).
// Không chạy lại bước ghi nào của bản trước.
//
// Đợt 11: vết được gỡ ngay khi việc của dấu đã xong (đã kết luận, đã hoàn tất khách hẹn) kể cả khi chính dấu đã được gỡ ở
// nơi khác; vết không còn dấu nào trỏ tới (người dùng tự gỡ dấu qua hộp cảnh báo) được gỡ bằng
// `forgetOrphanLeadConversionTraces` (lúc mở hộp chuyển khách hẹn). Hai họ khoá «ý định» không còn ai đọc được dọn lúc mở app
// bằng `forgetDeadIntentKeys` ở `pendingSweep.ts` (đặt ở đó để tệp này không bị tách thành gói dùng chung làm phình gói entry).
import { pendingHasSettled, type FinancialPendingRecord } from './financialPending';

export interface LeadConversionTrace {
  leadId: string;
  tenantId?: string;
  depositId?: string;
  stage: 'tenant' | 'deposit' | 'lead' | 'complete';
  canResume: boolean;
}
const TRACE_PREFIX = 'ihome:lead-conversion-trace:v1:';
const traceKey = (requestKey: string) => TRACE_PREFIX + requestKey;

export function readLeadConversionTrace(requestKey: string | undefined): LeadConversionTrace | null {
  if (!requestKey) return null;
  let value: LeadConversionTrace | null = null;
  try { value = JSON.parse(localStorage.getItem(traceKey(requestKey)) ?? 'null') as LeadConversionTrace | null; }
  catch { /* Vết hỏng hoặc không đọc được: không chứng minh được gì, nơi gọi chặn qua hộp cảnh báo (`block`). */ }
  if (!value || typeof value !== 'object' || typeof value.leadId !== 'string' || !value.leadId || !['tenant', 'deposit', 'lead', 'complete'].includes(value.stage) || typeof value.canResume !== 'boolean' || (value.tenantId !== undefined && (typeof value.tenantId !== 'string' || !value.tenantId)) || (value.depositId !== undefined && (typeof value.depositId !== 'string' || !value.depositId))) return null;
  return value;
}

/** Gỡ vết tiến độ của dấu cũ cùng lúc gỡ dấu. Hỏng thì thôi: vết không chặn gì. */
export function forgetLeadConversionTrace(requestKey: string | undefined): void {
  if (!requestKey) return;
  try { localStorage.removeItem(traceKey(requestKey)); } catch { /* vết không chặn gì */ }
}

type KeyedStore = Pick<Storage, 'length' | 'key' | 'removeItem'>;
/** Kho thật của trình duyệt; trình duyệt chặn bộ nhớ (truy cập cũng ném) thì `null`. */
function browserStore(): Storage | null {
  let store: Storage | null = null;
  try { store = globalThis.localStorage ?? null; }
  catch { /* Trình duyệt chặn bộ nhớ (truy cập cũng ném): không có kho để dọn, hàm dọn chạy nền không được ném. */ }
  return store;
}
/** Mọi khoá của kho thoả `match`, đọc hết TRƯỚC khi gỡ (gỡ trong vòng đọc làm lệch chỉ số). Kho ném lỗi ⇒ `null`. */
function keysWhere(store: KeyedStore, match: (key: string) => boolean): string[] | null {
  const keys: string[] = [];
  let readable = true;
  try {
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key !== null && match(key)) keys.push(key);
    }
  } catch { /* Kho chặn giữa chừng: danh sách không trọn, nơi gọi không gỡ khoá nào. */ readable = false; }
  return readable ? keys : null;
}
/** Gỡ từng khoá; khoá nào gỡ hỏng thì bỏ qua. Trả số khoá đã gỡ. */
function removeKeys(store: KeyedStore, keys: readonly string[]): number {
  let removed = 0;
  for (const key of keys) {
    try { store.removeItem(key); removed += 1; } catch { /* khoá thừa không chặn gì; lần dọn sau gỡ lại */ }
  }
  return removed;
}

/** Dấu `lead-conversion` của mọi tài khoản trên máy này (khoá của kho dấu chung: namespace đứng đầu phạm vi). */
const LEAD_MARK_PREFIX = 'ihome:financial-pending:v1:lead-conversion:';

/**
 * Gỡ vết tiến độ không còn dấu `lead-conversion` nào trỏ tới (dấu đã gỡ qua hộp cảnh báo, ở tab khác, hay gỡ hỏng giữa
 * chừng). Vết chỉ được đọc qua `requestKey` của một dấu như vậy và không còn mã nào ghi dấu đó, nên vết mồ côi không bao giờ
 * được đọc lại. Vết còn dấu trỏ tới (kể cả dấu của tài khoản khác trên cùng máy) được giữ. Một dấu không đọc được ⇒ không
 * chứng minh được gì, không gỡ vết nào. Không ném lỗi; trả số vết đã gỡ.
 */
export function forgetOrphanLeadConversionTraces(storage?: KeyedStore & Pick<Storage, 'getItem'>): number {
  const store = storage ?? browserStore();
  if (!store) return 0;
  const marks = keysWhere(store, key => key.startsWith(LEAD_MARK_PREFIX));
  const traces = keysWhere(store, key => key.startsWith(TRACE_PREFIX));
  if (!marks || !traces || !traces.length) return 0;
  const referenced = new Set<string>();
  for (const key of marks) {
    let mark: unknown;
    try { mark = JSON.parse(store.getItem(key) ?? 'null'); }
    catch { /* Dấu không đọc được: không chứng minh được vết nào mồ côi, không gỡ gì. */ return 0; }
    if (!mark || typeof mark !== 'object') return 0;
    const requestKey = (mark as { requestKey?: unknown }).requestKey;
    if (typeof requestKey === 'string') referenced.add(requestKey);
    else if (requestKey !== undefined) return 0;
  }
  return removeKeys(store, traces.filter(key => !referenced.has(key.slice(TRACE_PREFIX.length))));
}

export type LegacyLeadConversionVerdict =
  /** Phiếu cọc của lần trước đã có (`exact`: mã nằm trong dấu; ngược lại là tra gần đúng, «có thể»). */
  | { kind: 'deposit'; depositId: string; exact: boolean }
  /** Lần trước chưa ghi tiền: gỡ dấu, làm như bình thường. */
  | { kind: 'clear' }
  /** Chưa kết luận được: chặn khách hẹn này qua hộp cảnh báo. */
  | { kind: 'block' };

export interface LegacyLeadConversionPorts {
  /** Đọc đúng phiếu cọc theo mã (bảng `deposits` của bản trước). `null` = đọc được mà không thấy. Đọc hỏng thì ném. */
  readDeposit: (id: string) => Promise<{ id: string } | null>;
  /** Phiếu cọc của khách thuê đó tạo quanh giờ kẹt, mới nhất trước. Đọc hỏng thì ném. */
  findDeposits: (tenantId: string, pending: FinancialPendingRecord) => Promise<string[]>;
  now?: () => Date;
}

export async function resolveLegacyLeadConversion(pending: FinancialPendingRecord, leadId: string, ports: LegacyLeadConversionPorts): Promise<LegacyLeadConversionVerdict> {
  const trace = readLeadConversionTrace(pending.requestKey);
  if (!trace || trace.leadId !== leadId) return { kind: 'block' };
  // Phiếu cọc đã nhận mã ở lần trước (mã nằm cả trong vết lẫn dấu): đọc đúng phiếu đó.
  if (trace.depositId) {
    if (!pending.completedIds.includes(trace.depositId)) return { kind: 'block' };
    const deposit = await ports.readDeposit(trace.depositId);
    return deposit?.id === trace.depositId ? { kind: 'deposit', depositId: deposit.id, exact: true } : { kind: 'block' };
  }
  // Mọi kết luận «chưa ghi» chỉ có giá trị khi lần gửi trước chắc chắn đã kết thúc.
  if (!pendingHasSettled({ startedAt: pending.startedAt, activeAt: pending.activeAt }, ports.now?.() ?? new Date())) return { kind: 'block' };
  // Bước tạo phiếu chưa bắt đầu (đang tạo khách thuê, hoặc khách thuê xong và bước kế còn cho chạy): chưa có khoản tiền nào.
  if (trace.stage === 'tenant' || (trace.stage === 'deposit' && trace.canResume)) return { kind: 'clear' };
  // Bước tạo phiếu đã gửi mà chưa rõ kết quả: tra gần đúng theo khách thuê lần đó tạo riêng cho khách hẹn này.
  if (trace.stage === 'deposit' && trace.tenantId) {
    const candidates = await ports.findDeposits(trace.tenantId, pending);
    return candidates[0] ? { kind: 'deposit', depositId: candidates[0], exact: false } : { kind: 'clear' };
  }
  return { kind: 'block' };
}
