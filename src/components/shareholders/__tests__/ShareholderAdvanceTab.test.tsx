// @vitest-environment jsdom
// Tab "Tạm ứng LN": chỉ chi cho CHÍNH MÌNH (hộp SELF_ADVANCE, đúng công ty của E3), mọi khoản chờ chủ duyệt;
// khoản tự lập còn chờ thì tự huỷ; số dư chỉ hiện khi sổ tổng đã chạy; công tắc chưa mở ⇒ nút khoá.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Shareholder } from '@/hooks/useShareholders';
import type { MyProfitLedger } from '@/lib/profitLedger/ledgerReaders';

const h = vi.hoisted(() => ({ ledgerData: undefined as unknown, ledgerHook: vi.fn(), distribute: vi.fn(), cancel: vi.fn() }));

vi.mock('@/hooks/profit-ledger/useProfitLedgerQueries', () => ({
  useMyProfitLedger: (org: string | null) => {
    h.ledgerHook(org);
    return { data: h.ledgerData, error: null, isError: false, isFetching: false, refetch: vi.fn() };
  },
}));
vi.mock('@/pages/reports/finance/ProfitHubShell', () => ({
  ProfitHubSlot: ({ name, children }: { name: string; children?: ReactNode }) => createElement('div', { 'data-slot': name }, children),
}));
vi.mock('@/components/shareholders/ProfitDistributeDialog', () => ({
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

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe.each([false, true])('ShareholderAdvanceTab (điện thoại: %s)', (phone) => {
  const view = () => render(<ShareholderAdvanceTab me={me} phone={phone} />);

  it('sổ tổng chạy thật ⇒ số dư của mình, nút mở hộp SELF_ADVANCE đúng công ty, chỉ khoản tự lập', () => {
    h.ledgerData = ledger();
    view();
    expect(h.ledgerHook).toHaveBeenCalledWith('org-a');
    expect(screen.getByTestId('advance-balance').textContent).toMatch(/Đang tạm ứng: 500\.000/);
    expect(document.body.textContent).toContain('PC-TU');
    expect(document.body.textContent).not.toContain('PC-CU');
    // Ngày phiếu dd/MM/yyyy như các màn tiền khác, không hiện chuỗi ISO.
    expect(document.body.textContent).toContain('10/10/2026');
    expect(document.body.textContent).not.toContain('2026-10-10');
    fireEvent.click(screen.getByRole('button', { name: /Chi tạm ứng cho tôi/ }));
    expect(screen.getByTestId('advance-dialog')).toBeTruthy();
    expect(h.distribute).toHaveBeenLastCalledWith(expect.objectContaining({
      open: true, mode: 'SELF_ADVANCE', organizationId: 'org-a', me: { shareholderId: 'sh-1', name: 'Cổ đông 1' },
    }));
  });

  it('khoản tự lập còn chờ ⇒ "Huỷ yêu cầu" mở hộp huỷ đúng phiếu', () => {
    h.ledgerData = ledger();
    view();
    fireEvent.click(screen.getByRole('button', { name: 'Huỷ yêu cầu' }));
    expect(screen.getByTestId('cancel-dialog')).toBeTruthy();
    expect(h.cancel).toHaveBeenLastCalledWith(expect.objectContaining({ target: expect.objectContaining({ voucherId: 'v2', organizationId: 'org-a' }) }));
  });

  it('công tắc còn tắt (LEGACY) ⇒ không số dư sổ tổng, nút khoá kèm câu giải thích', () => {
    h.ledgerData = ledger({ route: 'LEGACY', ready: false });
    view();
    expect(screen.queryByTestId('advance-balance')).toBeNull();
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
