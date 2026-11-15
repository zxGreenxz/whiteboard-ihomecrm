// @vitest-environment jsdom
// Bộ định tuyến tab "Tổng quan" của cổ đông tự xem (máy tính) — Đợt 2:
//   ready=false (công tắc sổ tổng tắt) ⇒ THÂN CŨ; ready=true (SHADOW/CANONICAL/FROZEN) ⇒ màn sổ tổng và
//   KHÔNG đọc bảng phân bổ cũ; 42501 ⇒ không số nào; lỗi ⇒ câu tiếng Việt + tải lại; E3 hỏi đúng công ty của cổ đông.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Shareholder } from '@/hooks/useShareholders';
import type { MyProfitLedger } from '@/lib/profitLedger/ledgerReaders';

const h = vi.hoisted(() => ({
  ledger: { data: undefined, error: null, isError: false, isFetching: false } as {
    data: unknown; error: unknown; isError: boolean; isFetching: boolean;
  },
  ledgerHook: vi.fn(),
  refetch: vi.fn(),
  allocations: vi.fn(),
  distributions: vi.fn(),
  shareBuildings: vi.fn(),
  newView: vi.fn(),
}));

const okQuery = (data: unknown) => ({
  data, status: 'success' as const, fetchStatus: 'idle' as const, isLoading: false, isError: false, error: null, refetch: vi.fn(),
});

vi.mock('@/hooks/profit-ledger/useProfitLedgerQueries', () => ({
  useMyProfitLedger: (org: string | null, options?: unknown) => {
    h.ledgerHook(org, options);
    return { ...h.ledger, refetch: h.refetch };
  },
}));
vi.mock('@/hooks/useShareholderProfit', () => ({
  useProfitAllocations: () => {
    h.allocations();
    return okQuery([{ id: 'a1', shareholder_id: 'sh-1', building_id: 'b1', period_month: '2026-08-01', amount: 4_000_000, percent: 20 }]);
  },
  useShareholderDistributions: () => {
    h.distributions();
    return okQuery([{ id: 'd1', shareholder_id: 'sh-1', voucher_date: '2026-09-02', name: 'Chi lợi nhuận', total_amount: 1_000_000 }]);
  },
  computeShareholderSummary: () => ({ 'sh-1': { accrued: 4_000_000, paid: 1_000_000, remaining: 3_000_000 } }),
}));
vi.mock('@/hooks/useShareholders', () => ({
  useMyShareBuildings: () => {
    h.shareBuildings();
    return okQuery([{ id: 'b1', name: 'Toà Một' }]);
  },
}));
vi.mock('@/pages/reports/finance/ProfitHubShell', () => ({
  ProfitHubSlot: ({ name, children }: { name: string; children?: ReactNode }) => createElement('div', { 'data-slot': name }, children),
}));
vi.mock('@/components/shareholders/ShareholderLedgerSelfView', () => ({
  default: (props: { ledger: MyProfitLedger; access: unknown }) => {
    h.newView(props);
    return createElement('div', { 'data-probe': 'ledger-view' }, `route ${props.ledger.route}`);
  },
}));

import ShareholderSelfView from '../ShareholderSelfView';

const me = (over: Record<string, unknown> = {}) => ({
  id: 'sh-1', user_id: 'u-1', auth_user_id: 'auth-1', name: 'Cổ đông 1', note: null, is_active: true,
  created_at: '2026-01-01', updated_at: '2026-01-01', deleted_at: null, organization_id: 'org-a', ...over,
}) as Shareholder;

const ledger = (over: Partial<MyProfitLedger> = {}): MyProfitLedger => ({
  organization_id: 'org-a', route: 'LEGACY', ready: false, shareholder: { id: 'sh-1', name: 'Cổ đông 1' },
  balance: 3_000_000, status: 'OWED', allocated: 4_000_000, paid: 1_000_000, paid_pending: 0, paid_via_salary: 0, advance_recovered: 0,
  marker: null, months: [], payouts: [], salary: [], ...over,
});

