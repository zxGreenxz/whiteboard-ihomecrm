// @vitest-environment jsdom
// Tổng quan của chủ (máy tính) đọc sổ tổng E1 (D2.4): bảng sổ tổng, nút Chi theo trạng thái sổ tổng,
// banner thay ghi chú cũ "chi qua app đang tắt", số đầu trang LEGACY giữ cách cũ. Từ 18/11/2026 mỗi cổ đông
// có HAI số đọc vị thế (R1): "Lợi nhuận chưa chi" và "Tạm ứng đang có". Dữ liệu GIẢ.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  route: 'LEGACY' as string,
  ledgerError: null as unknown,
  /** Vị thế (R1): 'ok' | 'pending' | lỗi đọc. */
  positions: 'ok' as 'ok' | 'pending' | { code: string; message: string },
  /** Dòng R1 thêm mà E1 không liệt kê (cổ đông đã xoá còn số theo con số riêng của R1). */
  extraPositions: [] as Record<string, unknown>[],
  /** Cổ đông của E1 mà R1 không trả vị thế. */
  dropPositions: [] as string[],
  positionCalls: [] as { org: string | null; enabled: boolean | undefined }[],
  perms: { shareholder_profit: { distribute: true, pay_manager: true } } as Record<string, unknown>,
  distProps: [] as Record<string, unknown>[],
  /** Dòng cổ đông của chính người đang xem (useMyShareholder); null = không phải cổ đông. */
  me: null as Record<string, unknown> | null,
  selfAdvanceProps: [] as Record<string, unknown>[],
}));
const ok = (data: unknown) => ({ data, status: 'success', fetchStatus: 'idle', isLoading: false, isError: false, error: null, refetch: vi.fn() });

vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org-a' }) }));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: m.perms }) }));
vi.mock('@/pages/reports/finance/ProfitHubShell', () => ({
  ProfitHubSlot: ({ children }: { children?: ReactNode }) => <div data-testid="kpis">{children}</div>,
}));
vi.mock('@/hooks/useShareholders', () => ({
  useShareholders: () => ok([{ id: 's1', name: 'An' }, { id: 's2', name: 'Bình' }]),
  useMyShareholder: () => ok(m.me),
}));
vi.mock('@/hooks/useBuildings', () => ({ useBuildings: () => ok([]) }));
vi.mock('@/hooks/useProfitOverviewCoverage', () => ({ useProfitOverviewCoverage: () => ({ coverage: null, today: '2026-11-15' }) }));
vi.mock('../ProfitCoverageCard', () => ({ ProfitCoverageCard: () => null }));
vi.mock('@/hooks/useShareholderProfit', async () => {
  const lib = await vi.importActual<typeof import('@/lib/shareholderProfit')>('@/lib/shareholderProfit');
  return {
    computeShareholderSummary: lib.computeShareholderSummary,
    useProfitMonthly: () => ok([]),
    useProfitAllocations: () => ok([{ shareholder_id: 's1', building_id: 'b1', period_month: '2026-09-01', amount: 7_000, percent: 50 }]),
    // Cách tính cũ: đã ứng 3.000 ⇒ còn phải trả 4.000 (khác hẳn số sổ tổng bên dưới).
    useShareholderDistributions: () => ok([{ shareholder_id: 's1', total_amount: 3_000 }]),
  };
});
vi.mock('@/hooks/profit-ledger/useProfitLedgerQueries', () => ({
  useShareholderProfitLedger: (org: string | null) => (m.ledgerError
    ? { data: undefined, status: 'error', fetchStatus: 'idle', isLoading: false, isError: true, error: m.ledgerError, refetch: vi.fn() }
    : ok({ organization_id: org, route: m.route, as_of: '2026-11-15T00:00:00Z', shareholders: ROWS })),
  useShareholderProfitPositions: (org: string | null, options?: { enabled?: boolean }) => {
    m.positionCalls.push({ org, enabled: options?.enabled });
    if (options?.enabled === false || m.positions === 'pending') return { data: undefined, status: 'pending', fetchStatus: 'idle', isLoading: true, isError: false, error: null, refetch: vi.fn() };
    if (m.positions !== 'ok') return { data: undefined, status: 'error', fetchStatus: 'idle', isLoading: false, isError: true, error: m.positions, refetch: vi.fn() };
    const shareholders = [
      ...POSITIONS.filter((p) => !m.dropPositions.includes(String((p as Record<string, unknown>).shareholder_id))),
      ...m.extraPositions,
    ];
    return ok({ organization_id: org, route: m.route, as_of: '2026-11-18T00:00:00Z', shareholders });
  },
}));
vi.mock('../ProfitSelfAdvanceDialog', () => ({
  default: (props: Record<string, unknown>) => {
    m.selfAdvanceProps.push(props);
    return props.open ? <div data-testid="self-advance-dialog">{JSON.stringify(props.me)}</div> : null;
  },
}));
vi.mock('../ProfitDistributeDialog', () => ({
  default: (props: Record<string, unknown>) => {
    m.distProps.push(props);
    return props.open ? <div data-testid="dist-dialog">{String(props.defaultShareholderId)}</div> : null;
  },
}));
vi.mock('../ShareholderLedgerSheet', () => ({
  ShareholderLedgerSheet: (props: { open: boolean; shareholder: { name: string } | null }) =>
    props.open ? <div data-testid="ledger-sheet">{props.shareholder?.name}</div> : null,
}));
vi.mock('../ProfitLedgerMarkerDialog', () => ({
  ProfitLedgerMarkerDialog: (props: { open: boolean; subject: { name: string } | null }) =>
    props.open ? <div data-testid="marker-dialog">{props.subject?.name}</div> : null,
}));
vi.mock('../ManagerLedgerSection', () => ({ ManagerLedgerSection: () => <div data-testid="manager-section" /> }));

