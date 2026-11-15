// @vitest-environment jsdom
// Sổ chi tiết một cổ đông (E2) — D2.4/D2.6: số dư chạy, dòng trước mốc mờ, Huỷ chỉ ở phiếu chi lập
// theo sổ tổng còn huỷ được, "Xác nhận phần lương" chỉ ở phiếu lương cần xem lại (máy tính). Dữ liệu GIẢ.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ entriesArgs: [] as unknown[][] }));
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

const entry = (patch: Record<string, unknown>) => ({
  key: 'x', kind: 'ALLOCATION', line_id: null, period_month: null, building_id: null, building_name: null, amount: 0,
  suggested: null, voucher_id: null, voucher_code: null, voucher_date: null, voucher_status: null, posting_status: null,
  account_name: null, maker_user_id: null, is_mine: false, is_advance: false, created_at: '2026-10-02T00:00:00Z',
  excluded_by_marker: false, running_balance: 0, ...patch,
});
const ENTRIES = [
  entry({ key: 'ALLOCATION:a0', line_id: 'a0', period_month: '2026-08-01', building_name: 'Toà A', amount: 1_000, excluded_by_marker: true, running_balance: 0 }),
  entry({ key: 'ALLOCATION:a1', line_id: 'a1', period_month: '2026-10-01', building_name: 'Toà A', amount: 5_000, running_balance: 5_000 }),
  entry({ key: 'PAYOUT:v1', kind: 'PAYOUT', voucher_id: 'v1', voucher_code: 'PC0001', voucher_date: '2026-11-02', voucher_status: 'UNAPPROVED', amount: -2_000, maker_user_id: 'u-chu', account_name: 'Quỹ', is_advance: true, running_balance: 3_000 }),
  entry({ key: 'PAYOUT:v0', kind: 'PAYOUT', voucher_id: 'v0', voucher_code: 'PC0000', voucher_date: '2026-11-01', voucher_status: 'APPROVED', posting_status: 'POSTED', amount: -500, running_balance: 2_500 }),
  entry({ key: 'SALARY_REVIEW:l1', kind: 'SALARY_REVIEW', line_id: 'l1', period_month: '2026-10-01', voucher_id: 'sv1', voucher_code: 'PC0009', suggested: 700, amount: 0, running_balance: 2_500 }),
];
const DATA = {
  organization_id: 'org-a',
  shareholder: { shareholder_id: 's1', name: 'An', is_active: true, is_deleted: false, has_login: true },
  marker: { id: 'mk', settled_through_month: '2026-08-01', ledger_seq: 2 },
  totals: {
    allocated: 5_000, payouts_approved: 500, payouts_pending: 2_000, salary_investment: 0, salary_advance_offset: 0, balance: 2_500,
    status: 'OWED', excluded_before_marker: { allocated: 1_000, payouts: 0, salary: 0 }, needs_review: { count: 1, suggested: 700 },
  },
  entries: ENTRIES,
};

vi.mock('@/hooks/profit-ledger/useProfitLedgerQueries', () => ({
  useShareholderProfitLedgerEntries: (org: string | null, sh: string | null) => {
    m.entriesArgs.push([org, sh]);
    return org ? { data: DATA, isError: false, error: null, isLoading: false, refetch: vi.fn() } : { data: undefined, isError: false, error: null, isLoading: false, refetch: vi.fn() };
  },
}));
vi.mock('../ProfitPayoutCancelDialog', () => ({
  ProfitPayoutCancelDialog: (p: { open: boolean; target: { voucherId: string } | null }) =>
    p.open ? <div data-testid="cancel-dialog">{p.target?.voucherId}</div> : null,
}));
vi.mock('../SalaryProfitResolveDialog', () => ({
  SalaryProfitResolveDialog: (p: { open: boolean; entry: { line_id: string } | null }) =>
    p.open ? <div data-testid="resolve-dialog">{p.entry?.line_id}</div> : null,
}));

import { ShareholderLedgerSheet } from '../ShareholderLedgerSheet';

