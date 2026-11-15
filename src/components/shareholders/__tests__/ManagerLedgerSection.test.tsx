// @vitest-environment jsdom
// Khối "Lương điều hành" theo sổ (E10) — D2.5/D2.6: người đã nghỉ còn số vẫn hiện nhưng không nút Chi,
// Huỷ chỉ ở phiếu lập theo sổ tổng (profit.manager_salary), phiếu cũ ghi "huỷ theo đường cũ",
// đóng băng ⇒ khoá chi, không được xem ⇒ ẩn khối. Dữ liệu GIẢ.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  route: 'LEGACY' as string,
  error: null as unknown,
  managers: [] as unknown[],
  payDialog: [] as { open: boolean; defaultManagerId?: string | null }[],
}));
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

const manager = (patch: Record<string, unknown>) => ({
  manager_id: 'm1', name: 'Quản lý 1', is_active: true, is_deleted: false, has_login: true, marker: null,
  allocated: 1_500, payouts_approved: 300, payouts_pending: 200, balance: 1_000, status: 'OWED', ...patch,
});
const PAYOUTS = [
  { id: 'v-new', code: 'PC0002', voucher_date: '2026-11-03', total_amount: 300, approval_status: 'APPROVED', posting_status: 'POSTED', system_source: 'profit.manager_salary', account_id: 'a1', account_name: 'Quỹ', created_at: '2026-11-03T00:00:00Z', is_ledger_voucher: true },
  { id: 'v-old', code: 'PC0001', voucher_date: '2026-10-03', total_amount: 200, approval_status: 'APPROVED', posting_status: 'POSTED', system_source: 'salary.manager', account_id: 'a1', account_name: 'Quỹ', created_at: '2026-10-03T00:00:00Z', is_ledger_voucher: false },
];

vi.mock('@/hooks/profit-ledger/useProfitLedgerQueries', () => ({
  useProfitManagerLedger: (org: string | null) => (m.error
    ? { data: undefined, isError: true, error: m.error, isLoading: false, refetch: vi.fn() }
    : { data: org ? { organization_id: org, route: m.route, as_of: '2026-11-15T00:00:00Z', managers: m.managers } : undefined, isError: false, error: null, isLoading: false, refetch: vi.fn() }),
  useManagerLedgerPayouts: (org: string | null, id: string | null) => ({ data: org && id ? PAYOUTS : undefined, isError: false, error: null, refetch: vi.fn() }),
}));
vi.mock('../ManagerSalaryPayoutDialog', () => ({
  default: (p: { open: boolean; defaultManagerId?: string | null }) => {
    m.payDialog.push(p);
    return p.open ? <div data-testid="pay-dialog">{p.defaultManagerId ?? 'none'}</div> : null;
  },
}));
vi.mock('../ProfitPayoutCancelDialog', () => ({
  ProfitPayoutCancelDialog: (p: { open: boolean; target: { voucherId: string; kind: string } | null }) =>
    p.open ? <div data-testid="cancel-dialog">{`${p.target?.kind}:${p.target?.voucherId}`}</div> : null,
}));
vi.mock('../ProfitLedgerMarkerDialog', () => ({
  ProfitLedgerMarkerDialog: (p: { open: boolean; subjectKind: string; subject: { name: string } | null }) =>
    p.open ? <div data-testid="marker-dialog">{`${p.subjectKind}:${p.subject?.name}`}</div> : null,
}));

import { ManagerLedgerSection } from '../ManagerLedgerSection';

const rowOf = (id: string) => screen.getByTestId(`manager-row-${id}`);

