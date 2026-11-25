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
import { pendingHasSettled, type FinancialPendingRecord } from './financialPending';

export interface LeadConversionTrace {
  leadId: string;
  tenantId?: string;
  depositId?: string;
  stage: 'tenant' | 'deposit' | 'lead' | 'complete';
  canResume: boolean;
}
const traceKey = (requestKey: string) => `ihome:lead-conversion-trace:v1:${requestKey}`;

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
