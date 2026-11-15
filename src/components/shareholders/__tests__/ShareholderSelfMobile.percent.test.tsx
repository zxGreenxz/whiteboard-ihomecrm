// @vitest-environment jsdom
// Tab "Của tôi" (điện thoại): dòng "tỷ lệ X%" của cổ đông CHỈ khi được cấp quyền xem tỷ lệ — ở cả thân cũ
// (công tắc sổ tổng tắt) lẫn màn sổ tổng; màn sổ tổng không đọc bảng phân bổ cũ.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Shareholder } from '@/hooks/useShareholders';
import type { MyProfitLedger } from '@/lib/profitLedger/ledgerReaders';

const h = vi.hoisted(() => ({
  ledgerData: undefined as unknown,
  allocations: vi.fn(),
  distribute: vi.fn(),
  cancel: vi.fn(),
}));

const okQuery = (data: unknown) => ({
  data, status: 'success' as const, fetchStatus: 'idle' as const, isLoading: false, isError: false, error: null, refetch: vi.fn(),
});

vi.mock('@/hooks/profit-ledger/useProfitLedgerQueries', () => ({
  useMyProfitLedger: () => ({ data: h.ledgerData, error: null, isError: false, isFetching: false, refetch: vi.fn() }),
}));
vi.mock('@/hooks/useShareholderProfit', () => ({
  useProfitAllocations: () => {
    h.allocations();
    return okQuery([
      { id: 'a1', shareholder_id: 'sh-1', building_id: 'b1', period_month: '2026-08-01', amount: 4_000_000, percent: 20 },
      { id: 'a2', shareholder_id: 'sh-1', building_id: 'b2', period_month: '2026-08-01', amount: 1_000_000, percent: 20 },
    ]);
  },
  useShareholderDistributions: () => okQuery([]),
  computeShareholderSummary: () => ({ 'sh-1': { accrued: 5_000_000, paid: 0, remaining: 5_000_000 } }),
}));
vi.mock('@/hooks/useShareholders', () => ({
  useMyShareBuildings: () => okQuery([{ id: 'b1', name: 'Toà Một' }, { id: 'b2', name: 'Toà Hai' }]),
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

describe('ShareholderSelfMobile — thân cũ (công tắc tắt)', () => {
  beforeEach(() => { h.ledgerData = ledger({ route: 'LEGACY', ready: false }); });

  it('thiếu quyền xem tỷ lệ ⇒ không "tỷ lệ X%" dù bảng phân bổ mang %', () => {
    view();
    expect(h.allocations).toHaveBeenCalled();
    expect(document.body.textContent).toContain('Cổ đông · 2 toà nhà');
    expect(document.body.textContent).not.toMatch(/tỷ lệ/);
  });

  it('được cấp quyền xem tỷ lệ ⇒ "tỷ lệ 20%" như trước', () => {
    view({ canViewPercent: true });
    expect(document.body.textContent).toContain('Cổ đông · tỷ lệ 20% · 2 toà nhà');
  });
});

describe('ShareholderSelfMobile — màn sổ tổng (ready)', () => {
  it('không đọc bảng phân bổ cũ; thiếu quyền ⇒ không tỷ lệ, không thẻ số toà', () => {
    h.ledgerData = ledger({
      percent_rows: [{ building_id: 'b1', building_name: 'Toà Một', percent: 20 }],
      building_totals: [{ period_month: '2026-08-01', building_id: 'b1', building_name: 'Toà Một', revenue: 90_000_000, expense: 30_000_000, profit: 60_000_000 }],
    });
    view();
    expect(h.allocations).not.toHaveBeenCalled();
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

  it('nút tạm ứng theo quyền: CANONICAL mở hộp cho chính mình; LEGACY không tới đây (thân cũ)', () => {
    h.ledgerData = ledger();
    view({ canAdvanceOwn: true });
    fireEvent.click(screen.getByRole('button', { name: /Chi tạm ứng cho tôi/ }));
    expect(screen.getByTestId('advance-dialog')).toBeTruthy();
    expect(h.distribute).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'SELF_ADVANCE', organizationId: 'org-a' }));
  });
});
