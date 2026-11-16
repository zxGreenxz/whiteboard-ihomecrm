import {FinancialWorkflowError} from './financialWorkflowError';
/** A lost/invalid write response does not prove the server rolled the write back. */
export function hasUnconfirmedResponse(error: unknown, seen = new Set<unknown>()): boolean {
  if (error instanceof FinancialWorkflowError) return error.outcome==='unknown'||error.outcome==='partial';
  if (!error || seen.has(error)) return false;
  seen.add(error);
  const record = typeof error === 'object' ? error as Record<string, unknown> : {message:error};
  const status = Number(record.status ?? record.statusCode);
  // PT409 = RPC đã trả xung đột có cấu trúc (HTTP 409, giao dịch đã lùi). Câu lỗi của nó có thể nhúng số
  // (md5, số dư: "…5035…", "15030000") trùng "502/503/504" — đó không phải mã HTTP nên không dò câu.
  const xungDotCoCauTruc = String(record.code ?? '') === 'PT409';
  return (Number.isFinite(status) && status >= 500 && status <= 599)
    || error instanceof TypeError
    || (!xungDotCoCauTruc && /network|fetch|timeout|timed out|abort|econnreset|socket hang up|502|503|504/i.test(String(record.message ?? '')))
    || ['57014','PGRST003','ETIMEDOUT'].includes(String(record.code ?? ''))
    || hasUnconfirmedResponse(record.cause, seen)
    || hasUnconfirmedResponse(record.error, seen);
}
