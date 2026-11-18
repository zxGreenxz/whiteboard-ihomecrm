// @vitest-environment jsdom
// Tổng quan của chủ trên điện thoại (D2.6): mỗi cổ đông một thẻ đọc sổ tổng E1 (chữ trạng thái, số dư,
// dòng tóm tắt), nút Chi khoá theo trạng thái sổ tổng, bấm thẻ mở sổ chi tiết từ dưới lên, % chỉ khi
// được cấp quyền xem tỷ lệ. Dữ liệu GIẢ.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  route: 'LEGACY' as string,
  /** Vị thế (R1): 'ok' | 'pending' | lỗi đọc. */
  positions: 'ok' as 'ok' | 'pending' | { code: string; message: string },
  /** Dòng R1 thêm mà E1 không liệt kê (cổ đông đã xoá còn số theo con số riêng của R1). */
  extraPositions: [] as Record<string, unknown>[],
  perms: { shareholder_profit: { distribute: true, pay_manager: true } } as Record<string, unknown>,
  sheet: [] as { open: boolean; compact?: boolean; shareholder: { name: string } | null }[],
  managerVariant: [] as string[],
  distProps: [] as Record<string, unknown>[],
  me: null as Record<string, unknown> | null,
  selfAdvanceProps: [] as Record<string, unknown>[],
}));
const ok = (data: unknown) => ({ data, status: 'success', fetchStatus: 'idle', isLoading: false, isError: false, error: null, refetch: vi.fn() });

vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org-a' }) }));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: m.perms }) }));
vi.mock('@/hooks/useShareholders', () => ({
  useShareholders: () => ok([{ id: 's1', name: 'An' }, { id: 's2', name: 'Bình' }]),
  useMyShareholder: () => ok(m.me),
}));
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
  useShareholderProfitPositions: (org: string | null) => {
    if (m.positions === 'pending') return { data: undefined, status: 'pending', fetchStatus: 'fetching', isLoading: true, isError: false, error: null, refetch: vi.fn() };
    if (m.positions !== 'ok') return { data: undefined, status: 'error', fetchStatus: 'idle', isLoading: false, isError: true, error: m.positions, refetch: vi.fn() };
    return ok({ organization_id: org, route: m.route, as_of: '2026-11-18T00:00:00Z', shareholders: [...POSITIONS, ...m.extraPositions] });
  },
}));
vi.mock('../ProfitDistributeDialog', () => ({
  default: (p: { open: boolean; defaultShareholderId?: string | null }) => {
    m.distProps.push(p);
    return p.open ? <div data-testid="dist-dialog">{String(p.defaultShareholderId)}</div> : null;
  },
}));
vi.mock('../ProfitLedgerMarkerDialog', () => ({
  ProfitLedgerMarkerDialog: (p: { open: boolean; subject: { name: string; lastSettledThroughMonth?: string | null } | null }) =>
    (p.open ? <div data-testid="marker-dialog">{p.subject?.name}</div> : null),
}));
vi.mock('../ProfitSelfAdvanceDialog', () => ({
  default: (p: Record<string, unknown>) => {
    m.selfAdvanceProps.push(p);
    return p.open ? <div data-testid="self-advance-dialog">{JSON.stringify(p.me)}</div> : null;
  },
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

// Vị thế (R1): lợi nhuận chưa chi − tạm ứng đang có − tạm ứng chờ duyệt = số dư ròng.
const position = (over: Record<string, unknown>) => ({
  is_active: true, is_deleted: false, has_login: true, has_advance_right: false, settlement_cash_pending: 0,
  settled: { recognized: 0, offset: 0, cash: 0 }, last_settled_through_month: null, marker_month: null,
  needs_review: { count: 0, suggested: 0 },
  components: { allocated: 0, payouts_pending: 0, payouts_approved: 0, salary_investment: 0, salary_advance_offset: 0, unpaid_profit_raw: 0, advance_outstanding_raw: 0, advance_overoffset: 0 },
  ...over,
});
const POSITIONS = [
  position({ shareholder_id: 's1', name: 'An', unpaid_profit: 900_000, advance_outstanding: 300_000, advance_pending: 100_000, settlement_cash_pending: 250_000, balance: 500_000 }),
  position({ shareholder_id: 's2', name: 'Bình', unpaid_profit: -200_000, advance_outstanding: 0, advance_pending: 0, balance: -200_000 }),
];

import ProfitOverviewMobile from '../ProfitOverviewMobile';

const cardOf = (id: string) => screen.getByTestId(`ledger-card-${id}`);
const chiOf = (id: string) => within(cardOf(id)).queryByRole('button', { name: 'Chi' }) as HTMLButtonElement | null;
const renderMobile = () => render(<ProfitOverviewMobile year={2026} onYearChange={vi.fn()} />);

beforeEach(() => {
  m.route = 'LEGACY';
  m.positions = 'ok';
  m.extraPositions = [];
  m.perms = { shareholder_profit: { distribute: true, pay_manager: true } };
  m.sheet = [];
  m.managerVariant = [];
  m.distProps = [];
  m.me = null;
  m.selfAdvanceProps = [];
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Tổng quan chủ — điện thoại', () => {
  it('thẻ cổ đông: HAI số (lợi nhuận chưa chi, tạm ứng đang có), dòng tóm tắt; cần xem lại có chip', () => {
    m.route = 'CANONICAL';
    renderMobile();
    const an = cardOf('s1');
    expect(within(an).queryByText('Còn phải trả')).toBeNull();
    expect(screen.getByTestId('ledger-position-s1').textContent).toBe('900kchưa chi300ktạm ứng');
    expect(within(an).getByText('tạm ứng chờ duyệt 100k')).toBeTruthy();
    expect(within(an).getByText('đang chờ chi 250k')).toBeTruthy();
    expect(an.textContent).toMatch(/Chia sau mốc 1tr · Đã chi 300k · Chờ duyệt 100k · Qua lương 100k/);
    const binh = cardOf('s2');
    expect(within(binh).queryByText('Đang tạm ứng')).toBeNull();
    expect(within(binh).getByText('cần xem lại (1)')).toBeTruthy();
    // Lợi nhuận chưa chi ÂM vẫn hiện đúng dấu, kèm một dòng giải thích dưới danh sách.
    expect(screen.getByTestId('ledger-position-s2').textContent).toBe('-200kchưa chi0đtạm ứng');
    expect(screen.getByTestId('ledger-position-note').textContent).toMatch(/Lợi nhuận chưa chi âm/);
    expect(m.managerVariant).toContain('mobile');
  });

  it('số đầu trang: lợi nhuận chưa chi và tạm ứng đang có đọc vị thế; chưa đọc được thì không hiện 0', () => {
    m.route = 'CANONICAL';
    const view = renderMobile();
    expect(screen.getByTestId('kpi-remaining').textContent).toMatch(/Lợi nhuận chưa chi700kđang chờ chi 250k/);
    expect(screen.getByTestId('kpi-advance').textContent).toMatch(/Tạm ứng đang có300kchờ duyệt 100k/);
    view.unmount();
    m.positions = 'pending';
    const pending = renderMobile();
    expect(screen.getByTestId('ledger-position-s1').textContent).toBe('…chưa chi…tạm ứng');
    expect(screen.getByTestId('kpi-advance').textContent).not.toMatch(/\d/);
    pending.unmount();
    m.positions = { code: 'XX000', message: 'PROFIT_LEDGER_POSITION_DRIFT: lệch' };
    renderMobile();
    expect(screen.getByTestId('ledger-position-s1').textContent).toBe('—chưa chi—tạm ứng');
    expect(screen.getByTestId('kpi-remaining').textContent).toMatch(/—Chưa tải được/);
    expect(within(screen.getByTestId('shareholder-ledger-card')).getByRole('alert').textContent).toMatch(/không cộng ra đúng số dư sổ tổng/);
    expect(chiOf('s1')!.disabled).toBe(false);
  });

  it('LEGACY: banner thay dòng cũ, thẻ ghi "xem thử", mọi nút Chi khoá; KPI giữ cách cũ', () => {
    renderMobile();
    expect(screen.getByTestId('profit-ledger-route-banner').textContent).toMatch(/Sổ tổng đang xem thử/);
    expect(within(screen.getByTestId('shareholder-ledger-card')).getByText('xem thử')).toBeTruthy();
    expect(chiOf('s1')!.disabled).toBe(true);
    expect(screen.getByTestId('kpi-paid').textContent).toMatch(/Đã ứng \/ đã chia/);
    // Ô "được chia" cùng cách tính cũ (phân bổ cộng dồn 7.000), không lẫn số sổ tổng.
    expect(screen.getByTestId('kpi-allocated').textContent).toMatch(/Tổng được chia cổ đông/);
    expect(screen.getByTestId('kpi-allocated').textContent).toMatch(/7k/);
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
    // Sổ tổng chạy: ô "được chia" đọc Σ allocated của E1 (1.000.000 + 100.000), cùng gốc hai ô kia.
    expect(screen.getByTestId('kpi-allocated').textContent).toMatch(/Được chia \(sau mốc\)/);
    expect(screen.getByTestId('kpi-allocated').textContent).toMatch(/1,1tr/);
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

  // R4: số đầu trang cộng đúng các thẻ đang hiện (dòng E1), như dòng Tổng của bảng máy tính.
  it('số đầu trang không cộng dòng chỉ có ở R1 (cổ đông đã xoá còn số mà sổ tổng không liệt kê)', () => {
    m.route = 'CANONICAL';
    m.extraPositions = [position({
      shareholder_id: 'r1-only', name: 'Chỉ có ở R1', is_deleted: true, unpaid_profit: 1_000_000, advance_outstanding: 70_000,
      advance_pending: 0, balance: 930_000,
    })];
    renderMobile();
    expect(screen.queryByTestId('ledger-card-r1-only')).toBeNull();
    expect(screen.getByTestId('kpi-remaining').textContent).toMatch(/Lợi nhuận chưa chi700k/);
    expect(screen.getByTestId('kpi-advance').textContent).toMatch(/Tạm ứng đang có300k/);
  });

  // U4: hộp đặt mốc dùng được ở điện thoại ⇒ lối mở từ thẻ cổ đông và từ lời nhắc trong hộp chốt.
  it('đặt mốc trên điện thoại: nút Mốc ở thẻ cổ đông, và lời nhắc của hộp chốt mở đúng hộp mốc', () => {
    m.route = 'SHADOW';
    renderMobile();
    const marker = within(cardOf('s2')).getByRole('button', { name: 'Mốc' }) as HTMLButtonElement;
    expect(marker.disabled).toBe(false);
    fireEvent.click(marker);
    expect(screen.getByTestId('marker-dialog').textContent).toBe('Bình');
    cleanup();
    m.route = 'CANONICAL';
    m.distProps = [];
    renderMobile();
    fireEvent.click(chiOf('s1')!);
    const last = m.distProps.at(-1)!;
    expect(typeof last.onSetMarker).toBe('function');
    act(() => { (last.onSetMarker as (id: string) => void)('s1'); });
    expect(screen.getByTestId('marker-dialog').textContent).toBe('An');
    expect(screen.queryByTestId('dist-dialog')).toBeNull();
  });

  it('sổ tổng chưa mở phần đặt mốc ⇒ nút Mốc khoá, hộp chốt không có lối đặt mốc; không có quyền chi ⇒ không nút Mốc', () => {
    m.route = 'FROZEN';
    renderMobile();
    expect((within(cardOf('s1')).getByRole('button', { name: 'Mốc' }) as HTMLButtonElement).disabled).toBe(true);
    expect(m.distProps.at(-1)?.onSetMarker).toBeUndefined();
    cleanup();
    m.perms = { shareholder_profit: { lock: true } };
    renderMobile();
    expect(within(cardOf('s1')).queryByRole('button', { name: 'Mốc' })).toBeNull();
  });

  // R3: chủ đồng thời là cổ đông có quyền tạm ứng.
  it('chủ là cổ đông của công ty + có quyền tạm ứng ⇒ nút "Chi tạm ứng cho tôi" mở hộp tự tạm ứng; không thì không có nút', () => {
    m.route = 'CANONICAL';
    m.me = { id: 's1', name: 'An', organization_id: 'org-a' };
    m.perms = { shareholder_profit: { distribute: true, advance_own_cashbook: true } };
    renderMobile();
    fireEvent.click(screen.getByRole('button', { name: /Chi tạm ứng cho tôi/ }));
    expect(screen.getByTestId('self-advance-dialog').textContent).toBe(JSON.stringify({ shareholderId: 's1', name: 'An' }));
    expect(m.selfAdvanceProps.at(-1)).toMatchObject({ open: true, organizationId: 'org-a' });
    cleanup();
    m.selfAdvanceProps = [];
    m.me = { id: 's9', name: 'Khác', organization_id: 'org-b' };
    renderMobile();
    expect(screen.queryByRole('button', { name: /Chi tạm ứng cho tôi/ })).toBeNull();
    expect(m.selfAdvanceProps).toEqual([]);
  });
});
