// @vitest-environment jsdom
// Hộp "Chi lương điều hành" theo sổ (E10) — D2.5: không chi quá số còn lại (mọi trạng thái sổ tổng),
// không ô tạm ứng, đóng băng ⇒ khoá, câu OVERDRAW có số, chỉ sổ quỹ tiền thật của đúng công ty,
// báo trước luật duyệt khi sổ tổng chạy thật. Dữ liệu GIẢ.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ create: vi.fn() }));
const ok = (data: unknown) => ({ data, status: 'success', fetchStatus: 'idle', isLoading: false, isError: false, isSuccess: true, isFetching: false, error: null, refetch: vi.fn() });
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
vi.mock('@/hooks/useAccounts', () => ({
  useAccounts: () => ok([
    { id: 'a1', name: 'Quỹ chủ', code: 'Q1', is_virtual: false, organization_id: 'org-a' },
    { id: 'a3', name: 'CỌC giữ hộ', code: 'Q3', is_virtual: true, organization_id: 'org-a' },
    { id: 'a4', name: 'Quỹ công ty khác', code: 'Q4', is_virtual: false, organization_id: 'org-b' },
  ]),
}));
vi.mock('@/hooks/useIncomeExpenses', () => ({ useCreateManagerSalaryPayout: () => ({ mutateAsync: m.create, isPending: false }) }));
vi.mock('@/components/ui/searchable-select', () => ({
  SearchableSelect: ({ options, onValueChange, value, name }: { options: { value: string; label: string }[]; onValueChange: (s: string) => void; name: string; value: string }) => (
    <select name={name} value={value} onChange={(e) => onValueChange(e.target.value)}>
      <option value="">Chọn</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  ),
}));

import ManagerSalaryPayoutDialog from '../ManagerSalaryPayoutDialog';

const row = (patch: Record<string, unknown> = {}) => ({
  manager_id: 'm1', name: 'Quản lý 1', is_active: true, is_deleted: false, has_login: true, marker: null,
  allocated: 1_500, payouts_approved: 300, payouts_pending: 200, balance: 1_000, status: 'OWED' as const, ...patch,
});
const ledgerOf = (route: string, managers = [row(), row({ manager_id: 'm-gone', name: 'Đã nghỉ', is_deleted: true }), row({ manager_id: 'm-off', name: 'Ngưng', is_active: false })]) => ({
  organization_id: 'org-a', route: route as 'LEGACY', as_of: '2026-11-15T00:00:00Z', managers,
});
const field = (name: string) => document.querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLSelectElement;
const options = (name: string) => Array.from((field(name) as HTMLSelectElement).options).map((o) => o.value).filter(Boolean);
const submit = () => screen.getByRole('button', { name: 'Ghi phiếu chi' }) as HTMLButtonElement;
const fill = (amount: string) => {
  fireEvent.change(field('amount'), { target: { value: amount } });
  fireEvent.change(field('accountId'), { target: { value: 'a1' } });
};

