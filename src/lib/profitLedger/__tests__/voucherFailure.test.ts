// Câu báo lỗi ở các màn thao tác phiếu chung khi phiếu là phiếu chi theo sổ tổng: lỗi chốt F1/F1b/F2/F5
// (mã PROFIT_LEDGER_… ở đầu MESSAGE, phần lớn 55000 ⇒ HTTP 500) ra câu riêng; lỗi khác giữ câu cũ của màn.
import { describe, expect, it } from 'vitest';
import { FinancialWorkflowError, workflowErrorMessage } from '@/lib/financialWorkflow';
import { voucherFailureMessage } from '@/lib/voucherFeedback';
import { ledgerAwareVoucherFailure, ledgerAwareWorkflowError, profitLedgerMachineCode } from '../voucherFailure';

const loi = (code: string, message: string, details: string | null = null) => ({ code, message, details, hint: null });

describe('profitLedgerMachineCode', () => {
  it('đọc mã ở đầu MESSAGE, kể cả lỗi gốc nằm trong một lần từ chối chắc chắn', () => {
    expect(profitLedgerMachineCode(loi('55000', 'PROFIT_LEDGER_CANCEL_ONLY: chỉ huỷ'))).toBe('PROFIT_LEDGER_CANCEL_ONLY');
    expect(profitLedgerMachineCode(loi('22023', 'PROFIT_MANAGER_LEDGER_OVERDRAW: vượt'))).toBe('PROFIT_MANAGER_LEDGER_OVERDRAW');
    const wrapped = new FinancialWorkflowError('Không duyệt được', 'failure', [], loi('55000', 'PROFIT_LEDGER_FROZEN: đóng băng'));
    expect(profitLedgerMachineCode(wrapped)).toBe('PROFIT_LEDGER_FROZEN');
  });
  it('không có mã ⇒ null; chưa rõ kết quả KHÔNG bị coi là lỗi sổ tổng', () => {
    expect(profitLedgerMachineCode(loi('55000', 'is frozen'))).toBeNull();
    expect(profitLedgerMachineCode(new TypeError('Failed to fetch'))).toBeNull();
    expect(profitLedgerMachineCode(new FinancialWorkflowError('Mất mạng', 'unknown', [], loi('55000', 'PROFIT_LEDGER_FROZEN: x')))).toBeNull();
    expect(profitLedgerMachineCode(null)).toBeNull();
  });
});

describe('ledgerAwareVoucherFailure / ledgerAwareWorkflowError', () => {
  it('mã chốt sổ tổng ⇒ câu riêng (không phải câu chung "chưa xác định nguyên nhân")', () => {
    const cases: Array<[unknown, string]> = [
      [loi('55000', 'PROFIT_LEDGER_ACCOUNT_LOCKED: sai sổ'), 'Phiếu này chỉ chi được từ sổ quỹ đã chọn lúc lập.'],
      [loi('55000', 'PROFIT_LEDGER_CANCEL_ONLY: chỉ huỷ'), 'Phiếu chi theo sổ tổng chỉ bỏ được bằng nút Huỷ (ghi lý do).'],
      [loi('55000', 'PROFIT_LEDGER_ROUTE_OFF: tắt', '{"route":"LEGACY"}'), 'Sổ tổng chưa bật — chưa duyệt hay chi phiếu này được (vẫn huỷ được).'],
      [loi('42501', 'PROFIT_LEDGER_PAYEE_SELF_POST: người nhận'), 'Người nhận tiền không tự chi khoản này — cần người giữ sổ khác chi.'],
      [loi('55000', 'PROFIT_LEDGER_SALARY_REVIEW_PENDING: còn', '{"count":2,"suggested":10}'),
        'Cổ đông còn 2 phiếu lương cần chủ xem lại phần lợi nhuận. Xác nhận phần lương trước rồi mới chi.'],
    ];
    for (const [error, message] of cases) {
      expect(ledgerAwareVoucherFailure(error, 'ghi nhận thu/chi')).toBe(message);
      expect(ledgerAwareWorkflowError(error, 'duyệt phiếu')).toBe(message);
    }
  });
  it('lỗi khác giữ NGUYÊN câu cũ của màn', () => {
    for (const error of [loi('42501', 'permission denied'), new TypeError('Failed to fetch'), loi('55000', 'is frozen')]) {
      expect(ledgerAwareVoucherFailure(error, 'ghi nhận thu/chi')).toBe(voucherFailureMessage(error, 'ghi nhận thu/chi'));
      expect(ledgerAwareWorkflowError(error, 'duyệt phiếu')).toBe(workflowErrorMessage(error, 'duyệt phiếu'));
    }
  });
});
