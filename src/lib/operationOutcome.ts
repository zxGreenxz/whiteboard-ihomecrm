import {FinancialWorkflowError} from './financialWorkflowError';
/**
 * Mã lỗi cho biết máy chủ đã từ chối và lùi giao dịch. PGRST116 = lệnh ghi đòi đúng một dòng nhưng khớp 0
 * (hoặc nhiều) dòng: PostgREST huỷ giao dịch trước khi trả lỗi.
 */
const KNOWN_REJECTION_CODE=/^(22[0-9A-Z]{3}|23[0-9A-Z]{3}|28[0-9A-Z]{3}|40001|40P01|42501|42883|55000|55P03|P0001|P0002|PT409|PGRST116|PGRST202|PGRST301|PGRST302)$/;
export function isKnownRejectionCode(code:unknown):boolean{
  return KNOWN_REJECTION_CODE.test(String(code??''));
}
/** A lost/invalid write response does not prove the server rolled the write back. */
export function hasUnconfirmedResponse(error: unknown, seen = new Set<unknown>()): boolean {
  if (error instanceof FinancialWorkflowError) return error.outcome==='unknown'||error.outcome==='partial';
  if (!error || seen.has(error)) return false;
  seen.add(error);
  const record = typeof error === 'object' ? error as Record<string, unknown> : {message:error};
  const status = Number(record.status ?? record.statusCode);
  const message = String(record.message ?? '');
  // PT409 = RPC đã trả xung đột có cấu trúc (HTTP 409, giao dịch đã lùi). Câu lỗi của nó có thể nhúng số
  // (md5, số dư: "…5035…", "15030000") trùng "502/503/504" — đó không phải mã HTTP nên không dò câu.
  const xungDotCoCauTruc = String(record.code ?? '') === 'PT409';
  // Lời từ chối đã mang mã rõ (P0001, 23505…) cũng có thể nhúng số tiền hay mã chứa "502/503/504"
  // ("1.502.000 đ"). Chỉ dò ba số đó khi lỗi không có mã từ chối đã biết; lỗi 5xx thật đã bắt ở `status`.
  const tuChoiCoMa = isKnownRejectionCode(record.code);
  return (Number.isFinite(status) && status >= 500 && status <= 599)
    || error instanceof TypeError
    || (!xungDotCoCauTruc && /network|fetch|timeout|timed out|abort|econnreset|socket hang up/i.test(message))
    || (!tuChoiCoMa && /502|503|504/.test(message))
    || ['57014','PGRST003','ETIMEDOUT'].includes(String(record.code ?? ''))
    || hasUnconfirmedResponse(record.cause, seen)
    || hasUnconfirmedResponse(record.error, seen);
}