const base = { is_active: true, is_deleted: false, has_login: true, marker: null, salary_investment: 0, salary_advance_offset: 0, needs_review_count: 0 };
const ROWS = [
  // 1.000.000 − 300.000 − 100.000 − (150.000 − 50.000) = 500.000
  { ...base, shareholder_id: 's1', name: 'An', allocated: 1_000_000, payouts_approved: 300_000, payouts_pending: 100_000, salary_investment: 150_000, salary_advance_offset: 50_000, balance: 500_000, status: 'OWED', open_advance: 0 },
  { ...base, shareholder_id: 's2', name: 'Bình', marker: { id: 'mk1', settled_through_month: '2026-09-01', ledger_seq: 3 }, allocated: 100_000, payouts_approved: 300_000, payouts_pending: 0, balance: -200_000, status: 'ADVANCE', open_advance: 200_000, needs_review_count: 1 },
  { ...base, shareholder_id: 'gone', name: 'Cũ', is_deleted: true, has_login: false, allocated: 50_000, payouts_approved: 0, payouts_pending: 0, balance: 50_000, status: 'OWED', open_advance: 0 },
];

// Vị thế (R1) của đúng ba cổ đông trên: lợi nhuận chưa chi − tạm ứng đang có − tạm ứng chờ duyệt = số dư ròng.
const position = (over: Record<string, unknown>) => ({
  is_active: true, is_deleted: false, has_login: true, has_advance_right: false, settlement_cash_pending: 0,
  settled: { recognized: 0, offset: 0, cash: 0 }, last_settled_through_month: null, marker_month: null,
  needs_review: { count: 0, suggested: 0 },
  components: { allocated: 0, payouts_pending: 0, payouts_approved: 0, salary_investment: 0, salary_advance_offset: 0, unpaid_profit_raw: 0, advance_outstanding_raw: 0, advance_overoffset: 0 },
  ...over,
});
const POSITIONS = [
  // An: chưa chi 900.000 (trong đó 250.000 đang chờ chi theo một lần chốt), tạm ứng 300.000 + chờ duyệt 100.000.
  position({ shareholder_id: 's1', name: 'An', has_advance_right: true, unpaid_profit: 900_000, advance_outstanding: 300_000, advance_pending: 100_000, settlement_cash_pending: 250_000, balance: 500_000 }),
  // Bình: lợi nhuận chưa chi ÂM (đã chi nhiều hơn phần được chia), không tạm ứng.
  position({ shareholder_id: 's2', name: 'Bình', unpaid_profit: -200_000, advance_outstanding: 0, advance_pending: 0, balance: -200_000 }),
  position({ shareholder_id: 'gone', name: 'Cũ', is_deleted: true, has_login: false, unpaid_profit: 50_000, advance_outstanding: 0, advance_pending: 0, balance: 50_000 }),
];

