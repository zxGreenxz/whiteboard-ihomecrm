import {FinancialWorkflowError} from './financialWorkflowError';
/** A lost/invalid write response does not prove the server rolled the write back. */
export function hasUnconfirmedResponse(error: unknown, seen = new Set<unknown>()): boolean {
  if (error instanceof FinancialWorkflowError) return error.outcome==='unknown'||error.outcome==='partial';
  if (!error || seen.has(error)) return false;
  seen.add(error);
  const record = typeof error === 'object' ? error as Record<string, unknown> : {message:error};
  const status = Number(record.status ?? record.statusCode);
  return (Number.isFinite(status) && status >= 500 && status <= 599)
    || error instanceof TypeError
    || /network|fetch|timeout|timed out|abort|econnreset|socket hang up|502|503|504/i.test(String(record.message ?? ''))
    || ['57014','PGRST003','ETIMEDOUT'].includes(String(record.code ?? ''))
    || hasUnconfirmedResponse(record.cause, seen)
    || hasUnconfirmedResponse(record.error, seen);
}
