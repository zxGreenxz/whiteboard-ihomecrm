import { FinancialWorkflowError } from './financialWorkflowError';
import { hasUnconfirmedResponse } from './operationOutcome';
import { friendlyError, type FeedbackOptions } from './friendlyError';

/** Only a positive ID receipt confirms a write; absence does not establish rollback. */
export function confirmedRecordId(value: unknown, operation: string, expectedId?: string): string {
  const id = value && typeof value === 'object' ? (value as Record<string, unknown>).id : undefined;
  if (typeof id !== 'string' || !id || (expectedId && id !== expectedId)) {
    throw new FinancialWorkflowError(`Chưa xác nhận được kết quả ${operation}. Giữ thông tin đang nhập và đối chiếu bản ghi trong danh sách trước khi thực hiện tiếp.`, 'unknown', expectedId ? [{id:expectedId,label:'Bản ghi cần đối chiếu'}] : []);
  }
  return id;
}
export function confirmedRecordBatch(value: unknown, expectedCount: number, operation: string): string[] {
  const rows = Array.isArray(value) ? value : [];
  const ids = rows.flatMap(row => row && typeof row === 'object' && typeof row.id === 'string' && row.id ? [row.id as string] : []);
  const uniqueIds = [...new Set(ids)];
  if (!Array.isArray(value) || rows.length !== expectedCount || ids.length !== expectedCount || uniqueIds.length !== expectedCount) {
    throw new FinancialWorkflowError(`Chưa xác nhận đủ các bản ghi khi ${operation}. Giữ các mã đã nhận, tải lại danh sách và đối chiếu trước khi gửi lại.`, uniqueIds.length ? 'partial' : 'unknown', uniqueIds.map(id=>({id,label:'Bản ghi đã nhận mã'})));
  }
  return uniqueIds;
}
export function recordWriteBlocked(error: unknown): boolean {
  return (error instanceof FinancialWorkflowError && error.outcome !== 'failure') || hasUnconfirmedResponse(error);
}
export function recordWriteMessage(error: unknown, operation: string, options: FeedbackOptions = {}): string {
  if (error instanceof FinancialWorkflowError) return error.message + (error.completed.length ? ` Mã đối chiếu: ${error.completed.map(row=>row.id).join(', ')}.` : '');
  const feedback = friendlyError(error, `Chưa ${operation}.`, {...options, operation});
  return `${feedback.title} ${feedback.description}`;
}
