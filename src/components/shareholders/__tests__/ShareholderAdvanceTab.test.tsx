// @vitest-environment jsdom
// Tab "Tạm ứng LN": chỉ ứng cho CHÍNH MÌNH (hộp tạm ứng, đúng công ty của E3), mọi khoản chờ chủ duyệt;
// khoản tự lập còn chờ thì tự huỷ; hai con số của vị thế (R2) chỉ hiện khi sổ tổng đã chạy; công tắc chưa mở ⇒ nút khoá.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Shareholder } from '@/hooks/useShareholders';
import type { MyProfitLedger } from '@/lib/profitLedger/ledgerReaders';

const h = vi.hoisted(() => ({
  ledgerData: undefined as unknown, ledgerHook: vi.fn(), distribute: vi.fn(), cancel: vi.fn(),
  /** Vị thế của chính mình (R2): dữ liệu hoặc lỗi đọc. */
  position: undefined as unknown, positionHook: vi.fn(),
}));

vi.mock('@/hooks/profit-ledger/useProfitLedgerQueries', () => ({
  useMyProfitLedger: (org: string | null) => {
    h.ledgerHook(org);
    return { data: h.ledgerData, error: null, isError: false, isFetching: false, refetch: vi.fn() };
  },
  useMyShareholderPosition: (org: string | null, options?: { enabled?: boolean }) => {
    h.positionHook(org, options?.enabled);
    if (options?.enabled === false) return { data: undefined, isError: false, error: null, refetch: vi.fn() };
    if (h.position && typeof h.position === 'object' && 'code' in h.position) return { data: undefined, isError: true, error: h.position, refetch: vi.fn() };
    return { data: h.position, isError: false, error: null, refetch: vi.fn() };
  },
}));
vi.mock('@/pages/reports/finance/ProfitHubShell', () => ({
  ProfitHubSlot: ({ name, children }: { name: string; children?: ReactNode }) => createElement('div', { 'data-slot': name }, children),
}));
vi.mock('@/components/shareholders/ProfitSelfAdvanceDialog', () => ({
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

import ShareholderAdvanceTab from '../ShareholderAdvanceTab';

const me = {
  id: 'sh-1', user_id: 'u-1', auth_user_id: 'auth-1', name: 'Cổ đông 1', note: null, is_active: true,
  created_at: '2026-01-01', updated_at: '2026-01-01', deleted_at: null, organization_id: 'org-a',
} as Shareholder;

const ledger = (over: Partial<MyProfitLedger> = {}): MyProfitLedger => ({
  organization_id: 'org-a', route: 'CANONICAL', ready: true, shareholder: { id: 'sh-1', name: 'Cổ đông 1' },
  balance: -500_000, status: 'ADVANCE', allocated: 1_000_000, paid: 1_000_000, paid_pending: 500_000, paid_via_salary: 0, advance_recovered: 0,
  marker: null, months: [], salary: [],
  payouts: [
    { voucher_id: 'v1', voucher_code: 'PC-CU', voucher_date: '2026-09-01', amount: 1_000_000, status: 'APPROVED', posting_status: 'POSTED', is_advance: false, is_mine: false, is_mine_pending: false, excluded_by_marker: false },
    { voucher_id: 'v2', voucher_code: 'PC-TU', voucher_date: '2026-10-10', amount: 500_000, status: 'UNAPPROVED', posting_status: 'UNPOSTED', is_advance: true, is_mine: true, is_mine_pending: true, excluded_by_marker: false },
  ],
  ...over,
});

/** Vị thế của chính mình (R2): chưa chi 1.000.000, tạm ứng đã duyệt 1.000.000, còn 500.000 chờ duyệt. */
const myPosition = (over: Record<string, unknown> = {}) => ({
  organization_id: 'org-a', route: 'CANONICAL', shareholder: { id: 'sh-1', name: 'Cổ đông 1' },
  unpaid_profit: 1_000_000, advance_outstanding: 1_000_000, advance_pending: 500_000, settlement_cash_pending: 0, balance: -500_000,
  settled: { recognized: 0, offset: 0, cash: 0 }, last_settled_through_month: null, marker_month: null,
  needs_review: { count: 0, suggested: 0 },
  components: { allocated: 1_000_000, payouts_pending: 500_000, payouts_approved: 1_000_000, salary_investment: 0, salary_advance_offset: 0, unpaid_profit_raw: 1_000_000, advance_outstanding_raw: 1_000_000, advance_overoffset: 0 },
  settlements: [], ...over,
});

beforeEach(() => { vi.clearAllMocks(); h.position = myPosition(); });
afterEach(cleanup);

describe.each([false, true])('ShareholderAdvanceTab (điện thoại: %s)', (phone) => {
  const view = () => render(<ShareholderAdvanceTab me={me} phone={phone} />);

  it('sổ tổng chạy thật ⇒ HAI số của mình, nút mở hộp tạm ứng đúng công ty, chỉ khoản tự lập', () => {
    h.ledgerData = ledger();
    view();
    expect(h.ledgerHook).toHaveBeenCalledWith('org-a');
    expect(h.positionHook).toHaveBeenCalledWith('org-a', true);
    const numbers = screen.getByTestId('advance-balance').textContent ?? '';
    expect(numbers).toMatch(/Lợi nhuận chưa chi: 1\.000\.000/);
    expect(numbers).toMatch(/Tạm ứng đang có: 1\.000\.000.*\(chờ duyệt 500\.000/);
    expect(numbers).not.toMatch(/Đang tạm ứng|Còn được nhận/);
    expect(document.body.textContent).toMatch(/Tạm ứng cộng dồn/);
    expect(document.body.textContent).toContain('PC-TU');
    expect(document.body.textContent).not.toContain('PC-CU');
    // Ngày phiếu dd/MM/yyyy như các màn tiền khác, không hiện chuỗi ISO.
    expect(document.body.textContent).toContain('10/10/2026');
    expect(document.body.textContent).not.toContain('2026-10-10');
    fireEvent.click(screen.getByRole('button', { name: /Chi tạm ứng cho tôi/ }));
    expect(screen.getByTestId('advance-dialog')).toBeTruthy();
    expect(h.distribute).toHaveBeenLastCalledWith(expect.objectContaining({
      open: true, organizationId: 'org-a', me: { shareholderId: 'sh-1', name: 'Cổ đông 1' },
    }));
  });

  it('các lần chủ chốt chi hiện ở đây; vị thế chưa đọc được ⇒ "—" + câu báo, không hiện 0', () => {
    h.ledgerData = ledger();
    h.position = myPosition({ settlements: [{
      id: 'st-1', through_month: '2026-10-01', recognized_amount: 800_000, advance_offset_amount: 800_000, cash_amount: 0,
      cash_voucher_id: null, cash_voucher_code: null, cash_voucher_status: null, cash_voucher_posting_status: null,
      created_at: '2026-11-18T10:00:00+07:00', excluded_by_marker: false,
    }] });
    const first = view();
    expect(screen.getByTestId('self-settlement-st-1').textContent).toMatch(/10\/2026.*Không ra tiền/);
    first.unmount();
    h.position = { code: 'XX000', message: 'PROFIT_LEDGER_POSITION_DRIFT: lệch' };
    view();
    expect(screen.getByTestId('advance-balance').textContent).toMatch(/Lợi nhuận chưa chi: —.*Tạm ứng đang có: —/);
    expect(screen.getByTestId('self-position-error').textContent).toMatch(/không cộng ra đúng số dư sổ tổng/);
    expect(screen.queryByTestId('self-settlements-card')).toBeNull();
  });

  it('khoản tự lập còn chờ ⇒ "Huỷ yêu cầu" mở hộp huỷ đúng phiếu', () => {
    h.ledgerData = ledger();
    view();
    fireEvent.click(screen.getByRole('button', { name: 'Huỷ yêu cầu' }));
    expect(screen.getByTestId('cancel-dialog')).toBeTruthy();
    expect(h.cancel).toHaveBeenLastCalledWith(expect.objectContaining({ target: expect.objectContaining({ voucherId: 'v2', organizationId: 'org-a' }) }));
  });

  it('công tắc còn tắt (LEGACY) ⇒ không số sổ tổng (không đọc vị thế), nút khoá kèm câu giải thích', () => {
    h.ledgerData = ledger({ route: 'LEGACY', ready: false });
    view();
    expect(screen.queryByTestId('advance-balance')).toBeNull();
    expect(screen.queryByTestId('self-settlements-card')).toBeNull();
    expect(h.positionHook).toHaveBeenCalledWith('org-a', false);
    expect((screen.getByRole('button', { name: /Chi tạm ứng cho tôi/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('note').textContent).toMatch(/Chưa mở chi tạm ứng/);
  });

  it('máy chủ không cho (42501 ⇒ null) ⇒ chỉ một câu nhắc, không nút', () => {
    h.ledgerData = null;
    view();
    expect(screen.getByRole('status').textContent).toMatch(/chưa được tạm ứng lợi nhuận/);
    expect(screen.queryByRole('button', { name: /Chi tạm ứng cho tôi/ })).toBeNull();
    expect(h.distribute).not.toHaveBeenCalled();
  });
});
