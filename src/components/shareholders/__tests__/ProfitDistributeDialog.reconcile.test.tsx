// @vitest-environment jsdom
// Hộp CHỐT chi lợi nhuận + hook ghi THẬT (useSettleShareholderProfit: khoá chống gửi trùng, dấu chờ đối chiếu trong
// localStorage) với máy chủ GIẢ ở supabase.rpc. Lượt "Kiểm tra lại kết quả" (review chéo 18/11, R5):
//   - máy chủ trả PT409 PROFIT_LEDGER_SETTLE_CHANGED ⇒ lần gửi trước CHƯA ghi: xoá dấu chờ, hộp gỡ khoá, tải lại xem trước;
//   - lỗi khác (mất mạng, 55000) ⇒ chưa chứng minh được gì: vẫn khoá, vẫn đối chiếu bằng khoá cũ.
// Dữ liệu GIẢ.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ rpc: vi.fn(), maybeSingle: vi.fn(), refetch: vi.fn() }));
const ok = (data: unknown) => ({ data, status: 'success', fetchStatus: 'idle', isLoading: false, isError: false, isSuccess: true, isFetching: false, isPlaceholderData: false, error: null, refetch: m.refetch });

vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
vi.mock('sonner', () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor-a' }) }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: m.rpc, from: () => ({ select() { return this; }, eq() { return this; }, maybeSingle: m.maybeSingle }) },
}));
vi.mock('@/hooks/useAccounts', () => ({
  useAccounts: () => ok([{ id: 'a1', name: 'Quỹ chủ', code: 'Q1', is_virtual: false, organization_id: 'org-a' }]),
}));
// Đọc (E1 + R5) giả; lệnh GHI (W2) là hook thật gọi supabase.rpc ở trên.
const position = {
  unpaid_profit: 100_000, advance_outstanding: 40_000, advance_pending: 0, settlement_cash_pending: 0, balance: 60_000,
  settled: { recognized: 0, offset: 0, cash: 0 }, last_settled_through_month: null, marker_month: '2026-08-01',
  needs_review: { count: 0, suggested: 0 },
  components: { allocated: 100_000, payouts_pending: 0, payouts_approved: 40_000, salary_investment: 0, salary_advance_offset: 0, unpaid_profit_raw: 100_000, advance_outstanding_raw: 40_000, advance_overoffset: 0 },
};
vi.mock('@/hooks/profit-ledger/useProfitLedgerQueries', () => ({
  useShareholderProfitLedger: () => ok(undefined),
  useProfitSettlementPreview: (input: { shareholderId: string | null; throughMonth: string | null; accountId: string | null }) => (input.shareholderId
    ? ok({
        route: 'CANONICAL', shareholder_id: input.shareholderId,
        months: [{ month: '2026-10-01', allocated: 100_000, selectable: true, unpaid_through: 100_000 }],
        min_through_month: '2026-10-01', through_month: '2026-10-01', position,
        recognized_amount: 100_000, advance_offset_amount: 40_000, cash_amount: 60_000, advance_left: 0, advance_pending: 0,
        settlements: [], can_submit: !!input.accountId, blocked_reason: input.accountId ? null : 'ACCOUNT_REQUIRED',
      })
    : { ...ok(undefined), status: 'pending', isSuccess: false }),
}));
vi.mock('@/components/ui/searchable-select', () => ({
  SearchableSelect: ({ options, onValueChange, value, name, disabled }: { options: { value: string; label: string }[]; onValueChange: (s: string) => void; name: string; value: string; disabled?: boolean }) => (
    <select name={name} disabled={disabled} value={value} onChange={(e) => onValueChange(e.target.value)}>
      <option value="">Chọn</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  ),
}));

import ProfitDistributeDialog from '../ProfitDistributeDialog';

