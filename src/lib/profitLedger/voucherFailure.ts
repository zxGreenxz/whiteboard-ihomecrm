// Câu báo lỗi cho các màn THAO TÁC PHIẾU chung (Thu chi, hộp Thu/Chi, Chờ duyệt) khi phiếu là phiếu
// chi theo sổ tổng. Máy chủ chặn bằng chốt F1 / F1b / F2 / F5 (d1_chan_interface §5): MESSAGE mở đầu
// bằng mã máy `PROFIT_LEDGER_…:` và phần lớn là SQLSTATE 55000 — qua PostgREST thành HTTP 500, nên bộ
// dịch chung (friendlyError) chỉ ra câu "chưa xác định được nguyên nhân". Ở đây: lỗi CÓ mã máy ⇒ câu
// tiếng Việt của sổ tổng (profitLedgerErrorMessage); lỗi khác ⇒ giữ nguyên câu cũ của từng màn.
//
// Không sửa friendlyError: bộ dịch sổ tổng dựa vào voucherFeedback → friendlyError, gọi ngược sẽ thành
// vòng import và vòng gọi đệ quy.

import { FinancialWorkflowError, workflowErrorMessage } from '@/lib/financialWorkflow';
import { voucherFailureMessage } from '@/lib/voucherFeedback';
import { profitLedgerErrorMessage, type ProfitLedgerOperation } from './errors';

const MACHINE_CODE = /^((?:PROFIT_LEDGER|SALARY_PROFIT|PROFIT_MANAGER_LEDGER|PROFIT_PAYOUT)_[A-Z0-9_]+)\s*:/;

function messageOf(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message : null;
}

/**
 * Mã máy của sổ tổng ở đầu MESSAGE (vd `PROFIT_LEDGER_ACCOUNT_LOCKED`), kể cả khi lỗi gốc nằm trong
 * `cause` của một lần từ chối chắc chắn (FinancialWorkflowError outcome 'failure'). Lỗi chưa rõ kết quả
 * KHÔNG được dịch ở đây: câu "kiểm tra lại trước khi làm tiếp" của từng màn phải giữ nguyên.
 */
export function profitLedgerMachineCode(error: unknown): string | null {
  const direct = MACHINE_CODE.exec(messageOf(error) ?? '');
  if (direct) return direct[1]!;
  if (error instanceof FinancialWorkflowError && error.outcome === 'failure') {
    const nested = MACHINE_CODE.exec(messageOf(error.cause) ?? '');
    if (nested) return nested[1]!;
  }
  return null;
}

/** Thay `voucherFailureMessage` ở màn thao tác phiếu: lỗi sổ tổng ra câu riêng, lỗi khác như cũ. */
export function ledgerAwareVoucherFailure(
  error: unknown,
  action: string,
  op: ProfitLedgerOperation = 'approve',
): string {
  return profitLedgerMachineCode(error) ? profitLedgerErrorMessage(error, op).message : voucherFailureMessage(error, action);
}

/** Thay `workflowErrorMessage` trong toast của hook ghi Finance V2 (duyệt / chi / duyệt và chi). */
export function ledgerAwareWorkflowError(
  error: unknown,
  operation: string,
  op: ProfitLedgerOperation = 'approve',
): string {
  return profitLedgerMachineCode(error) ? profitLedgerErrorMessage(error, op).message : workflowErrorMessage(error, operation);
}