const access = { canViewPercent: false, canViewBuildingTotals: false, canAdvanceOwn: false };
const view = (shareholder: Shareholder = me()) => render(<ShareholderSelfView me={shareholder} {...access} />);
const legacyMounted = () => h.allocations.mock.calls.length + h.distributions.mock.calls.length + h.shareBuildings.mock.calls.length > 0;

beforeEach(() => {
  vi.clearAllMocks();
  h.ledger = { data: undefined, error: null, isError: false, isFetching: true };
});
afterEach(cleanup);

describe('ShareholderSelfView — bộ định tuyến sổ tổng', () => {
  it('E3 hỏi đúng công ty của dòng cổ đông', () => {
    view();
    expect(h.ledgerHook).toHaveBeenCalledWith('org-a', undefined);
  });

  it('LEGACY (ready=false) ⇒ thân cũ, số cũ, không tỷ lệ %', () => {
    h.ledger = { data: ledger(), error: null, isError: false, isFetching: false };
    view();
    expect(legacyMounted()).toBe(true);
    expect(screen.queryByTestId('ledger-view')).toBeNull();
    expect(document.body.textContent).toContain('Được chia (luỹ kế)');
    expect(document.body.textContent).toMatch(/3\.000\.000/);
    // Tỷ lệ cổ phần (20% trong bảng phân bổ) không hiện; "100%" của vòng cơ cấu theo nhà là cơ cấu phần của mình.
    expect(document.body.textContent).not.toMatch(/tỷ lệ/i);
    expect(document.body.textContent).not.toContain('20%');
  });

  it.each(['SHADOW', 'CANONICAL', 'FROZEN'] as const)('%s (ready=true) ⇒ màn sổ tổng, KHÔNG đọc bảng phân bổ cũ', (route) => {
    h.ledger = { data: ledger({ route, ready: true }), error: null, isError: false, isFetching: false };
    view();
    expect(document.querySelector('[data-probe="ledger-view"]')?.textContent).toBe(`route ${route}`);
    expect(h.newView).toHaveBeenCalledWith(expect.objectContaining({ access }));
    expect(legacyMounted()).toBe(false);
  });

  it('máy chủ nói không xem được (42501 ⇒ null) ⇒ không số nào, không thân cũ', () => {
    h.ledger = { data: null, error: null, isError: false, isFetching: false };
    view();
    expect(screen.getByRole('status').textContent).toMatch(/chưa xem được phần lợi nhuận/);
    expect(legacyMounted()).toBe(false);
    expect(h.newView).not.toHaveBeenCalled();
  });

  it('đang tải ⇒ chưa mount thân cũ (chưa biết công tắc)', () => {
    view();
    expect(legacyMounted()).toBe(false);
    expect(h.newView).not.toHaveBeenCalled();
  });

  it('lỗi ⇒ câu tiếng Việt theo mã máy, không lộ mã; Tải lại gọi lại E3', () => {
    h.ledger = {
      data: undefined, isError: true, isFetching: false,
      error: { code: '55000', message: 'PROFIT_LEDGER_SHAREHOLDER_AMBIGUOUS: tài khoản gắn nhiều cổ đông' },
    };
    view();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/gắn với nhiều cổ đông/);
    expect(alert.textContent).not.toContain('PROFIT_LEDGER');
    fireEvent.click(screen.getByRole('button', { name: 'Tải lại' }));
    expect(h.refetch).toHaveBeenCalled();
    expect(legacyMounted()).toBe(false);
  });

  it('dòng cổ đông thiếu công ty ⇒ báo lỗi, không gọi E3 với công ty đoán', () => {
    view(me({ organization_id: undefined }));
    expect(h.ledgerHook).toHaveBeenCalledWith(null, undefined);
    expect(screen.getByRole('alert').textContent).toMatch(/Chưa xác định được công ty/);
    expect(legacyMounted()).toBe(false);
  });
});