const LEDGER_ROWS = [{
  shareholder_id: 's', name: 'An', is_active: true, is_deleted: false, has_login: true, marker: null, allocated: 100_000,
  payouts_approved: 40_000, payouts_pending: 0, salary_investment: 0, salary_advance_offset: 0, balance: 60_000, status: 'OWED' as const,
  open_advance: 0, needs_review_count: 0,
}];
const LOST = { data: null, error: { code: '', message: 'FetchError: Failed to fetch' } };
const pendingKeys = () => Object.keys(localStorage).filter((k) => k.startsWith('ihome:financial-pending:'));
const keysSent = () => m.rpc.mock.calls.map((c) => (c[1] as { p_idempotency_key: string }).p_idempotency_key);
const onOpenChange = vi.fn();

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ProfitDistributeDialog open onOpenChange={onOpenChange} organizationId="org-a" ledgerRows={LEDGER_ROWS} defaultShareholderId="s" />
    </QueryClientProvider>,
  );
}

async function sendAndLoseResponse() {
  fireEvent.change(document.querySelector('[name="accountId"]')!, { target: { value: 'a1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Lập phiếu chờ duyệt' }));
  const check = await screen.findByRole('button', { name: 'Kiểm tra lại kết quả' });
  expect(pendingKeys()).toHaveLength(1);
  expect(m.rpc.mock.calls[0]![0]).toBe('shareholder_profit_settle_v1');
  return check;
}

beforeEach(() => {
  localStorage.clear();
  m.rpc.mockReset();
  m.refetch.mockReset();
  onOpenChange.mockReset();
});
afterEach(cleanup);

describe('hộp chốt + hook thật: lượt "Kiểm tra lại kết quả"', () => {
  it('máy chủ trả PT409 SETTLE_CHANGED ⇒ lần trước CHƯA ghi: xoá dấu chờ, gỡ khoá, tải lại xem trước, không tự gửi lại', async () => {
    m.rpc.mockResolvedValueOnce(LOST).mockResolvedValueOnce({
      data: null,
      error: {
        code: 'PT409', message: 'PROFIT_LEDGER_SETTLE_CHANGED: số liệu vừa đổi so với lúc xem trước — tải lại rồi xem trước lần nữa',
        details: '{"cash_amount": 55000, "expected_cash": 60000, "through_month": "2026-10-01", "recognized_amount": 100000, "expected_recognized": 100000, "advance_offset_amount": 45000}',
      },
    });
    renderDialog();
    const check = await sendAndLoseResponse();
    fireEvent.click(check);
    expect(await screen.findByText(/Số liệu vừa đổi so với lúc xem trước — chưa chốt gì/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Kiểm tra lại kết quả' })).toBeNull());
    expect((screen.getByRole('button', { name: 'Lập phiếu chờ duyệt' }) as HTMLButtonElement).disabled).toBe(false);
    expect((document.querySelector('[name="note"]')!.closest('fieldset') as HTMLFieldSetElement).disabled).toBe(false);
    expect(m.refetch).toHaveBeenCalled();
    expect(pendingKeys()).toEqual([]);
    expect(keysSent()).toHaveLength(2);
    expect(keysSent()[1]).toBe(keysSent()[0]); // đối chiếu bằng ĐÚNG khoá cũ
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it.each([
    ['mất mạng lần nữa', LOST],
    ['55000 sổ tổng đóng băng', { data: null, error: { code: '55000', message: 'PROFIT_LEDGER_FROZEN: sổ tổng lợi nhuận đang đóng băng' } }],
  ])('lượt đối chiếu gặp %s ⇒ vẫn khoá, vẫn giữ dấu chờ và khoá cũ', async (_name, reply) => {
    m.rpc.mockResolvedValueOnce(LOST).mockResolvedValue(reply);
    renderDialog();
    const check = await sendAndLoseResponse();
    fireEvent.click(check);
    await waitFor(() => expect(m.rpc).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('button', { name: 'Kiểm tra lại kết quả' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Lập phiếu chờ duyệt' })).toBeNull();
    expect(pendingKeys()).toHaveLength(1);
    expect(keysSent()[1]).toBe(keysSent()[0]);
    expect(m.refetch).not.toHaveBeenCalled();
  });
});
