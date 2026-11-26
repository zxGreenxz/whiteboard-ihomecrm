import { FinancialWorkflowError, RepeatableWriteUnknownError, isConfirmedFinancialRejection, workflowErrorMessage } from './financialWorkflow';

export function confirmedMaterialVoucherId(value: unknown, expectedId?: string): string {
  const id = value && typeof value === 'object' ? (value as Record<string, unknown>).id : undefined;
  if (typeof id !== 'string' || !id || (expectedId && id !== expectedId)) {
    throw new FinancialWorkflowError('Chưa xác nhận được ID phiếu vật tư. Giữ dữ liệu đang nhập và đối chiếu danh sách phiếu, tồn kho trước khi thực hiện tiếp.', 'unknown', []);
  }
  return id;
}

export function confirmMaterialVoucherLines(value: unknown, expectedIds: readonly string[]): void {
  const ids = Array.isArray(value) ? value.map(row => row && typeof row === 'object' ? (row as Record<string, unknown>).id : undefined) : [];
  if (!Array.isArray(value) || ids.length !== expectedIds.length || new Set(ids).size !== ids.length || expectedIds.some(id => !ids.includes(id))) {
    throw new Error('Chưa xác nhận đủ các dòng vật tư đã lưu.');
  }
}

export function materialVoucherFailureMessage(error: unknown, operation: string): string {
  return workflowErrorMessage(error, operation);
}
/** Kết quả chưa rõ thì khoá form, TRỪ thao tác lặp lại được (đợt 8): lỗi đó báo rõ và cho bấm lại. */
export function materialVoucherRetryBlocked(error: unknown): boolean {
  return error instanceof FinancialWorkflowError && !(error instanceof RepeatableWriteUnknownError) && error.outcome !== 'failure';
}

/**
 * Đợt 8: lưu vật tư của công việc và sửa phiếu nhập «xoá rồi chèn lại» toàn bộ dòng (chưa nguyên tử; hàm máy chủ ở đợt
 * 10). Ghi dòng mới hỏng SAU khi đã xoá dòng cũ (hoặc sau khi vừa tạo đầu phiếu) thì phiếu đang không còn dòng nào: câu
 * báo nói rõ điều đó. Máy chủ từ chối rõ ⇒ `failure`; chưa rõ ⇒ lỗi lặp lại được. Cả hai không khoá form: lần lưu lại xoá
 * rồi ghi lại đúng bộ dòng đang nhập nên không nhân đôi dòng, và tồn kho do trigger tính lại từ toàn bộ dòng.
 */
export function materialLinesRewriteError(done: string, button: string, error: unknown): FinancialWorkflowError {
  if (isConfirmedFinancialRejection(error)) {
    return new FinancialWorkflowError(`${done} nhưng máy chủ từ chối ghi các dòng vật tư mới; phiếu đang chưa có dòng vật tư nào. ${workflowErrorMessage(error, 'ghi các dòng vật tư mới')} Sửa lại rồi bấm «${button}».`, 'failure', [], error);
  }
  const unknown = new RepeatableWriteUnknownError('ghi các dòng vật tư mới', error);
  unknown.message = `${done} nhưng chưa xác nhận được đã ghi các dòng vật tư mới; phiếu có thể đang chưa có dòng vật tư nào. Bấm «${button}» lại: lần lưu lại xoá rồi ghi lại đúng bộ dòng đang nhập nên không nhân đôi.`;
  return unknown;
}

export function readMaterialVoucherLines(value: unknown): Array<{ id: string; material_id: string }> {
  const failure = () => new Error('Chưa xác nhận được các dòng vật tư hiện tại. Tải lại phiếu trước khi sửa.');
  if (!Array.isArray(value)) throw failure();
  const ids = new Set<string>();
  return value.map(row => {
    if (!row || typeof row !== 'object') throw failure();
    const record = row as Record<string, unknown>;
    if (typeof record.id !== 'string' || !record.id || ids.has(record.id) || typeof record.material_id !== 'string' || !record.material_id) throw failure();
    ids.add(record.id);
    return { id: record.id, material_id: record.material_id };
  });
}
