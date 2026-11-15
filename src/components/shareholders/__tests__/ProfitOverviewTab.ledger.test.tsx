// @vitest-environment jsdom
// Tổng quan của chủ (máy tính) đọc sổ tổng E1 (D2.4): bảng sổ tổng, nút Chi theo trạng thái sổ tổng,
// banner thay ghi chú cũ "chi qua app đang tắt", số đầu trang LEGACY giữ cách cũ. Dữ liệu GIẢ.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  route: 'LEGACY' as string,
  ledgerError: null as unknown,
  perms: { shareholder_profit: { distribute: true, pay_manager: true } } as Record<string, unknown>,
  distProps: [] as Record<string, unknown>[],
}));
const ok = (data: unknown) => ({ data, status: 'success', fetchStatus: 'idle', isLoading: false, isError: false, error: null, refetch: vi.fn() });

vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org-a' }) }));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: m.perms }) }));
vi.mock('@/pages/reports/finance/ProfitHubShell', () => ({
  ProfitHubSlot: ({ children }: { children?: ReactNode }) => <div data-testid="kpis">{children}</div>,
}));
vi.mock('@/hooks/useShareholders', () => ({ useShareholders: () => ok([{ id: 's1', name: 'An' }, { id: 's2', name: 'Bình' }]) }));
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

import ProfitOverviewTab from '../ProfitOverviewTab';

const rowOf = (id: string) => screen.getByTestId(`ledger-row-${id}`);
const chiOf = (id: string) => within(rowOf(id)).queryByRole('button', { name: 'Chi' }) as HTMLButtonElement | null;

beforeEach(() => {
  m.route = 'LEGACY';
  m.ledgerError = null;
  m.perms = { shareholder_profit: { distribute: true, pay_manager: true } };
  m.distProps = [];
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Tổng quan chủ — sổ tổng (E1)', () => {
  it('LEGACY: bảng hiện số sổ tổng kèm "xem thử" + banner; số đầu trang giữ cách cũ; mọi nút Chi khoá', () => {
    render(<ProfitOverviewTab />);
    expect(screen.getByTestId('profit-ledger-route-banner').textContent).toBe('Sổ tổng đang xem thử — chưa chi lợi nhuận cổ đông được');
    expect(within(screen.getByTestId('shareholder-ledger-card')).getByText('xem thử')).toBeTruthy();
    expect(within(rowOf('s1')).getByText(/500\.000/)).toBeTruthy();
    // KPI: cách tính cũ (đã ứng 3.000, còn 4.000), không phải số sổ tổng.
    const kpis = screen.getByTestId('kpis');
    expect(within(kpis).getByText('Đã ứng / đã chia')).toBeTruthy();
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
    // Còn phải trả = 500.000 + 50.000 (người đã xoá còn số); tạm ứng 200.000; qua lương 100.000.
    expect(screen.getByTestId('kpi-remaining').textContent).toMatch(/550\.000/);
    expect(screen.getByTestId('kpi-remaining').textContent).toMatch(/đang tạm ứng 200\.000/);
    expect(screen.getByTestId('kpi-paid').textContent).toMatch(/qua lương 100\.000/);
    expect(chiOf('s1')!.disabled).toBe(false);
    fireEvent.click(chiOf('s1')!);
    expect(screen.getByTestId('dist-dialog').textContent).toBe('s1');
    const last = m.distProps[m.distProps.length - 1]!;
    expect(last.ledgerRows).toBe(ROWS);
    expect(last.organizationId).toBe('org-a');
  });

  it('còn phiếu lương cần xem lại ⇒ Chi khoá, có chip; cổ đông đã xoá còn số: mờ, không nút Chi', () => {
    m.route = 'CANONICAL';
    render(<ProfitOverviewTab />);
    expect(chiOf('s2')!.disabled).toBe(true);
    expect(chiOf('s2')!.title).toMatch(/phiếu lương cần xem lại/);
    expect(within(rowOf('s2')).getByText('cần xem lại (1)')).toBeTruthy();
    expect(within(rowOf('s2')).getByText('hết T09/2026')).toBeTruthy();
    expect(within(rowOf('s2')).getByText('Đang tạm ứng')).toBeTruthy();
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
    expect(within(screen.getByTestId('shareholder-ledger-card')).getByRole('button', { name: /Tải lại/ })).toBeTruthy();
  });
});