const props = {
  open: true, onOpenChange: vi.fn(), organizationId: 'org-a', shareholder: { id: 's1', name: 'An' },
  route: 'SHADOW' as const, canDistribute: true,
};
const rowOf = (key: string) => screen.getByTestId(`ledger-entry-${key}`);

beforeEach(() => { m.entriesArgs = []; });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Sổ chi tiết cổ đông', () => {
  it('đọc E2 đúng công ty + cổ đông; hiện số dư chạy; dòng trước mốc mờ', () => {
    render(<ShareholderLedgerSheet {...props} />);
    expect(m.entriesArgs.at(-1)).toEqual(['org-a', 's1']);
    expect(within(rowOf('PAYOUT:v1')).getByText('3.000 đ')).toBeTruthy();
    expect(within(rowOf('PAYOUT:v1')).getByText('tạm ứng')).toBeTruthy();
    expect(rowOf('ALLOCATION:a0').getAttribute('data-excluded')).toBe('true');
    expect(rowOf('ALLOCATION:a0').className).toMatch(/opacity-50/);
    expect(rowOf('ALLOCATION:a1').getAttribute('data-excluded')).toBeNull();
    expect(screen.getByTestId('ledger-totals').textContent).toMatch(/Mốc đã trả đủ: hết T08\/2026/);
    expect(screen.getByTestId('ledger-totals').textContent).toMatch(/1 phiếu lương cần chủ xem lại/);
  });

  it('Huỷ chỉ ở phiếu chi lập theo sổ tổng; phiếu cũ ghi "huỷ ở Thu chi"', () => {
    render(<ShareholderLedgerSheet {...props} />);
    expect(within(rowOf('PAYOUT:v0')).queryByRole('button', { name: 'Huỷ' })).toBeNull();
    expect(within(rowOf('PAYOUT:v0')).getByText(/phiếu cũ — huỷ ở Thu chi/)).toBeTruthy();
    expect(within(rowOf('ALLOCATION:a1')).queryByRole('button')).toBeNull();
    fireEvent.click(within(rowOf('PAYOUT:v1')).getByRole('button', { name: 'Huỷ' }));
    expect(screen.getByTestId('cancel-dialog').textContent).toBe('v1');
  });

  it('"Xác nhận phần lương" chỉ ở phiếu lương cần xem lại, khi sổ tổng cho xác nhận', () => {
    render(<ShareholderLedgerSheet {...props} />);
    const buttons = screen.getAllByRole('button', { name: 'Xác nhận phần lương' });
    expect(buttons).toHaveLength(1);
    expect(within(rowOf('SALARY_REVIEW:l1')).getByRole('button', { name: 'Xác nhận phần lương' })).toBe(buttons[0]);
    fireEvent.click(buttons[0]!);
    expect(screen.getByTestId('resolve-dialog').textContent).toBe('l1');
  });

  it.each([
    ['LEGACY', false],
    ['FROZEN', false],
    ['CANONICAL', true],
  ] as const)('route %s ⇒ nút xác nhận phần lương: %s', (route, shown) => {
    render(<ShareholderLedgerSheet {...props} route={route} />);
    expect(!!screen.queryByRole('button', { name: 'Xác nhận phần lương' })).toBe(shown);
    // Huỷ chạy ở mọi trạng thái sổ tổng.
    expect(within(rowOf('PAYOUT:v1')).getByRole('button', { name: 'Huỷ' })).toBeTruthy();
  });

  it('điện thoại (compact): xem + huỷ, không xác nhận phần lương', () => {
    render(<ShareholderLedgerSheet {...props} route="CANONICAL" compact />);
    expect(screen.queryByRole('button', { name: 'Xác nhận phần lương' })).toBeNull();
    expect(within(rowOf('PAYOUT:v1')).getByRole('button', { name: 'Huỷ' })).toBeTruthy();
  });

  it('không có quyền chi: chỉ người lập tự huỷ phiếu chờ duyệt của mình', () => {
    render(<ShareholderLedgerSheet {...props} canDistribute={false} />);
    expect(within(rowOf('PAYOUT:v1')).queryByRole('button', { name: 'Huỷ' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Xác nhận phần lương' })).toBeNull();
  });
});
