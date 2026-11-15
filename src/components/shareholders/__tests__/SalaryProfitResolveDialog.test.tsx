// @vitest-environment jsdom
// Hộp "Xác nhận phần lương" (E16) — D2.4: gợi ý của máy làm mặc định, Y − D vượt tiền phiếu lương bị
// chặn ở máy khách, gửi đúng tham số, chưa rõ kết quả ⇒ khoá + "Kiểm tra lại kết quả" gửi y nguyên. Dữ liệu GIẢ.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ mutate: vi.fn(), voucher: { total_amount: 1_000 } as { total_amount: number } | null, voucherError: false }));
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
vi.mock('sonner', () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('@/hooks/income-expenses/detailRead', () => ({
  useIncomeExpenseDetail: () => ({ data: m.voucherError ? undefined : m.voucher, isLoading: false, isError: m.voucherError, error: null }),
}));
vi.mock('@/hooks/profit-ledger/useProfitLedgerMutations', () => ({
  useResolveSalaryProfitLine: () => ({ mutateAsync: m.mutate, isPending: false }),
}));

import { SalaryProfitResolveDialog } from '../SalaryProfitResolveDialog';
import { FinancialWorkflowError } from '@/lib/financialWorkflow';
import type { ShareholderLedgerEntry } from '@/lib/profitLedger/ledgerReaders';

const ENTRY: ShareholderLedgerEntry = {
  key: 'SALARY_REVIEW:l1', kind: 'SALARY_REVIEW', line_id: 'l1', period_month: '2026-10-01', building_id: null, building_name: null,
  amount: 0, suggested: 700, voucher_id: 'sv1', voucher_code: 'PC0009', voucher_date: null, voucher_status: 'APPROVED',
  posting_status: null, account_name: null, maker_user_id: null, is_mine: false, is_advance: false,
  created_at: '2026-11-02T00:00:00Z', excluded_by_marker: false, running_balance: 0,
};
const LY_DO = 'Đối chiếu bảng lương tháng 10 đã khớp';
const field = (name: string) => document.querySelector(`[name="${name}"]`) as HTMLInputElement;
const submit = () => screen.getByRole('button', { name: 'Xác nhận phần lương' });
const props = { onOpenChange: vi.fn(), organizationId: 'org-a', entry: ENTRY, shareholderName: 'An' };

beforeEach(() => {
  m.voucher = { total_amount: 1_000 };
  m.voucherError = false;
  m.mutate.mockResolvedValue({ line_id: 'l1', shareholder_id: 's1', salary_voucher_id: 'sv1', period_month: '2026-10-01', investment_amount: 700, advance_offset_amount: 0, balance_before: 5_000, balance_after: 4_300 });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('xác nhận phần lợi nhuận trong phiếu lương', () => {
  it('mặc định là số máy gợi ý; gửi đúng dòng, Y, D, lý do', async () => {
    render(<SalaryProfitResolveDialog open {...props} />);
    expect(screen.getByTestId('salary-resolve-context').textContent).toMatch(/Tiền phiếu lương: 1\.000 đ/);
    fireEvent.change(field('reason'), { target: { value: LY_DO } });
    fireEvent.click(submit());
    await waitFor(() => expect(m.mutate).toHaveBeenCalledTimes(1));
    expect(m.mutate).toHaveBeenCalledWith({ organizationId: 'org-a', lineId: 'l1', investment: 700, offset: 0, reason: LY_DO });
  });

  it('Y − D vượt tiền phiếu lương ⇒ chặn ở máy khách, không gọi ghi', async () => {
    render(<SalaryProfitResolveDialog open {...props} />);
    fireEvent.change(field('investment'), { target: { value: '1500' } });
    fireEvent.change(field('offset'), { target: { value: '100' } });
    fireEvent.change(field('reason'), { target: { value: LY_DO } });
    fireEvent.click(submit());
    expect(await screen.findByText('Phần đầu tư trừ phần bù tạm ứng không được vượt tiền phiếu lương.')).toBeTruthy();
    expect(m.mutate).not.toHaveBeenCalled();
  });

  it('lý do ngắn ⇒ không gửi', async () => {
    render(<SalaryProfitResolveDialog open {...props} />);
    fireEvent.change(field('reason'), { target: { value: 'ngắn' } });
    fireEvent.click(submit());
    expect(await screen.findByText('Lý do xác nhận phải từ 8 đến 1000 ký tự')).toBeTruthy();
    expect(m.mutate).not.toHaveBeenCalled();
  });

  it('máy chủ báo ngoài trần ⇒ câu có trần, giữ hộp mở', async () => {
    m.mutate.mockRejectedValueOnce({ code: '22023', message: 'PROFIT_LEDGER_SALARY_RESOLVE_RANGE: ngoài trần', details: '{"min_investment":0,"max_investment":600,"max_offset":0,"voucher_amount":1000}' });
    render(<SalaryProfitResolveDialog open {...props} />);
    fireEvent.change(field('reason'), { target: { value: LY_DO } });
    fireEvent.click(submit());
    expect((await screen.findByRole('alert')).textContent).toMatch(/từ 0 đ đến 600 đ/);
    expect(props.onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('chưa rõ kết quả ⇒ khoá ô, "Kiểm tra lại kết quả" gửi lại y nguyên', async () => {
    m.mutate.mockRejectedValueOnce(new FinancialWorkflowError('Chưa xác nhận được kết quả.', 'unknown', []));
    render(<SalaryProfitResolveDialog open {...props} />);
    fireEvent.change(field('reason'), { target: { value: LY_DO } });
    fireEvent.click(submit());
    const recheck = await screen.findByRole('button', { name: 'Kiểm tra lại kết quả' });
    expect(field('reason').closest('fieldset')?.disabled).toBe(true);
    fireEvent.click(recheck);
    await waitFor(() => expect(m.mutate).toHaveBeenCalledTimes(2));
    expect(m.mutate.mock.calls[1]![0]).toEqual(m.mutate.mock.calls[0]![0]);
  });

  it('không đọc được tiền phiếu ⇒ vẫn cho gửi (máy chủ kiểm trần), có câu báo', async () => {
    m.voucherError = true;
    render(<SalaryProfitResolveDialog open {...props} />);
    expect(screen.getByTestId('salary-resolve-context').textContent).toMatch(/Chưa đọc được tiền phiếu lương/);
    fireEvent.change(field('investment'), { target: { value: '1500' } });
    fireEvent.change(field('reason'), { target: { value: LY_DO } });
    fireEvent.click(submit());
    await waitFor(() => expect(m.mutate).toHaveBeenCalledTimes(1));
  });
});
