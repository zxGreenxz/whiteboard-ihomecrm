// @vitest-environment jsdom
// Tab "Của tôi" (điện thoại): dòng "tỷ lệ X%" của cổ đông CHỈ khi được cấp quyền xem tỷ lệ (màn sổ tổng);
// sổ tổng tắt ⇒ một câu, không số nào — thân cũ đọc bảng phân bổ đã gỡ ở Đợt 3 (D3.14).
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Shareholder } from '@/hooks/useShareholders';
import type { MyProfitLedger } from '@/lib/profitLedger/ledgerReaders';

const h = vi.hoisted(() => ({
  ledgerData: undefined as unknown,
  distribute: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock('@/hooks/profit-ledger/useProfitLedgerQueries', () => ({
  useMyProfitLedger: () => ({ data: h.ledgerData, error: null, isError: false, isFetching: false, refetch: vi.fn() }),
}));
vi.mock('@/components/shareholders/ProfitDistributeDialog', () => ({
  default: (props: Record<string, unknown>) => {
    h.distribute(props);
    return props.open ? createElement('div', { 'data-testid': 'advance-dialog' }) : null;
  },
}));
vi.mock('@/components/shareholders/ProfitPayoutCancelDialog', () => ({
  ProfitPayoutCancelDialog: (props: Record<string, unknown>) => {
    h.cancel(props);
    return null;
  },
}));

import ShareholderSelfMobile from '../ShareholderSelfMobile';
import { PROFIT_LEDGER_OFF_TEXT } from '../MyProfitLedgerGate';

const me = {
  id: 'sh-1', user_id: 'u-1', auth_user_id: 'auth-1', name: 'Cổ đông 1', note: null, is_active: true,
  created_at: '2026-01-01', updated_at: '2026-01-01', deleted_at: null, organization_id: 'org-a',
} as Shareholder;

const ledger = (over: Partial<MyProfitLedger> = {}): MyProfitLedger => ({
  organization_id: 'org-a', route: 'CANONICAL', ready: true, shareholder: { id: 'sh-1', name: 'Cổ đông 1' },
  balance: 5_000_000, status: 'OWED', allocated: 5_000_000, paid: 0, paid_pending: 0, paid_via_salary: 0, advance_recovered: 0,
  marker: null,
  months: [{ period_month: '2026-08-01', amount: 5_000_000, excluded_by_marker: false, buildings: [
    { building_id: 'b1', building_name: 'Toà Một', amount: 4_000_000 }, { building_id: 'b2', building_name: 'Toà Hai', amount: 1_000_000 },
  ] }],
  payouts: [], salary: [],
  ...over,
});

const view = (access: { canViewPercent?: boolean; canViewBuildingTotals?: boolean; canAdvanceOwn?: boolean } = {}) =>
  render(<ShareholderSelfMobile me={me} year={2026} onYearChange={vi.fn()}
    canViewPercent={access.canViewPercent ?? false}
    canViewBuildingTotals={access.canViewBuildingTotals ?? false}
    canAdvanceOwn={access.canAdvanceOwn ?? false} />);

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('ShareholderSelfMobile — sổ tổng tắt (ready=false)', () => {
  beforeEach(() => { h.ledgerData = ledger({ route: 'LEGACY', ready: false }); });

  it.each([false, true])('quyền xem tỷ lệ = %s ⇒ chỉ một câu báo tắt: không số, không tỷ lệ, không nút tạm ứng', (canViewPercent) => {
    view({ canViewPercent, canAdvanceOwn: true });
    expect(screen.getByRole('status').textContent).toBe(PROFIT_LEDGER_OFF_TEXT);
    expect(screen.queryByTestId('self-mobile-hero-sub')).toBeNull();
    expect(screen.queryByTestId('self-mobile-balance')).toBeNull();
    expect(screen.queryByRole('button', { name: /Chi tạm ứng cho tôi/ })).toBeNull();
    // Cả màn chỉ có đúng câu báo tắt: không số, không tỷ lệ, không số toà.
    expect(document.body.textContent).toBe(PROFIT_LEDGER_OFF_TEXT);
  });
});

describe('ShareholderSelfMobile — màn sổ tổng (ready)', () => {
  it('thiếu quyền ⇒ không tỷ lệ, không thẻ số toà', () => {
    h.ledgerData = ledger({
      percent_rows: [{ building_id: 'b1', building_name: 'Toà Một', percent: 20 }],
      building_totals: [{ period_month: '2026-08-01', building_id: 'b1', building_name: 'Toà Một', revenue: 90_000_000, expense: 30_000_000, profit: 60_000_000 }],
    });
    view();
    expect(screen.queryByText(PROFIT_LEDGER_OFF_TEXT)).toBeNull();
    expect(screen.getByTestId('self-mobile-hero-sub').textContent).toBe('Cổ đông · 2 toà nhà');
    expect(screen.queryByTestId('self-percent-card')).toBeNull();
    expect(screen.queryByTestId('self-building-totals-card')).toBeNull();
    expect(screen.getByTestId('self-mobile-balance').textContent).toMatch(/Còn được nhận/i);
  });

  it('có quyền + máy chủ gửi ⇒ tỷ lệ ở đầu thẻ và hai thẻ riêng', () => {
    h.ledgerData = ledger({
      percent_rows: [{ building_id: 'b1', building_name: 'Toà Một', percent: 20 }],
      building_totals: [{ period_month: '2026-08-01', building_id: 'b1', building_name: 'Toà Một', revenue: null, expense: 30_000_000, profit: 60_000_000 }],
    });
    view({ canViewPercent: true, canViewBuildingTotals: true });
    expect(screen.getByTestId('self-mobile-hero-sub').textContent).toBe('Cổ đông · tỷ lệ 20% · 2 toà nhà');
    expect(screen.getByTestId('self-percent-card').textContent).toContain('20%');
    expect(screen.getByTestId('self-building-totals-card').textContent).toMatch(/Thu — · Chi 30tr · LN 60tr/);
  });

  it('ngày phiếu dd/MM/yyyy (định dạng trên chuỗi date, không hiện ISO)', () => {
    h.ledgerData = ledger({
      payouts: [{ voucher_id: 'v1', voucher_code: 'PC-1', voucher_date: '2026-11-15', amount: 1_000_000, status: 'APPROVED', posting_status: 'POSTED', is_advance: false, is_mine: false, is_mine_pending: false, excluded_by_marker: false }],
    });
    view();
    expect(document.body.textContent).toContain('15/11/2026');
    expect(document.body.textContent).not.toContain('2026-11-15');
  });

  it('nút tạm ứng theo quyền: CANONICAL mở hộp cho chính mình (sổ tổng tắt không có nút — xem trên)', () => {
    h.ledgerData = ledger();
    view({ canAdvanceOwn: true });
    fireEvent.click(screen.getByRole('button', { name: /Chi tạm ứng cho tôi/ }));
    expect(screen.getByTestId('advance-dialog')).toBeTruthy();
    expect(h.distribute).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'SELF_ADVANCE', organizationId: 'org-a' }));
  });
});