import ProfitOverviewTab from '../ProfitOverviewTab';

const rowOf = (id: string) => screen.getByTestId(`ledger-row-${id}`);
const chiOf = (id: string) => within(rowOf(id)).queryByRole('button', { name: 'Chi' }) as HTMLButtonElement | null;

beforeEach(() => {
  m.route = 'LEGACY';
  m.ledgerError = null;
  m.positions = 'ok';
  m.extraPositions = [];
  m.dropPositions = [];
  m.positionCalls = [];
  m.perms = { shareholder_profit: { distribute: true, pay_manager: true } };
  m.distProps = [];
  m.me = null;
  m.selfAdvanceProps = [];
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Tổng quan chủ — sổ tổng (E1)', () => {
  it('LEGACY: bảng hiện số sổ tổng kèm "xem thử" + banner; số đầu trang giữ cách cũ; mọi nút Chi khoá', () => {
    render(<ProfitOverviewTab />);
    expect(screen.getByTestId('profit-ledger-route-banner').textContent).toBe('Sổ tổng đang xem thử — chưa chi lợi nhuận cổ đông được');
    expect(within(screen.getByTestId('shareholder-ledger-card')).getByText('xem thử')).toBeTruthy();
    expect(screen.getByTestId('ledger-unpaid-s1').textContent).toMatch(/900\.000/);
    // KPI: cả ba ô theo cách tính cũ (được chia 7.000, đã ứng 3.000, còn 4.000), không phải số sổ tổng.
    const kpis = screen.getByTestId('kpis');
    expect(within(kpis).getByText('Đã ứng / đã chia')).toBeTruthy();
    expect(within(screen.getByTestId('kpi-allocated')).getByText('Tổng được chia cổ đông')).toBeTruthy();
    expect(screen.getByTestId('kpi-allocated').textContent).toMatch(/7\.000/);
    expect(screen.getByTestId('kpi-remaining').textContent).toMatch(/4\.000/);
    expect(screen.getByTestId('kpi-remaining').textContent).toMatch(/cách tính cũ/);
    expect(chiOf('s1')!.disabled).toBe(true);
    expect(chiOf('s2')!.disabled).toBe(true);
    expect((screen.getByRole('button', { name: '＋ Chi lợi nhuận' }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).not.toMatch(/qua app đang tắt/);
  });

  it('CANONICAL: số đầu trang đọc sổ tổng; Chi mở hộp đúng cổ đông kèm dòng sổ tổng', () => {
    m.route = 'CANONICAL';
    render(<ProfitOverviewTab />);
    expect(screen.queryByTestId('profit-ledger-route-banner')).toBeNull();
    expect(within(screen.getByTestId('kpis')).getByText('Đã chi (đã duyệt)')).toBeTruthy();
    // Hai con số đọc vị thế (R1): lợi nhuận chưa chi = 900.000 − 200.000 + 50.000 (người đã xoá còn số);
    // tạm ứng đang có 300.000, chờ duyệt 100.000; qua lương 100.000.
    const unpaid = screen.getByTestId('kpi-remaining');
    expect(within(unpaid).getByText('Lợi nhuận chưa chi')).toBeTruthy();
    expect(unpaid.textContent).toMatch(/750\.000/);
    expect(unpaid.textContent).toMatch(/đang chờ chi 250\.000/);
    expect(unpaid.textContent).toMatch(/có cổ đông âm/);
    expect(unpaid.textContent).not.toMatch(/Còn phải trả|đang tạm ứng/);
    const advance = screen.getByTestId('kpi-advance');
    expect(within(advance).getByText('Tạm ứng đang có')).toBeTruthy();
    expect(advance.textContent).toMatch(/300\.000/);
    expect(advance.textContent).toMatch(/chờ duyệt 100\.000/);
    expect(screen.getByTestId('kpi-paid').textContent).toMatch(/qua lương 100\.000/);
    // Ô "được chia" cùng gốc E1: Σ allocated sau mốc gồm cả cổ đông đã xoá còn số (1.000.000 + 100.000 + 50.000),
    // KHÔNG phải tổng phân bổ cộng dồn của cách cũ (7.000).
    expect(within(screen.getByTestId('kpi-allocated')).getByText('Được chia (sau mốc)')).toBeTruthy();
    expect(screen.getByTestId('kpi-allocated').textContent).toMatch(/1\.150\.000/);
    expect(chiOf('s1')!.disabled).toBe(false);
    fireEvent.click(chiOf('s1')!);
    expect(screen.getByTestId('dist-dialog').textContent).toBe('s1');
    const last = m.distProps[m.distProps.length - 1]!;
    expect(last.ledgerRows).toBe(ROWS);
    expect(last.organizationId).toBe('org-a');
    // Hộp chốt không còn chế độ nhập tay số tiền; lời nhắc "đặt mốc trước" mở đúng hộp mốc của cổ đông đó.
    expect(last).not.toHaveProperty('mode');
    act(() => { (last.onSetMarker as (id: string) => void)('s1'); });
    expect(screen.getByTestId('marker-dialog').textContent).toBe('An');
    expect(screen.queryByTestId('dist-dialog')).toBeNull();
  });

  it('mỗi cổ đông HAI số: lợi nhuận chưa chi (âm vẫn hiện, có giải thích) và tạm ứng đang có (kèm chờ duyệt)', () => {
    m.route = 'CANONICAL';
    render(<ProfitOverviewTab />);
    const table = screen.getByTestId('shareholder-ledger-table');
    expect(within(table).getByText('Lợi nhuận chưa chi')).toBeTruthy();
    expect(within(table).getByText('Tạm ứng đang có')).toBeTruthy();
    expect(within(table).queryByText('Còn phải trả / tạm ứng')).toBeNull();
    expect(screen.getByTestId('ledger-unpaid-s1').textContent).toMatch(/900\.000.*đang chờ chi 250\.000/);
    expect(screen.getByTestId('ledger-advance-s1').textContent).toMatch(/300\.000.*chờ duyệt 100\.000/);
    expect(within(rowOf('s1')).getByText('được tạm ứng')).toBeTruthy();
    expect(within(rowOf('s2')).queryByText('được tạm ứng')).toBeNull();
    // Bình: âm — hiện đúng số âm, tô cảnh báo, có câu giải thích; không kèm "chờ duyệt" khi bằng 0.
    const negative = screen.getByTestId('ledger-unpaid-s2');
    expect(negative.textContent).toMatch(/-200\.000/);
    expect(negative.className).toMatch(/bad/);
    expect(negative.getAttribute('title')).toMatch(/đã chi nhiều hơn phần được chia/);
    expect(screen.getByTestId('ledger-advance-s2').textContent).not.toMatch(/chờ duyệt/);
    expect(screen.getByTestId('ledger-unpaid-total').textContent).toMatch(/750\.000/);
    expect(screen.getByTestId('ledger-advance-total').textContent).toMatch(/300\.000.*chờ duyệt 100\.000/);
    expect(screen.getByTestId('ledger-position-note').textContent).toMatch(/Lợi nhuận chưa chi âm/);
  });

  it('vị thế đang tải ⇒ ô hiện "…" và khung chờ, KHÔNG hiện 0; chỉ gọi khi đã có sổ tổng', () => {
    m.route = 'CANONICAL';
    m.positions = 'pending';
    render(<ProfitOverviewTab />);
    expect(m.positionCalls.every((c) => c.org === 'org-a' && c.enabled === true)).toBe(true);
    expect(screen.getByTestId('ledger-unpaid-s1').textContent).toBe('…');
    expect(screen.getByTestId('ledger-advance-s1').textContent).toBe('…');
    expect(screen.getByTestId('ledger-unpaid-total').textContent).toBe('…');
    expect(screen.getByTestId('kpi-remaining').textContent).not.toMatch(/\d/);
    expect(screen.getByTestId('kpi-advance').textContent).not.toMatch(/\d/);
    expect(within(screen.getByTestId('kpi-advance')).getByLabelText('Đang tải tạm ứng đang có')).toBeTruthy();
  });

  it('vị thế lỗi ⇒ báo tại chỗ có nút tải lại, ô và số đầu trang "—" (không đoán), phần E1 vẫn hiện', () => {
    m.route = 'CANONICAL';
    m.positions = { code: 'XX000', message: 'PROFIT_LEDGER_POSITION_DRIFT: lệch' };
    render(<ProfitOverviewTab />);
    const error = screen.getByTestId('ledger-positions-error');
    expect(error.textContent).toMatch(/không cộng ra đúng số dư sổ tổng/);
    expect(within(error).getByRole('button', { name: /Tải lại/ })).toBeTruthy();
    expect(screen.getByTestId('ledger-unpaid-s1').textContent).toBe('—');
    expect(screen.getByTestId('ledger-advance-total').textContent).toBe('—');
    expect(screen.getByTestId('kpi-remaining').textContent).toMatch(/—.*chưa tải được/);
    expect(screen.getByTestId('kpi-advance').textContent).toMatch(/—.*chưa tải được/);
    expect(screen.getByTestId('kpi-allocated').textContent).toMatch(/1\.150\.000/);
    expect(chiOf('s1')!.disabled).toBe(false);
  });

  it('còn phiếu lương cần xem lại ⇒ Chi khoá, có chip; cổ đông đã xoá còn số: mờ, không nút Chi', () => {
    m.route = 'CANONICAL';
    render(<ProfitOverviewTab />);
    expect(chiOf('s2')!.disabled).toBe(true);
    expect(chiOf('s2')!.title).toMatch(/phiếu lương cần xem lại/);
    expect(within(rowOf('s2')).getByText('cần xem lại (1)')).toBeTruthy();
    expect(within(rowOf('s2')).getByText('hết T09/2026')).toBeTruthy();
    expect(within(rowOf('s2')).queryByText('Đang tạm ứng')).toBeNull();
    expect(within(rowOf('gone')).getByText('đã xoá')).toBeTruthy();
    expect(chiOf('gone')).toBeNull();
    expect(rowOf('gone').getAttribute('style')).toMatch(/opacity/);
  });

  it.each([
    ['SHADOW', 'Đang đặt mốc đã trả đủ — chưa mở chi', false],
    ['FROZEN', 'Sổ tổng đang đóng băng — chỉ huỷ được, chưa chi hay duyệt được', true],
  ])('%s: Chi khoá + banner; nút Mốc theo trạng thái', (route, banner, markerLocked) => {
    m.route = route;
    render(<ProfitOverviewTab />);
    expect(screen.getByTestId('profit-ledger-route-banner').textContent).toBe(banner);
    expect(chiOf('s1')!.disabled).toBe(true);
    const marker = within(rowOf('s1')).getByRole('button', { name: 'Mốc' }) as HTMLButtonElement;
    expect(marker.disabled).toBe(markerLocked);
    if (!markerLocked) {
      fireEvent.click(marker);
      expect(screen.getByTestId('marker-dialog').textContent).toBe('An');
    }
  });

  it('sổ tổng chạy + lọc một cổ đông: các ô số đầu trang cùng lọc theo cổ đông đó', () => {
    m.route = 'SHADOW';
    render(<ProfitOverviewTab />);
    fireEvent.click(within(rowOf('s1')).getByRole('button', { name: 'An' }));
    expect(within(screen.getByTestId('kpi-allocated')).getByText('Được chia (sau mốc) · An')).toBeTruthy();
    expect(screen.getByTestId('kpi-allocated').textContent).toMatch(/1\.000\.000/);
    expect(screen.getByTestId('kpi-paid').textContent).toMatch(/300\.000/);
    expect(screen.getByTestId('kpi-remaining').textContent).toMatch(/900\.000/);
    expect(screen.getByTestId('kpi-remaining').textContent).not.toMatch(/có cổ đông âm/);
    expect(screen.getByTestId('kpi-advance').textContent).toMatch(/300\.000/);
  });

  it('nút Sổ mở sổ chi tiết của đúng cổ đông', () => {
    render(<ProfitOverviewTab />);
    fireEvent.click(within(rowOf('s2')).getByRole('button', { name: 'Sổ' }));
    expect(screen.getByTestId('ledger-sheet').textContent).toBe('Bình');
  });

  it('không có quyền chi lợi nhuận ⇒ không nút Chi / Mốc / "Chi lợi nhuận"', () => {
    m.route = 'CANONICAL';
    m.perms = { shareholder_profit: { lock: true } };
    render(<ProfitOverviewTab />);
    expect(chiOf('s1')).toBeNull();
    expect(within(rowOf('s1')).queryByRole('button', { name: 'Mốc' })).toBeNull();
    expect(screen.queryByRole('button', { name: '＋ Chi lợi nhuận' })).toBeNull();
  });

  it('không được xem sổ tổng (42501) ⇒ báo tại chỗ, không nút tải lại; số đầu trang giữ cách cũ', () => {
    m.ledgerError = { code: '42501', message: 'PROFIT_LEDGER_FORBIDDEN: bạn không có quyền xem sổ tổng lợi nhuận của công ty này' };
    render(<ProfitOverviewTab />);
    const card = screen.getByTestId('shareholder-ledger-card');
    expect(within(card).getByRole('alert').textContent).toMatch(/không có quyền/);
    expect(within(card).queryByRole('button', { name: /Tải lại/ })).toBeNull();
    expect(screen.getByTestId('kpi-remaining').textContent).toMatch(/4\.000/);
  });

  it('lỗi đọc khác ⇒ số đầu trang "—" (không đoán), có nút tải lại', () => {
    m.ledgerError = { code: 'XX000', message: 'PROFIT_LEDGER_ENTRIES_DRIFT: lệch' };
    render(<ProfitOverviewTab />);
    expect(screen.getByTestId('kpi-remaining').textContent).toMatch(/—/);
    expect(screen.getByTestId('kpi-allocated').textContent).toMatch(/—/);
    expect(within(screen.getByTestId('shareholder-ledger-card')).getByRole('button', { name: /Tải lại/ })).toBeTruthy();
  });

  // R4 (review chéo 18/11): R1 và E1 đều kèm cổ đông đã xoá còn số nhưng xét "còn số" theo con số riêng.
  it('số đầu trang + biểu đồ cộng ĐÚNG các dòng của bảng: dòng chỉ có ở R1 (đã xoá còn số) không được cộng', () => {
    m.route = 'CANONICAL';
    m.extraPositions = [position({
      shareholder_id: 'r1-only', name: 'Chỉ có ở R1', is_deleted: true, has_login: false,
      unpaid_profit: 1_000_000, advance_outstanding: 70_000, advance_pending: 0, balance: 930_000,
    })];
    render(<ProfitOverviewTab />);
    // Bảng: ba dòng E1 ⇒ chưa chi 900.000 − 200.000 + 50.000 = 750.000; tạm ứng 300.000 (+ chờ duyệt 100.000).
    expect(screen.queryByTestId('ledger-row-r1-only')).toBeNull();
    expect(screen.getByTestId('ledger-unpaid-total').textContent).toMatch(/750\.000/);
    expect(screen.getByTestId('ledger-advance-total').textContent).toMatch(/300\.000/);
    // Số đầu trang cùng tập với dòng Tổng của bảng — KHÔNG 1.750.000 / 370.000.
    const unpaid = screen.getByTestId('kpi-remaining').textContent ?? '';
    const advance = screen.getByTestId('kpi-advance').textContent ?? '';
    expect(unpaid).toMatch(/750\.000/);
    expect(unpaid).not.toMatch(/1\.750\.000/);
    expect(advance).toMatch(/300\.000/);
    expect(advance).not.toMatch(/370\.000/);
    // Biểu đồ "Lợi nhuận chưa chi theo cổ đông" cũng không vẽ dòng chỉ có ở R1.
    expect(screen.queryByText('Chỉ có ở R1')).toBeNull();
  });

  it('một dòng của bảng thiếu vị thế ⇒ dòng Tổng và số đầu trang cùng "—", nói rõ thiếu số (không cộng thiếu)', () => {
    m.route = 'CANONICAL';
    m.dropPositions = ['gone'];
    render(<ProfitOverviewTab />);
    expect(screen.getByTestId('ledger-unpaid-gone').textContent).toBe('—');
    expect(screen.getByTestId('ledger-unpaid-total').textContent).toBe('—');
    expect(screen.getByTestId('kpi-remaining').textContent).toMatch(/—.*thiếu số của một cổ đông/);
    expect(screen.getByTestId('kpi-remaining').textContent).not.toMatch(/700\.000/);
    expect(screen.getByTestId('kpi-advance').textContent).toMatch(/—.*thiếu số của một cổ đông/);
  });

  it('bố cục: mốc là dòng phụ dưới tên, "Chờ duyệt" là dòng phụ của "Đã chi" (không còn cột riêng); KPI là lưới đều, không còn vạch ngăn rời', () => {
    m.route = 'CANONICAL';
    render(<ProfitOverviewTab />);
    const heads = within(screen.getByTestId('shareholder-ledger-table')).getAllByRole('columnheader').map((th) => th.textContent);
    expect(heads).toEqual(['Cổ đông', 'Được chia (sau mốc)', 'Đã chi', 'Qua lương', 'Lợi nhuận chưa chi', 'Tạm ứng đang có', '']);
    expect(screen.getByTestId('ledger-marker-s2').textContent).toBe('mốc hết T09/2026');
    expect(screen.queryByTestId('ledger-marker-s1')).toBeNull(); // chưa có mốc: không thêm dòng
    expect(screen.getByTestId('ledger-paid-s1').textContent).toMatch(/300\.000.*chờ duyệt 100\.000/);
    expect(screen.getByTestId('ledger-paid-s2').textContent).not.toMatch(/chờ duyệt/);
    expect(screen.getByTestId('ledger-paid-total').textContent).toMatch(/600\.000.*chờ duyệt 100\.000/);
    const grid = screen.getByTestId('owner-kpi-grid');
    expect(grid.querySelectorAll(':scope > .ph-kpi-grid__in > .ph-kpi')).toHaveLength(6);
    expect(screen.getByTestId('kpis').querySelector('.ph-kpi__div')).toBeNull();
  });
});

// R3 (review chéo 18/11): chủ đồng thời là cổ đông mất đường tự ứng ở trang Báo cáo Lợi nhuận.
describe('Tổng quan chủ — "Chi tạm ứng cho tôi" khi chủ đồng thời là cổ đông có quyền tạm ứng', () => {
  const selfButton = () => screen.queryByRole('button', { name: /Chi tạm ứng cho tôi/ }) as HTMLButtonElement | null;
  const ME = { id: 's1', name: 'An', organization_id: 'org-a' };

  it('cổ đông của đúng công ty + có quyền tạm ứng ⇒ có nút; mở hộp tự tạm ứng của chính mình ở công ty đang xem', () => {
    m.route = 'CANONICAL';
    m.me = ME;
    m.perms = { shareholder_profit: { distribute: true, advance_own_cashbook: true } };
    render(<ProfitOverviewTab />);
    expect(selfButton()!.disabled).toBe(false);
    expect(screen.queryByTestId('self-advance-dialog')).toBeNull();
    fireEvent.click(selfButton()!);
    expect(screen.getByTestId('self-advance-dialog').textContent).toBe(JSON.stringify({ shareholderId: 's1', name: 'An' }));
    expect(m.selfAdvanceProps.at(-1)).toMatchObject({ open: true, organizationId: 'org-a' });
    // Nút chốt chi của chủ vẫn còn bên cạnh.
    expect(screen.getByRole('button', { name: '＋ Chi lợi nhuận' })).toBeTruthy();
  });

  it('sổ tổng chưa chạy thật ⇒ nút có nhưng khoá, kèm lý do (như màn tự xem)', () => {
    m.route = 'SHADOW';
    m.me = ME;
    m.perms = { shareholder_profit: { distribute: true, advance_own_cashbook: true } };
    render(<ProfitOverviewTab />);
    expect(selfButton()!.disabled).toBe(true);
    expect(selfButton()!.title).toMatch(/chưa mở chi tạm ứng/);
  });

  it('không có quyền chi lợi nhuận nhưng là cổ đông có quyền tạm ứng ⇒ vẫn tự ứng được, không có "Chi lợi nhuận"', () => {
    m.route = 'CANONICAL';
    m.me = ME;
    m.perms = { shareholder_profit: { lock: true, advance_own_cashbook: true } };
    render(<ProfitOverviewTab />);
    expect(selfButton()!.disabled).toBe(false);
    expect(screen.queryByRole('button', { name: '＋ Chi lợi nhuận' })).toBeNull();
  });

  it.each([
    ['không phải cổ đông', null, { distribute: true, advance_own_cashbook: true }],
    ['cổ đông của công ty khác', { id: 's9', name: 'Khác', organization_id: 'org-b' }, { distribute: true, advance_own_cashbook: true }],
    ['không có quyền tạm ứng', { id: 's1', name: 'An', organization_id: 'org-a' }, { distribute: true }],
  ])('%s ⇒ không có nút, không dựng hộp (không hiện rồi mới báo lỗi)', (_name, me, perms) => {
    m.route = 'CANONICAL';
    m.me = me;
    m.perms = { shareholder_profit: perms };
    render(<ProfitOverviewTab />);
    expect(selfButton()).toBeNull();
    expect(m.selfAdvanceProps).toEqual([]);
  });
});
