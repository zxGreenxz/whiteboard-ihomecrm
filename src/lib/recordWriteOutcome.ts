import { FinancialWorkflowError, RepeatableWriteUnknownError } from './financialWorkflowError';
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
/** Kết quả chưa rõ thì khoá form, TRỪ thao tác lặp lại được (đợt 8): lỗi đó báo rõ và cho bấm lại. */
export function recordWriteBlocked(error: unknown): boolean {
  if (error instanceof RepeatableWriteUnknownError) return false;
  return (error instanceof FinancialWorkflowError && error.outcome !== 'failure') || hasUnconfirmedResponse(error);
}
export function recordWriteMessage(error: unknown, operation: string, options: FeedbackOptions = {}): string {
  if (error instanceof FinancialWorkflowError) return error.message + (error.completed.length ? ` Mã đối chiếu: ${error.completed.map(row=>row.id).join(', ')}.` : '');
  const feedback = friendlyError(error, `Chưa ${operation}.`, {...options, operation});
  return `${feedback.title} ${feedback.description}`;
}

/**
 * Đợt 8 (luật 5): chạy một lệnh ghi LẶP LẠI ĐƯỢC (đặt giá trị theo mã, xoá theo mã, xoá mềm) mà KHÔNG giữ dấu «chờ đối
 * chiếu» nào. Lời từ chối rõ (mã từ chối đã biết, `failure`) đi nguyên; kết quả chưa rõ (mất mạng, 5xx, biên nhận sai mã)
 * thành `RepeatableWriteUnknownError`: form báo rõ, không khoá, lần bấm sau ghi lại đúng nội dung đó.
 * Chỉ dùng khi chạy lại `task` cho CÙNG kết quả; thao tác thêm mới hay cộng dồn không dùng hàm này.
 */
export async function repeatableWrite<T>(operation: string, task: () => Promise<T>): Promise<T> {
  try { return await task(); }
  catch (error) {
    if (error instanceof RepeatableWriteUnknownError) throw error;
    if (error instanceof FinancialWorkflowError ? error.outcome === 'failure' : !hasUnconfirmedResponse(error)) throw error;
    throw new RepeatableWriteUnknownError(operation, error, error instanceof FinancialWorkflowError ? error.completed : []);
  }
}

/**
 * Lệnh xoá theo mã khớp 0 dòng (đã xoá trước đó, hoặc RLS không cho xoá): đọc lại đúng bản ghi. Không còn thấy, hoặc đã
 * xoá mềm (`isDeleted`), nghĩa là đã xoá (ở lần gửi trước hoặc do người khác) ⇒ trả `'already-deleted'`. Còn nguyên nghĩa
 * là máy chủ không xoá dòng nào ⇒ từ chối rõ (không có quyền). Đọc hỏng ⇒ chưa rõ, bấm lại được.
 */
export async function settleZeroRowDelete(
  operation: string,
  read: () => PromiseLike<{ data: unknown; error: unknown }>,
  isDeleted: (row: Record<string, unknown>) => boolean = row => typeof row.deleted_at === 'string' && row.deleted_at !== '',
): Promise<'already-deleted'> {
  let reply: { data: unknown; error: unknown };
  try { reply = await read(); } catch (error) { throw new RepeatableWriteUnknownError(operation, error); }
  if (reply.error) throw new RepeatableWriteUnknownError(operation, reply.error);
  const rows = Array.isArray(reply.data) ? reply.data : reply.data === null || reply.data === undefined ? [] : [reply.data];
  const live = rows.filter(row => !(row && typeof row === 'object' && isDeleted(row as Record<string, unknown>)));
  if (!live.length) return 'already-deleted';
  throw new FinancialWorkflowError(`Chưa ${operation}: bản ghi vẫn còn nhưng máy chủ không xoá dòng nào. Tài khoản có thể chưa có quyền xoá bản ghi này.`, 'failure', []);
}
