// @vitest-environment jsdom
// Hộp "Xác nhận phần lương" (E16) — D2.4 + review chéo Đợt 2: KHÔNG để sẵn số (tự nhập cả Y lẫn D),
// hiện D còn trừ được của tháng từ bảng lương (E12 đúng nhân viên + kỳ), chặn sớm cùng luật máy chủ
// (0 ≤ D ≤ D còn lại, Y giữa 0 và phần còn lại, Y − D ≤ tiền phiếu), chưa đối chiếu được bảng lương ⇒
// khoá nút, chưa rõ kết quả ⇒ "Kiểm tra lại kết quả" gửi y nguyên. Dữ liệu GIẢ.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type InputsArgs = { periodMonth: string | null; staffId: string | null; enabled?: boolean };
const m = vi.hoisted(() => ({
  mutate: vi.fn(),
  refetch: vi.fn(),
  inputsArgs: [] as InputsArgs[],
  staff: null as unknown,
  inputsError: null as unknown,
  shareholders: [] as { id: string; name: string; auth_user_id: string | null }[],
}));
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
vi.mock('sonner', () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('@/hooks/useShareholders', () => ({
  useShareholders: () => ({ data: m.shareholders, isLoading: false, isError: false, error: null, refetch: vi.fn() }),
}));
vi.mock('@/hooks/profit-ledger/useSalaryProfitStaffInputs', () => ({
  useSalaryProfitStaffInputs: (args: InputsArgs) => {
    m.inputsArgs.push(args);
    if (m.inputsError) return { data: undefined, isLoading: false, isFetching: false, isError: true, error: m.inputsError, refetch: m.refetch };
    return { data: args.staffId && args.enabled ? m.staff : undefined, isLoading: false, isFetching: false, isError: false, error: null, refetch: m.refetch };
  },
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
// E12 của nhân viên: D tháng 300, đã trừ 100 ⇒ còn trừ được 200; đầu tư còn lại 900 − 0; tiền phiếu 1.000.
const STAFF = {
  staff_id: 'u-1', organization_id: 'org-a', shareholder_id: 's1', sheet_status: 'DRAFT', profit_draft: false,
  allocations: [], by_building: [], allocated_total: 900, investment_month: 900, investment_cap: 900,
  marker_through: null, settled_by_marker: false, settlement: null,
  paid_lines: [{
    line_id: 'l1', salary_voucher_id: 'sv1', voucher_code: 'PC0009', voucher_amount: 1_000, voucher_live: true,
    investment: 0, advance_offset: 0, suggested_investment: 700, state: 'NEEDS_REVIEW', source: 'PAYOUT_FALLBACK',
    created_at: '2026-11-02T00:00:00Z', linked_at: null,
  }],
  paid_investment: 0, paid_offset: 100, advance_open: 300, advance_offset_month: 300, suggested_advance_offset: 300,
  remaining_offset: 200, offset_conflict: false, needs_review: { count: 1, suggested: 700 },
};
const LY_DO = 'Đối chiếu bảng lương tháng 10 đã khớp';
const field = (name: string) => document.querySelector(`[name="${name}"]`) as HTMLInputElement;
const submit = () => screen.getByRole('button', { name: 'Xác nhận phần lương' }) as HTMLButtonElement;
const props = { onOpenChange: vi.fn(), organizationId: 'org-a', shareholderId: 's1', entry: ENTRY, shareholderName: 'An' };
const fill = (investment: string, offset: string) => {
  fireEvent.change(field('investment'), { target: { value: investment } });
  fireEvent.change(field('offset'), { target: { value: offset } });
  fireEvent.change(field('reason'), { target: { value: LY_DO } });
};

beforeEach(() => {
  m.inputsArgs = [];
  m.staff = STAFF;
  m.inputsError = null;
  m.shareholders = [{ id: 's1', name: 'An', auth_user_id: 'u-1' }, { id: 's2', name: 'Bình', auth_user_id: 'u-2' }];
  m.mutate.mockResolvedValue({ line_id: 'l1', shareholder_id: 's1', salary_voucher_id: 'sv1', period_month: '2026-10-01', investment_amount: 700, advance_offset_amount: 200, balance_before: 5_000, balance_after: 4_500 });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('xác nhận phần lợi nhuận trong phiếu lương', () => {
  it('đọc E12 đúng nhân viên của cổ đông + kỳ; hiện D còn trừ được của tháng và gợi ý bên cạnh', () => {
    render(<SalaryProfitResolveDialog open {...props} />);
    expect(m.inputsArgs.at(-1)).toEqual({ periodMonth: '2026-10-01', staffId: 'u-1', enabled: true });
    expect(screen.getByTestId('salary-resolve-offset-left').textContent).toMatch(/còn trừ được của tháng: 200 đ.*cả tháng 300 đ.*đã trừ ở phiếu trước 100 đ/);
    expect(screen.getByTestId('salary-resolve-context').textContent).toMatch(/Tiền phiếu lương: 1\.000 đ/);
    expect(screen.getByTestId('salary-resolve-suggested').textContent).toMatch(/Máy gợi ý: 700 đ/);
  });

  it('KHÔNG để sẵn số: chưa nhập Y và D ⇒ báo tự nhập cả hai, không gọi ghi', async () => {
    render(<SalaryProfitResolveDialog open {...props} />);
    expect(field('investment').value).toBe('');
    expect(field('offset').value).toBe('');
    fireEvent.change(field('reason'), { target: { value: LY_DO } });
    fireEvent.click(submit());
    expect(await screen.findByText('Tự nhập phần đầu tư của phiếu này (không có thì nhập 0).')).toBeTruthy();
    expect(screen.getByText('Tự nhập phần lương bù tạm ứng của phiếu này (không có thì nhập 0).')).toBeTruthy();
    expect(m.mutate).not.toHaveBeenCalled();
  });

  it('nhập đủ trong trần ⇒ gửi đúng dòng, Y, D, lý do', async () => {
    render(<SalaryProfitResolveDialog open {...props} />);
    fill('700', '200');
    fireEvent.click(submit());
    await waitFor(() => expect(m.mutate).toHaveBeenCalledTimes(1));
    expect(m.mutate).toHaveBeenCalledWith({ organizationId: 'org-a', lineId: 'l1', investment: 700, offset: 200, reason: LY_DO });
  });

  it('D vượt phần còn trừ được của tháng ⇒ chặn ở máy khách', async () => {
    render(<SalaryProfitResolveDialog open {...props} />);
    fill('700', '250');
    fireEvent.click(submit());
    expect(await screen.findByText('Phần bù tạm ứng vượt phần còn trừ được của tháng.')).toBeTruthy();
    expect(m.mutate).not.toHaveBeenCalled();
  });

  it('Y ngoài phần đầu tư còn lại / Y − D vượt tiền phiếu ⇒ chặn ở máy khách', async () => {
    render(<SalaryProfitResolveDialog open {...props} />);
    fill('950', '0');
    fireEvent.click(submit());
    expect(await screen.findByText('Phần đầu tư nằm ngoài phần còn lại của tháng.')).toBeTruthy();
    expect(m.mutate).not.toHaveBeenCalled();
    cleanup();
    m.staff = { ...STAFF, investment_cap: 5_000, paid_lines: [{ ...STAFF.paid_lines[0]!, voucher_amount: 500 }] };
    render(<SalaryProfitResolveDialog open {...props} />);
    fill('800', '100');
    fireEvent.click(submit());
    expect(await screen.findByText('Phần đầu tư trừ phần bù tạm ứng không được vượt tiền phiếu lương.')).toBeTruthy();
    expect(m.mutate).not.toHaveBeenCalled();
  });

  it('chưa đọc được bảng lương (E12 lỗi) ⇒ khoá nút, có Thử lại', () => {
    m.inputsError = { code: '42501', message: 'SALARY_PROFIT_DENIED: không có quyền' };
    render(<SalaryProfitResolveDialog open {...props} />);
    expect(submit().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    expect(m.refetch).toHaveBeenCalled();
  });

  it('dòng không còn chờ xem lại / cổ đông chưa gắn tài khoản ⇒ không đối chiếu được ⇒ khoá nút', () => {
    m.staff = { ...STAFF, paid_lines: [{ ...STAFF.paid_lines[0]!, state: 'LINKED' }] };
    const view = render(<SalaryProfitResolveDialog open {...props} />);
    expect(submit().disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toMatch(/Chưa đối chiếu được dòng phiếu lương/);
    m.staff = STAFF;
    m.shareholders = [{ id: 's1', name: 'An', auth_user_id: null }];
    view.rerender(<SalaryProfitResolveDialog open {...props} />);
    expect(submit().disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toMatch(/chưa gắn tài khoản nhân viên/);
  });

  it('máy chủ báo ngoài trần ⇒ câu có trần, giữ hộp mở', async () => {
    m.mutate.mockRejectedValueOnce({ code: '22023', message: 'PROFIT_LEDGER_SALARY_RESOLVE_RANGE: ngoài trần', details: '{"min_investment":0,"max_investment":600,"max_offset":0,"voucher_amount":1000}' });
    render(<SalaryProfitResolveDialog open {...props} />);
    fill('700', '0');
    fireEvent.click(submit());
    expect((await screen.findByRole('alert')).textContent).toMatch(/từ 0 đ đến 600 đ/);
    expect(props.onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('chưa rõ kết quả ⇒ khoá ô, "Kiểm tra lại kết quả" gửi lại y nguyên', async () => {
    m.mutate.mockRejectedValueOnce(new FinancialWorkflowError('Chưa xác nhận được kết quả.', 'unknown', []));
    render(<SalaryProfitResolveDialog open {...props} />);
    fill('700', '200');
    fireEvent.click(submit());
    const recheck = await screen.findByRole('button', { name: 'Kiểm tra lại kết quả' });
    expect(field('reason').closest('fieldset')?.disabled).toBe(true);
    fireEvent.click(recheck);
    await waitFor(() => expect(m.mutate).toHaveBeenCalledTimes(2));
    expect(m.mutate.mock.calls[1]![0]).toEqual(m.mutate.mock.calls[0]![0]);
  });
});
