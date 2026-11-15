// @vitest-environment jsdom
// Màn cổ đông tự xem theo sổ tổng (máy tính): chỉ tiền của chính mình; tỷ lệ % / số toà chỉ khi có quyền
// VÀ máy chủ gửi kèm; phiếu tự lập còn chờ thì "Huỷ yêu cầu"; nút "Chi tạm ứng cho tôi" theo quyền + công tắc.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MyProfitLedger } from '@/lib/profitLedger/ledgerReaders';

const h = vi.hoisted(() => ({ distribute: vi.fn(), cancel: vi.fn() }));

vi.mock('@/pages/reports/finance/ProfitHubShell', () => ({
  ProfitHubSlot: ({ name, children }: { name: string; children?: ReactNode }) => createElement('div', { 'data-slot': name }, children),
}));
vi.mock('@/components/shareholders/ProfitDistributeDialog', () => ({
  default: (props: Record<string, unknown>) => {
    h.distribute(props);
    return props.open ? createElement('div', { 'data-testid': 'advance-dialog' }) : null;
  },
}));
vi.mock('@/components/shareholders/ProfitPayoutCancelDialog', () => ({
  ProfitPayoutCancelDialog: (props: { open: boolean; target: unknown }) => {
    h.cancel(props);
    return props.open ? createElement('div', { 'data-testid': 'cancel-dialog' }) : null;
  },
}));

import ShareholderLedgerSelfView, { type ShareholderSelfAccess } from '../ShareholderLedgerSelfView';

const ledger = (over: Partial<MyProfitLedger> = {}): MyProfitLedger => ({
  organization_id: 'org-a', route: 'CANONICAL', ready: true, shareholder: { id: 'sh-1', name: 'Cổ đông 1' },
  balance: 8_650_000, status: 'OWED', allocated: 15_450_000, paid: 3_000_000, paid_pending: 3_000_000,
  paid_via_salary: 1_200_000, advance_recovered: 400_000,
  marker: null,
  months: [{ period_month: `${new Date().getFullYear()}-08-01`, amount: 2_450_000, excluded_by_marker: false, buildings: [
    { building_id: 'b2', building_name: 'Toà Hai', amount: -1_550_000 }, { building_id: 'b1', building_name: 'Toà Một', amount: 4_000_000 },
  ] }],
  payouts: [
    { voucher_id: 'v1', voucher_code: 'PC-DUYET', voucher_date: '2026-09-01', amount: 3_000_000, status: 'APPROVED', posting_status: 'POSTED', is_advance: false, is_mine: false, is_mine_pending: false, excluded_by_marker: false },
    { voucher_id: 'v2', voucher_code: 'PC-CHO', voucher_date: '2026-10-10', amount: 3_000_000, status: 'UNAPPROVED', posting_status: 'UNPOSTED', is_advance: true, is_mine: true, is_mine_pending: true, excluded_by_marker: false },
    { voucher_id: 'v3', voucher_code: 'PC-CHU-LAP', voucher_date: '2026-10-11', amount: 500_000, status: 'UNAPPROVED', posting_status: 'UNPOSTED', is_advance: false, is_mine: false, is_mine_pending: false, excluded_by_marker: false },
  ],
  salary: [{ period_month: '2026-08-01', investment: 1_200_000, advance_offset: 400_000, excluded_by_marker: false }],
  ...over,
});

const NO_ACCESS: ShareholderSelfAccess = { canViewPercent: false, canViewBuildingTotals: false, canAdvanceOwn: false };
const view = (l: MyProfitLedger, access: Partial<ShareholderSelfAccess> = {}) =>
  render(<ShareholderLedgerSelfView ledger={l} access={{ ...NO_ACCESS, ...access }} />);
const kpis = () => document.querySelector('[data-slot="kpis"]') as HTMLElement;
const SENSITIVE = {
  percent_rows: [{ building_id: 'b1', building_name: 'Toà Một', percent: 20 }],
  building_totals: [{ period_month: `${new Date().getFullYear()}-08-01`, building_id: 'b1', building_name: 'Toà Một', revenue: null, expense: 40_000_000, profit: 60_000_000 }],
};

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('ShareholderLedgerSelfView — tiền của chính mình', () => {
  it('KPI theo sổ tổng: được chia, đã nhận + chờ duyệt, qua lương (Y − D), còn được nhận', () => {
    view(ledger());
    expect(within(kpis()).getByTestId('self-kpi-allocated').textContent).toMatch(/15\.450\.000/);
    expect(within(kpis()).getByTestId('self-kpi-paid').textContent).toMatch(/Đã nhận3\.000\.000.*chờ duyệt 3\.000\.000/);
    expect(within(kpis()).getByTestId('self-kpi-salary').textContent).toMatch(/Qua lương800\.000.*trừ tạm ứng 400\.000/);
    expect(within(kpis()).getByTestId('self-kpi-balance').textContent).toMatch(/Còn được nhận8\.650\.000/);
  });

  it('đang tạm ứng ⇒ "Đang tạm ứng" số dương; mốc ⇒ "sau mốc đã trả đủ hết MM/YYYY"', () => {
    view(ledger({ balance: -300_000, status: 'ADVANCE', marker: { settled_through_month: '2026-08-01' } }));
    expect(within(kpis()).getByTestId('self-kpi-balance').textContent).toMatch(/Đang tạm ứng300\.000/);
    expect(within(kpis()).getByTestId('self-kpi-allocated').textContent).toContain('sau mốc đã trả đủ hết 08/2026');
  });

  it('không có dòng lương ⇒ không có ô "Qua lương" (không hiện 0)', () => {
    view(ledger({ salary: [], paid_via_salary: 0, advance_recovered: 0 }));
    expect(screen.queryByTestId('self-kpi-salary')).toBeNull();
  });
});

