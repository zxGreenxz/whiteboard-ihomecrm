// @vitest-environment jsdom
// Tổng quan của chủ trên điện thoại (D2.6): mỗi cổ đông một thẻ đọc sổ tổng E1 (chữ trạng thái, số dư,
// dòng tóm tắt), nút Chi khoá theo trạng thái sổ tổng, bấm thẻ mở sổ chi tiết từ dưới lên, % chỉ khi
// được cấp quyền xem tỷ lệ. Dữ liệu GIẢ.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  route: 'LEGACY' as string,
  perms: { shareholder_profit: { distribute: true, pay_manager: true } } as Record<string, unknown>,
  sheet: [] as { open: boolean; compact?: boolean; shareholder: { name: string } | null }[],
  managerVariant: [] as string[],
}));
const ok = (data: unknown) => ({ data, status: 'success', fetchStatus: 'idle', isLoading: false, isError: false, error: null, refetch: vi.fn() });

vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org-a' }) }));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: m.perms }) }));
vi.mock('@/hooks/useShareholders', () => ({ useShareholders: () => ok([{ id: 's1', name: 'An' }, { id: 's2', name: 'Bình' }]) }));
vi.mock('@/hooks/useBuildings', () => ({ useBuildings: () => ok([{ id: 'b1', name: 'Toà A' }]) }));
vi.mock('@/hooks/useProfitOverviewCoverage', () => ({ useProfitOverviewCoverage: () => ({ coverage: null, today: '2026-11-15' }) }));
vi.mock('../ProfitCoverageCard', () => ({ ProfitCoverageMobile: () => null }));
vi.mock('@/hooks/useShareholderProfit', () => ({
  useProfitMonthly: () => ok([]),
  useProfitAllocations: () => ok([{ shareholder_id: 's1', building_id: 'b1', period_month: '2026-09-01', amount: 7_000, percent: 50 }]),
  useShareholderDistributions: () => ok([{ shareholder_id: 's1', total_amount: 3_000 }]),
}));
vi.mock('@/hooks/profit-ledger/useProfitLedgerQueries', () => ({
  useShareholderProfitLedger: (org: string | null) => ok({ organization_id: org, route: m.route, as_of: '2026-11-15T00:00:00Z', shareholders: ROWS }),
}));
vi.mock('../ProfitDistributeDialog', () => ({
  default: (p: { open: boolean; defaultShareholderId?: string | null }) => (p.open ? <div data-testid="dist-dialog">{String(p.defaultShareholderId)}</div> : null),
}));
vi.mock('../ShareholderLedgerSheet', () => ({
  ShareholderLedgerSheet: (p: { open: boolean; compact?: boolean; shareholder: { name: string } | null }) => {
    m.sheet.push(p);
    return p.open ? <div data-testid="ledger-sheet">{p.shareholder?.name}</div> : null;
  },
}));
vi.mock('../ManagerLedgerSection', () => ({
  ManagerLedgerSection: (p: { variant: string }) => { m.managerVariant.push(p.variant); return <div data-testid="manager-section" />; },
}));

const base = { is_active: true, is_deleted: false, has_login: true, marker: null, salary_investment: 0, salary_advance_offset: 0, needs_review_count: 0 };
const ROWS = [
  { ...base, shareholder_id: 's1', name: 'An', allocated: 1_000_000, payouts_approved: 300_000, payouts_pending: 100_000, salary_investment: 150_000, salary_advance_offset: 50_000, balance: 500_000, status: 'OWED', open_advance: 0 },
  { ...base, shareholder_id: 's2', name: 'Bình', allocated: 100_000, payouts_approved: 300_000, payouts_pending: 0, balance: -200_000, status: 'ADVANCE', open_advance: 200_000, needs_review_count: 1 },
];

import ProfitOverviewMobile from '../ProfitOverviewMobile';

const cardOf = (id: string) => screen.getByTestId(`ledger-card-${id}`);
const chiOf = (id: string) => within(cardOf(id)).queryByRole('button', { name: 'Chi' }) as HTMLButtonElement | null;
const renderMobile = () => render(<ProfitOverviewMobile year={2026} onYearChange={vi.fn()} />);

beforeEach(() => {
  m.route = 'LEGACY';
  m.perms = { shareholder_profit: { distribute: true, pay_manager: true } };
  m.sheet = [];
  m.managerVariant = [];
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Tổng quan chủ — điện thoại', () => {
  it('thẻ cổ đông: chữ trạng thái, số dư, dòng tóm tắt; cần xem lại có chip', () => {
    m.route = 'CANONICAL';
    renderMobile();
    const an = cardOf('s1');
    expect(within(an).getByText('Còn phải trả')).toBeTruthy();
    expect(an.textContent).toMatch(/500k/);
    expect(an.textContent).toMatch(/Chia sau mốc 1tr · Đã chi 300k · Chờ duyệt 100k · Qua lương 100k/);
    const binh = cardOf('s2');
    expect(within(binh).getByText('Đang tạm ứng')).toBeTruthy();
    expect(within(binh).getByText('cần xem lại (1)')).toBeTruthy();
    expect(binh.textContent).toMatch(/200k/);
    expect(binh.textContent).toMatch(/tạm ứng/);
    expect(m.managerVariant).toContain('mobile');
  });

  it('LEGACY: banner thay dòng cũ, thẻ ghi "xem thử", mọi nút Chi khoá; KPI giữ cách cũ', () => {
    renderMobile();
    expect(screen.getByTestId('profit-ledger-route-banner').textContent).toMatch(/Sổ tổng đang xem thử/);
    expect(within(screen.getByTestId('shareholder-ledger-card')).getByText('xem thử')).toBeTruthy();
    expect(chiOf('s1')!.disabled).toBe(true);
    expect(screen.getByTestId('kpi-paid').textContent).toMatch(/Đã ứng \/ đã chia/);
    expect(document.body.textContent).not.toMatch(/qua app đang tắt/);
  });

  it('CANONICAL: Chi mở được cho cổ đông không vướng; còn phiếu lương cần xem lại thì khoá', () => {
    m.route = 'CANONICAL';
    renderMobile();
    expect(chiOf('s1')!.disabled).toBe(false);
    expect(chiOf('s2')!.disabled).toBe(true);
    fireEvent.click(chiOf('s1')!);
    expect(screen.getByTestId('dist-dialog').textContent).toBe('s1');
    expect(screen.getByTestId('kpi-paid').textContent).toMatch(/Đã chi \(đã duyệt\)/);
  });

  it('bấm thẻ mở sổ chi tiết từ dưới lên (chế độ điện thoại)', () => {
    renderMobile();
    fireEvent.click(within(cardOf('s2')).getByText('Bình'));
    expect(screen.getByTestId('ledger-sheet').textContent).toBe('Bình');
    expect(m.sheet.at(-1)?.compact).toBe(true);
  });

  it('không có quyền xem tỷ lệ ⇒ không hiện "%" trên thẻ; có quyền ⇒ hiện', () => {
    renderMobile();
    expect(cardOf('s1').textContent).not.toMatch(/%/);
    cleanup();
    m.perms = { shareholder_profit: { distribute: true, view_percent: true } };
    renderMobile();
    expect(cardOf('s1').textContent).toMatch(/50%/);
  });
});
