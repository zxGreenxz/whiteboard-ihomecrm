import { FinancialWorkflowError, workflowErrorMessage } from './financialWorkflow';

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
export function materialVoucherRetryBlocked(error: unknown): boolean {
  return error instanceof FinancialWorkflowError && error.outcome !== 'failure';
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
