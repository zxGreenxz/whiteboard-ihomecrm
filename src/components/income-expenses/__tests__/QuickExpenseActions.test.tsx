// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { QuickExpenseBatchButton, QuickExpenseButton, QuickExpenseToolbar } from '../QuickExpenseActions';
import type { QuickExpenseActions } from '@/hooks/income-expenses/useQuickExpense';
import type { IncomeExpenseBatchSummary, IncomeExpenseWithRelations } from '@/hooks/income-expenses/types';
afterEach(cleanup);
const voucher = { id: 'one', type: 'EXPENSE', approval_status: 'UNAPPROVED', total_amount: 100 } as IncomeExpenseWithRelations;
const batch = { id: 'batch', type: 'EXPENSE', vouchers: [voucher], voucher_ids: [voucher.id], voucher_count: 1, total_amount: 100 } as IncomeExpenseBatchSummary;
function actions(patch: Partial<QuickExpenseActions> = {}): QuickExpenseActions {
  return { reason: () => null, batchReason: () => null, busy: false, collecting: false, activeId: null, activeIds: [], activeBatchId: null, progress: { done: 0, total: 0 }, selected: [], results: [], error: null, ready: true, checksError: null, retryChecks: vi.fn(async () => {}),
    run: vi.fn(async () => {}), runBatch: vi.fn(async () => {}), toggle: vi.fn(), togglePage: vi.fn(), clear: vi.fn(), resetSelection: vi.fn(), selectAll: vi.fn(async () => {}), ...patch };
}
it('bấm chi nhanh không mở chi tiết hoặc hộp xác nhận', () => {
  const quick = actions(); const openDetail = vi.fn();
  render(<div onClick={openDetail}><QuickExpenseButton voucher={voucher} quick={quick} /></div>);
  fireEvent.click(screen.getByRole('button', { name: 'Chi nhanh' }));
  expect(quick.run).toHaveBeenCalledWith([voucher]); expect(openDetail).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.queryByRole('alertdialog')).toBeNull();
});
it('phiếu thiếu chứng từ bị khóa, có lý do; không mở chi tiết', () => {
  const quick = actions({ reason: () => 'Thiếu chứng từ' }); const openDetail = vi.fn();
  render(<div onClick={openDetail}><QuickExpenseButton voucher={voucher} quick={quick} /></div>);
  expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByTitle('Thiếu chứng từ')); expect(openDetail).not.toHaveBeenCalled(); expect(quick.run).not.toHaveBeenCalled();
});
it('thanh hàng loạt hiển thị số phiếu, gọi đúng tập đã chọn mà không xác nhận lần nữa', () => {
  const quick = actions({ selected: [voucher] });
  render(<QuickExpenseToolbar quick={quick} filters={{}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Duyệt và chi nhanh (1)' }));
  expect(quick.run).toHaveBeenCalledWith([voucher]); expect(screen.queryByRole('dialog')).toBeNull();
});
it('icon chi nhanh phiếu tổng gọi cả đợt, không mở thẻ chi tiết hoặc hỏi lại', () => {
  const quick = actions(); const openDetail = vi.fn();
  render(<div onClick={openDetail}><QuickExpenseBatchButton batch={batch} quick={quick} /></div>);
  const button = screen.getByRole('button', { name: 'Chi nhanh phiếu tổng' });
  expect(button.textContent).toBe('');
  fireEvent.click(button);
  expect(quick.runBatch).toHaveBeenCalledWith(batch); expect(quick.run).not.toHaveBeenCalled();
  expect(openDetail).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.queryByRole('alertdialog')).toBeNull();
});
it('đợt chưa đủ phiếu con khóa icon và hiển thị lý do mà không mở chi tiết', () => {
  const quick = actions({ batchReason: () => 'Chưa tải đủ phiếu con' }); const openDetail = vi.fn();
  render(<div onClick={openDetail}><QuickExpenseBatchButton batch={batch} quick={quick} /></div>);
  expect((screen.getByRole('button', { name: 'Chi nhanh phiếu tổng' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByTitle('Chưa tải đủ phiếu con'));
  expect(quick.runBatch).not.toHaveBeenCalled(); expect(openDetail).not.toHaveBeenCalled();
});
it('đợt đang xử lý có trạng thái bận và không thể gửi lại', () => {
  const quick = actions({ busy: true, activeBatchId: batch.id });
  render(<QuickExpenseBatchButton batch={batch} quick={quick} />);
  const button = screen.getByRole('button', { name: 'Chi nhanh phiếu tổng' }) as HTMLButtonElement;
  expect(button.disabled).toBe(true); expect(button.getAttribute('aria-busy')).toBe('true');
  fireEvent.click(button); expect(quick.runBatch).not.toHaveBeenCalled();
});