beforeEach(() => {
  m.route = 'LEGACY';
  m.error = null;
  m.managers = [manager({}), manager({ manager_id: 'm-gone', name: 'Người cũ', is_deleted: true, balance: 400, payouts_pending: 0 })];
  m.payDialog = [];
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Lương điều hành theo sổ (máy tính)', () => {
  it('người đã nghỉ còn số: hiện, mờ, không nút Chi; người còn: Chi mở hộp đúng người', () => {
    render(<ManagerLedgerSection organizationId="org-a" canPayManager variant="desktop" />);
    expect(within(rowOf('m-gone')).getByText('đã nghỉ')).toBeTruthy();
    expect(within(rowOf('m-gone')).queryByRole('button', { name: 'Chi' })).toBeNull();
    expect(screen.getByText(/Quản lý đã xoá — app không chi được phần này/)).toBeTruthy();
    expect(within(rowOf('m1')).getByText(/1\.000/)).toBeTruthy();
    fireEvent.click(within(rowOf('m1')).getByRole('button', { name: 'Chi' }));
    expect(screen.getByTestId('pay-dialog').textContent).toBe('m1');
  });

  it('Huỷ chỉ ở phiếu lập theo sổ tổng; phiếu cũ ghi "huỷ theo đường cũ"', () => {
    render(<ManagerLedgerSection organizationId="org-a" canPayManager variant="desktop" />);
    fireEvent.click(within(rowOf('m1')).getByRole('button', { name: 'Sổ phiếu' }));
    const oldRow = screen.getByTestId('manager-payout-v-old');
    expect(within(oldRow).queryByRole('button', { name: 'Huỷ' })).toBeNull();
    expect(within(oldRow).getByText(/phiếu cũ — huỷ theo đường cũ ở Thu chi/)).toBeTruthy();
    fireEvent.click(within(screen.getByTestId('manager-payout-v-new')).getByRole('button', { name: 'Huỷ' }));
    expect(screen.getByTestId('cancel-dialog').textContent).toBe('MANAGER:v-new');
  });

  it('không có quyền chi lương quản lý ⇒ không nút Chi / Mốc / Huỷ', () => {
    render(<ManagerLedgerSection organizationId="org-a" canPayManager={false} variant="desktop" />);
    expect(within(rowOf('m1')).queryByRole('button', { name: 'Chi' })).toBeNull();
    expect(within(rowOf('m1')).queryByRole('button', { name: 'Mốc' })).toBeNull();
    fireEvent.click(within(rowOf('m1')).getByRole('button', { name: 'Sổ phiếu' }));
    expect(within(screen.getByTestId('manager-payout-v-new')).queryByRole('button', { name: 'Huỷ' })).toBeNull();
  });

  it.each([
    ['LEGACY', false, true],
    ['SHADOW', false, false],
    ['FROZEN', true, true],
  ] as const)('route %s: Chi khoá = %s, Mốc khoá = %s', (route, payLocked, markerLocked) => {
    m.route = route;
    render(<ManagerLedgerSection organizationId="org-a" canPayManager variant="desktop" />);
    expect((within(rowOf('m1')).getByRole('button', { name: 'Chi' }) as HTMLButtonElement).disabled).toBe(payLocked);
    const marker = within(rowOf('m1')).getByRole('button', { name: 'Mốc' }) as HTMLButtonElement;
    expect(marker.disabled).toBe(markerLocked);
    if (!markerLocked) {
      fireEvent.click(marker);
      expect(screen.getByTestId('marker-dialog').textContent).toBe('MANAGER:Quản lý 1');
    }
  });

  it('hết số còn lại ⇒ Chi khoá', () => {
    m.managers = [manager({ balance: 0, status: 'SETTLED' })];
    render(<ManagerLedgerSection organizationId="org-a" canPayManager variant="desktop" />);
    expect((within(rowOf('m1')).getByRole('button', { name: 'Chi' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('không được xem sổ lương điều hành / chưa có người nhận ⇒ ẩn khối', () => {
    m.error = { code: '42501', message: 'PROFIT_LEDGER_FORBIDDEN: bạn không có quyền xem sổ lương điều hành của công ty này' };
    const view = render(<ManagerLedgerSection organizationId="org-a" canPayManager variant="desktop" />);
    expect(screen.queryByTestId('manager-ledger-section')).toBeNull();
    m.error = null;
    m.managers = [];
    view.rerender(<ManagerLedgerSection organizationId="org-a" canPayManager variant="desktop" />);
    expect(screen.queryByTestId('manager-ledger-section')).toBeNull();
  });

  it('lỗi đọc khác ⇒ báo tại chỗ có nút tải lại', () => {
    m.error = { code: 'XX000', message: 'lệch' };
    render(<ManagerLedgerSection organizationId="org-a" canPayManager variant="desktop" />);
    expect(within(screen.getByTestId('manager-ledger-section')).getByRole('button', { name: /Tải lại/ })).toBeTruthy();
  });
});

describe('Lương điều hành theo sổ (điện thoại)', () => {
  it('thẻ có số còn lại + Chi; không có nút Mốc; bấm thẻ mở sổ phiếu', () => {
    render(<ManagerLedgerSection organizationId="org-a" canPayManager variant="mobile" />);
    expect(within(rowOf('m1')).getByRole('button', { name: 'Chi' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Mốc' })).toBeNull();
    expect(within(rowOf('m-gone')).queryByRole('button', { name: 'Chi' })).toBeNull();
    fireEvent.click(within(rowOf('m1')).getByText('Quản lý 1'));
    expect(screen.getByTestId('manager-payouts')).toBeTruthy();
  });
});
