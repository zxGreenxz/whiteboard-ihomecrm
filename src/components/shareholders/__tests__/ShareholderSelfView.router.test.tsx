// @vitest-environment jsdom
// Bộ định tuyến tab "Tổng quan" của cổ đông tự xem (máy tính) — sau Đợt 3 (D3.14) chỉ còn sổ tổng:
//   ready=true (SHADOW/CANONICAL/FROZEN) ⇒ màn sổ tổng; ready=false (sổ tổng tắt) ⇒ một câu, không số nào,
//   không còn thân cũ đọc bảng phân bổ; 42501 ⇒ không số nào; lỗi ⇒ câu tiếng Việt + tải lại; E3 hỏi đúng công ty.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Shareholder } from '@/hooks/useShareholders';
import type { MyProfitLedger } from '@/lib/profitLedger/ledgerReaders';

const h = vi.hoisted(() => ({
  ledger: { data: undefined, error: null, isError: false, isFetching: false } as {
    data: unknown; error: unknown; isError: boolean; isFetching: boolean;
  },
  ledgerHook: vi.fn(),
  refetch: vi.fn(),
  newView: vi.fn(),
}));

vi.mock('@/hooks/profit-ledger/useProfitLedgerQueries', () => ({
  useMyProfitLedger: (org: string | null, options?: unknown) => {
    h.ledgerHook(org, options);
    return { ...h.ledger, refetch: h.refetch };
  },
}));
vi.mock('@/components/shareholders/ShareholderLedgerSelfView', () => ({
  default: (props: { ledger: MyProfitLedger; access: unknown }) => {
    h.newView(props);
    return createElement('div', { 'data-probe': 'ledger-view' }, `route ${props.ledger.route}`);
  },
}));

import ShareholderSelfView from '../ShareholderSelfView';
import { PROFIT_LEDGER_OFF_TEXT } from '../MyProfitLedgerGate';

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

  it('sổ tổng tắt (ready=false) ⇒ một câu báo tắt, không số nào, không màn sổ tổng', () => {
    h.ledger = { data: ledger(), error: null, isError: false, isFetching: false };
    view();
    expect(screen.getByRole('status').textContent).toBe(PROFIT_LEDGER_OFF_TEXT);
    expect(h.newView).not.toHaveBeenCalled();
    // Cả màn chỉ có đúng câu báo tắt: không số E3 nào (4.000.000 / 1.000.000 / 3.000.000), không thân cũ.
    expect(document.body.textContent).toBe(PROFIT_LEDGER_OFF_TEXT);
  });

  it.each(['SHADOW', 'CANONICAL', 'FROZEN'] as const)('%s (ready=true) ⇒ màn sổ tổng', (route) => {
    h.ledger = { data: ledger({ route, ready: true }), error: null, isError: false, isFetching: false };
    view();
    expect(document.querySelector('[data-probe="ledger-view"]')?.textContent).toBe(`route ${route}`);
    expect(h.newView).toHaveBeenCalledWith(expect.objectContaining({ access }));
    expect(screen.queryByText(PROFIT_LEDGER_OFF_TEXT)).toBeNull();
  });

  it('máy chủ nói không xem được (42501 ⇒ null) ⇒ không số nào', () => {
    h.ledger = { data: null, error: null, isError: false, isFetching: false };
    view();
    expect(screen.getByRole('status').textContent).toMatch(/chưa xem được phần lợi nhuận/);
    expect(h.newView).not.toHaveBeenCalled();
  });

  it('đang tải ⇒ chưa mount màn nào', () => {
    view();
    expect(h.newView).not.toHaveBeenCalled();
    expect(screen.queryByText(PROFIT_LEDGER_OFF_TEXT)).toBeNull();
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
  });

  it('dòng cổ đông thiếu công ty ⇒ báo lỗi, không gọi E3 với công ty đoán', () => {
    view(me({ organization_id: undefined }));
    expect(h.ledgerHook).toHaveBeenCalledWith(null, undefined);
    expect(screen.getByRole('alert').textContent).toMatch(/Chưa xác định được công ty/);
  });
});
