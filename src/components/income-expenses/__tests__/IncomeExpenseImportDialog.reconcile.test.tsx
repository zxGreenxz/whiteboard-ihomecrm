// @vitest-environment jsdom
// Đợt 9: lượt nhập Excel trước còn chưa rõ ⇒ hook trả kết quả ĐỐI CHIẾU của lượt đó (số dòng Excel của lượt đó). Hộp hiện rõ
// tệp vừa chọn chưa được nhập, các dòng đã có phiếu / có thể đã ghi / chưa ghi, và cho chọn tệp khác để nhập phần còn lại.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ save: vi.fn(), parse: vi.fn() }));
vi.mock('@/hooks/useIncomeExpenses', () => ({ useImportIncomeExpenses: () => ({ mutateAsync: io.save, isPending: false }) }));
vi.mock('@/lib/excelHelpers', () => ({ parseExcelFile: io.parse }));
vi.mock('@/hooks/useIncomeExpensesHelpers', () => ({ validateImportRows: (rows: unknown[]) => ({ validRows: rows, errors: [] }) }));
vi.mock('@/lib/ieTypeLookup', () => ({ resolveImportIeType: () => ({ ok: true, type: { id: 't1', is_deposit: false } }) }));
vi.mock('@/hooks/useBuildings', () => ({ useBuildings: () => ({ data: [{ id: 'b1', name: 'Tòa A' }] }) }));
vi.mock('@/hooks/useIncomeExpenseTypes', () => ({ useIncomeExpenseTypes: () => ({ data: [] }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
import IncomeExpenseImportDialog from '../IncomeExpenseImportDialog';
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('kết quả đối chiếu lượt trước: báo tệp vừa chọn chưa nhập, nêu đúng số dòng Excel của lượt đó, «có thể đã ghi» kèm mã; chọn tệp khác được', async () => {
  io.parse.mockResolvedValue([
    { type: 'EXPENSE', building_name: 'Tòa A', name: 'Chi sửa', voucher_date: '2026-11-20', item_name: 'Sửa', amount: 100 },
  ]);
  io.save.mockResolvedValue({
    successCount: 1, failedCount: 2, reconciledFrom: '09:00 ngày 26/11/2026',
    createdVouchers: [{ row: 7, id: 'v7', code: 'PC07' }],
    possiblyWritten: [{ row: 9, codes: ['PC09'] }],
    errors: [{ row: 11, message: 'Chưa ghi: không thấy phiếu của dòng này trên máy chủ. Nhập lại dòng này.' }],
  });
  render(<IncomeExpenseImportDialog open onOpenChange={vi.fn()} />);
  fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File(['data'], 'thuchi.xlsx')] } });
  await screen.findByText('thuchi.xlsx');
  fireEvent.click(screen.getByRole('button', { name: 'Nhập dữ liệu (1 dòng)' }));
  const status = await screen.findByRole('status');
  expect(status.textContent).toContain('09:00 ngày 26/11/2026');
  expect(status.textContent).toContain('CHƯA được nhập');
  expect(screen.getByText('PC07').closest('p')!.textContent).toContain('Dòng 7');
  expect(screen.getByText(/Dòng 9: có thể đã ghi \(mã PC09\)/)).toBeTruthy();
  expect(screen.getByText(/Dòng 11: Chưa ghi/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Chọn file khác' }));
  expect(screen.getByText('Kéo thả file vào đây hoặc nhấn để chọn file')).toBeTruthy();
});
