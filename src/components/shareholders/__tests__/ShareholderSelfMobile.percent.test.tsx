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
  /** Vị thế của chính mình (R2): dữ liệu, 'pending', hoặc lỗi đọc. */
  position: 'pending' as unknown,
  distribute: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock('@/hooks/profit-ledger/useProfitLedgerQueries', () => ({
  useMyProfitLedger: () => ({ data: h.ledgerData, error: null, isError: false, isFetching: false, refetch: vi.fn() }),
  useMyShareholderPosition: () => {
    if (h.position === 'pending') return { data: undefined, isError: false, error: null, refetch: vi.fn() };
    if (h.position && typeof h.position === 'object' && 'code' in h.position) return { data: undefined, isError: true, error: h.position, refetch: vi.fn() };
    return { data: h.position, isError: false, error: null, refetch: vi.fn() };
  },
}));
vi.mock('@/components/shareholders/ProfitSelfAdvanceDialog', () => ({
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

/** Vị thế của chính mình (R2): chưa chi 5.000.000, tạm ứng đã duyệt 1.200.000, còn 300.000 chờ duyệt. */
const myPosition = (over: Record<string, unknown> = {}) => ({
  organization_id: 'org-a', route: 'CANONICAL', shareholder: { id: 'sh-1', name: 'Cổ đông 1' },
  unpaid_profit: 5_000_000, advance_outstanding: 1_200_000, advance_pending: 300_000, settlement_cash_pending: 0, balance: 3_500_000,
  settled: { recognized: 0, offset: 0, cash: 0 }, last_settled_through_month: null, marker_month: null,
  needs_review: { count: 0, suggested: 0 },
  components: { allocated: 5_000_000, payouts_pending: 300_000, payouts_approved: 1_200_000, salary_investment: 0, salary_advance_offset: 0, unpaid_profit_raw: 5_000_000, advance_outstanding_raw: 1_200_000, advance_overoffset: 0 },
  settlements: [], ...over,
});

beforeEach(() => { vi.clearAllMocks(); h.position = myPosition(); });
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
    // Đầu thẻ: HAI số của vị thế, không còn "Còn được nhận".
    const balance = screen.getByTestId('self-mobile-balance').textContent ?? '';
    expect(balance).toMatch(/Lợi nhuận chưa chi5tr/);
    expect(balance).toMatch(/Tạm ứng đang có: 1,2tr.*chờ duyệt 300k/);
    expect(balance).not.toMatch(/Còn được nhận|Đang tạm ứng/);
  });

  it('các lần chốt chi hiện thành thẻ; vị thế đang tải / lỗi ⇒ "…" / "—", không hiện 0', () => {
    h.ledgerData = ledger();
    h.position = myPosition({ unpaid_profit: -400_000, advance_outstanding: 0, advance_pending: 0, balance: -400_000,
      components: { ...myPosition().components, unpaid_profit_raw: -400_000, advance_outstanding_raw: 0 },
      settlements: [{ id: 'st-1', through_month: '2026-10-01', recognized_amount: 2_000_000, advance_offset_amount: 500_000, cash_amount: 1_500_000,
        cash_voucher_id: 'v-cash', cash_voucher_code: 'PC-CHOT', cash_voucher_status: 'APPROVED', cash_voucher_posting_status: 'POSTED',
        created_at: '2026-11-18T10:00:00+07:00', excluded_by_marker: false }] });
    const first = view();
    expect(screen.getByTestId('self-settlement-st-1').textContent).toMatch(/Đến hết 10\/2026.*1,5tr.*Ghi nhận 2tr · khấu trừ tạm ứng 500k.*Đã chi tiền · PC-CHOT/);
    // Lợi nhuận chưa chi ÂM: hiện đúng dấu + một dòng giải thích.
    expect(screen.getByTestId('self-mobile-balance').textContent).toMatch(/-400k/);
    expect(screen.getByRole('note').textContent).toMatch(/Lợi nhuận chưa chi âm/);
    first.unmount();
    h.position = 'pending';
    const pending = view();
    expect(screen.getByTestId('self-mobile-balance').textContent).toBe('Lợi nhuận chưa chi…Tạm ứng đang có: …');
    expect(screen.queryByTestId('self-settlements-card')).toBeNull();
    pending.unmount();
    h.position = { code: 'XX000', message: 'PROFIT_LEDGER_POSITION_DRIFT: lệch' };
    view();
    expect(screen.getByTestId('self-mobile-balance').textContent).toBe('Lợi nhuận chưa chi—Tạm ứng đang có: —');
    expect(screen.getByTestId('self-position-error').textContent).toMatch(/Chưa tải được lợi nhuận chưa chi và tạm ứng của bạn/);
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
    expect(h.distribute).toHaveBeenLastCalledWith(expect.objectContaining({ open: true, organizationId: 'org-a', me: { shareholderId: 'sh-1', name: 'Cổ đông 1' } }));
  });
});