describe('ShareholderLedgerSelfView — tỷ lệ % và số toà theo quyền', () => {
  it('thiếu quyền ⇒ không "%" trong vùng số, không thẻ tỷ lệ / số toà — kể cả khi payload lỡ mang hai mảng', () => {
    view(ledger(SENSITIVE));
    expect(kpis().textContent).not.toContain('%');
    expect(screen.queryByTestId('self-percent-card')).toBeNull();
    expect(screen.queryByTestId('self-building-totals-card')).toBeNull();
    expect(document.body.textContent).not.toContain('20%');
    expect(document.body.textContent).not.toMatch(/60\.000\.000/);
  });

  it('có quyền + máy chủ gửi ⇒ thẻ "Tỷ lệ của bạn" và thẻ doanh thu / lợi nhuận toà (doanh thu null ⇒ "—")', () => {
    view(ledger(SENSITIVE), { canViewPercent: true, canViewBuildingTotals: true });
    expect(screen.getByTestId('self-percent-card').textContent).toMatch(/Toà Một20%/);
    const totals = screen.getByTestId('self-building-totals-card');
    expect(totals.textContent).toMatch(/60\.000\.000/);
    expect(within(totals).getAllByRole('cell').map((c) => c.textContent)).toContain('—');
    expect(kpis().textContent).not.toContain('%');
  });

  it('có quyền nhưng máy chủ không gửi khoá ⇒ không thẻ (không đoán)', () => {
    view(ledger(), { canViewPercent: true, canViewBuildingTotals: true });
    expect(screen.queryByTestId('self-percent-card')).toBeNull();
    expect(screen.queryByTestId('self-building-totals-card')).toBeNull();
  });
});

describe('ShareholderLedgerSelfView — phiếu và tạm ứng', () => {
  it('chỉ phiếu TỰ LẬP còn chờ có "Huỷ yêu cầu"; bấm mở hộp huỷ đúng phiếu, đúng công ty', () => {
    view(ledger());
    const buttons = screen.getAllByRole('button', { name: 'Huỷ yêu cầu' });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    expect(screen.getByTestId('cancel-dialog')).toBeTruthy();
    expect(h.cancel).toHaveBeenLastCalledWith(expect.objectContaining({
      open: true,
      target: expect.objectContaining({ voucherId: 'v2', organizationId: 'org-a', kind: 'SHAREHOLDER', amount: 3_000_000, approvalStatus: 'UNAPPROVED' }),
    }));
  });

  it('không có quyền tạm ứng ⇒ không nút, không hộp', () => {
    view(ledger());
    expect(screen.queryByRole('button', { name: /Chi tạm ứng cho tôi/ })).toBeNull();
    expect(h.distribute).not.toHaveBeenCalled();
  });

  it('có quyền + sổ tổng chạy thật ⇒ nút mở hộp tạm ứng cho CHÍNH MÌNH đúng công ty', () => {
    view(ledger(), { canAdvanceOwn: true });
    fireEvent.click(screen.getByRole('button', { name: /Chi tạm ứng cho tôi/ }));
    expect(screen.getByTestId('advance-dialog')).toBeTruthy();
    expect(h.distribute).toHaveBeenLastCalledWith(expect.objectContaining({
      open: true, mode: 'SELF_ADVANCE', organizationId: 'org-a', me: { shareholderId: 'sh-1', name: 'Cổ đông 1' },
    }));
  });

  it.each(['SHADOW', 'FROZEN'] as const)('%s ⇒ nút khoá kèm câu giải thích', (route) => {
    view(ledger({ route }), { canAdvanceOwn: true });
    expect((screen.getByRole('button', { name: /Chi tạm ứng cho tôi/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('note').textContent).toMatch(/chưa/);
  });
});