beforeEach(() => { m.create.mockResolvedValue({ id: 'v1', code: 'PC1', balance_before: null }); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('chi lương điều hành theo sổ', () => {
  it('chỉ người nhận còn hiệu lực; chỉ sổ tiền thật của đúng công ty; hiện số còn lại', () => {
    render(<ManagerSalaryPayoutDialog open onOpenChange={vi.fn()} organizationId="org-a" ledger={ledgerOf('LEGACY')} defaultManagerId="m1" />);
    expect(options('managerId')).toEqual(['m1']);
    expect(options('accountId')).toEqual(['a1']);
    expect(screen.getByTestId('manager-payout-balance').textContent).toMatch(/Còn lại \(xem thử\): 1\.000 đ/);
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it.each(['SHADOW', 'CANONICAL'])('sổ tổng chạy (%s): vượt số còn lại ⇒ KHÔNG gọi ghi, báo số còn lại', async (route) => {
    render(<ManagerSalaryPayoutDialog open onOpenChange={vi.fn()} organizationId="org-a" ledger={ledgerOf(route)} defaultManagerId="m1" />);
    fill('1500');
    fireEvent.click(submit());
    expect(await screen.findByText('Vượt lương điều hành còn lại 1.000 đ. Không chi quá số còn lại.')).toBeTruthy();
    expect(m.create).not.toHaveBeenCalled();
  });

  it('sổ tổng còn xem thử (LEGACY): vượt chỉ CẢNH BÁO, vẫn lập phiếu như trước Đợt 2', async () => {
    const onOpenChange = vi.fn();
    render(<ManagerSalaryPayoutDialog open onOpenChange={onOpenChange} organizationId="org-a" ledger={ledgerOf('LEGACY')} defaultManagerId="m1" />);
    expect(screen.getByTestId('manager-payout-balance').textContent).toMatch(/Còn lại \(xem thử\): 1\.000 đ/);
    fill('1500');
    expect((await screen.findByTestId('manager-payout-over-warning')).textContent).toMatch(/Vượt số còn lại 1\.000 đ theo sổ đang xem thử/);
    fireEvent.click(submit());
    await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
    expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ manager_id: 'm1', amount: 1_500 }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('LEGACY, người nhận đã chi vượt: vẫn lập được; sổ tổng chạy thì báo "không chi thêm được"', () => {
    const over = [row({ balance: -200, status: 'ADVANCE' as const })];
    const view = render(<ManagerSalaryPayoutDialog open onOpenChange={vi.fn()} organizationId="org-a" ledger={ledgerOf('LEGACY', over)} defaultManagerId="m1" />);
    expect(screen.getByTestId('manager-payout-balance').textContent).toMatch(/Đã chi vượt \(xem thử\): 200 đ/);
    expect(screen.getByTestId('manager-payout-balance').textContent).not.toMatch(/không chi thêm được/);
    view.rerender(<ManagerSalaryPayoutDialog open onOpenChange={vi.fn()} organizationId="org-a" ledger={ledgerOf('SHADOW', over)} defaultManagerId="m1" />);
    expect(screen.getByTestId('manager-payout-balance').textContent).toMatch(/không chi thêm được/);
  });

  it('trong số còn lại ⇒ gửi đúng người nhận, số tiền, sổ quỹ, công ty', async () => {
    const onOpenChange = vi.fn();
    render(<ManagerSalaryPayoutDialog open onOpenChange={onOpenChange} organizationId="org-a" ledger={ledgerOf('CANONICAL')} defaultManagerId="m1" />);
    fill('800');
    fireEvent.click(submit());
    await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
    expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ manager_id: 'm1', manager_name: 'Quản lý 1', amount: 800, account_id: 'a1', organizationId: 'org-a' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('máy chủ báo vượt (OVERDRAW) ⇒ câu có số từ DETAIL, hộp còn mở', async () => {
    m.create.mockRejectedValueOnce({ code: '22023', message: 'PROFIT_MANAGER_LEDGER_OVERDRAW: vượt', details: '{"balance":700,"amount":800,"over":100}' });
    const onOpenChange = vi.fn();
    render(<ManagerSalaryPayoutDialog open onOpenChange={onOpenChange} organizationId="org-a" ledger={ledgerOf('CANONICAL')} defaultManagerId="m1" />);
    fill('800');
    fireEvent.click(submit());
    expect((await screen.findByRole('alert')).textContent).toMatch(/Vượt lương điều hành còn lại 700 đ \(dư 100 đ\)/);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('sổ tổng đóng băng ⇒ khoá nút + câu báo', () => {
    render(<ManagerSalaryPayoutDialog open onOpenChange={vi.fn()} organizationId="org-a" ledger={ledgerOf('FROZEN')} defaultManagerId="m1" />);
    expect(submit().disabled).toBe(true);
    expect(screen.getByRole('status').textContent).toMatch(/đóng băng/);
  });

  it('chưa có sổ lương điều hành ⇒ khoá, không đoán số còn lại', () => {
    render(<ManagerSalaryPayoutDialog open onOpenChange={vi.fn()} organizationId="org-a" ledger={undefined} defaultManagerId="m1" />);
    expect(submit().disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toMatch(/Chưa tải được lương điều hành còn lại/);
  });

  it('báo trước luật duyệt khi sổ tổng chạy thật (người duyệt ≠ người lập ≠ người nhận); LEGACY không báo', () => {
    const view = render(<ManagerSalaryPayoutDialog open onOpenChange={vi.fn()} organizationId="org-a" ledger={ledgerOf('CANONICAL')} defaultManagerId="m1" />);
    expect(screen.getByTestId('manager-payout-approval-note').textContent).toMatch(/Người duyệt phải khác người lập phiếu và khác người nhận/);
    expect(screen.getByTestId('manager-payout-approval-note').textContent).toMatch(/chính người đó phải lập phiếu/);
    view.rerender(<ManagerSalaryPayoutDialog open onOpenChange={vi.fn()} organizationId="org-a" ledger={ledgerOf('LEGACY')} defaultManagerId="m1" />);
    expect(screen.queryByTestId('manager-payout-approval-note')).toBeNull();
  });
});
