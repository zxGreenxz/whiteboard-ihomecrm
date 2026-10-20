// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { QuickExpenseButton, QuickExpenseToolbar } from '../QuickExpenseActions';
import type { QuickExpenseActions } from '@/hooks/income-expenses/useQuickExpense';
import type { IncomeExpenseWithRelations } from '@/hooks/income-expenses/types';
afterEach(cleanup);
const voucher = { id: 'one', type: 'EXPENSE', approval_status: 'UNAPPROVED', total_amount: 100 } as IncomeExpenseWithRelations;
function actions(patch: Partial<QuickExpenseActions> = {}): QuickExpenseActions {
  return { reason: () => null, busy: false, collecting: false, activeId: null, progress: { done: 0, total: 0 }, selected: [], results: [], error: null, ready: true, checksError: null, retryChecks: vi.fn(async () => {}),
    run: vi.fn(async () => {}), toggle: vi.fn(), togglePage: vi.fn(), clear: vi.fn(), selectAll: vi.fn(async () => {}), ...patch };
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
