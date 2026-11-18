// @vitest-environment jsdom
// Lớp dữ liệu sổ tổng: đúng tên RPC + tham số p_*, khoá chống gửi trùng (gửi lại CÙNG khoá khi bận /
// khi đối chiếu), danh sách làm mới đủ khoá.
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ rpc: vi.fn(), maybeSingle: vi.fn() }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor-a' }) }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: m.rpc,
    from: () => ({ select() { return this; }, eq() { return this; }, maybeSingle: m.maybeSingle }),
  },
}));

import {
  useMyProfitLedger, useMyShareholderPosition, useProfitLedgerMarkerPreview, useProfitLedgerPayoutDetail, useProfitManagerLedger,
  useProfitSettlementPreview, useProfitUnlockSalaryImpact, useShareholderAdvanceOptions,
  useShareholderAdvancePreview, useShareholderProfitLedger, useShareholderProfitLedgerEntries, useShareholderProfitPositions,
} from '../useProfitLedgerQueries';
import {
  PROFIT_LEDGER_INVALIDATE_KEYS, useCancelProfitLedgerPayout, useCreateShareholderAdvance,
  useResolveSalaryProfitLine, useSetProfitLedgerMarker, useSettleShareholderProfit, useVoidProfitSettlement,
} from '../useProfitLedgerMutations';
import { fetchSalaryProfitInputs, freezeSalaryProfitSettlement, quoteSalaryProfitPayout, salaryQuoteKey } from '@/lib/profitLedger/salaryProfitApi';
import { profitLedgerErrorMessage, ProfitLedgerPriorWrittenError } from '@/lib/profitLedger/errors';

const ORG = 'org-a';
const SH = 'sh-1';
let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
const pendingKeys = () => Object.keys(localStorage).filter((k) => k.startsWith('ihome:financial-pending:'));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  m.maybeSingle.mockResolvedValue({ data: { code: 'PC2611999', approval_status: 'UNAPPROVED', posting_status: 'UNPOSTED' }, error: null });
});
afterEach(cleanup);

describe('hook đọc gọi đúng RPC + tham số', () => {
  it('E1 / E2 / E10 / E7', async () => {
    m.rpc.mockImplementation(async (name: string) => {
      if (name === 'shareholder_profit_ledger_v1') return { data: { organization_id: ORG, route: 'LEGACY', as_of: '2026-11-15T00:00:00Z', shareholders: [] }, error: null };
      if (name === 'shareholder_profit_ledger_entries_v1') return { data: { organization_id: ORG, shareholder: { shareholder_id: SH, name: 'A', is_active: true, is_deleted: false, has_login: true }, marker: null, totals: { allocated: 0, payouts_approved: 0, payouts_pending: 0, salary_investment: 0, salary_advance_offset: 0, balance: 0, status: 'SETTLED', excluded_before_marker: { allocated: 0, payouts: 0, salary: 0 }, needs_review: { count: 0, suggested: 0 } }, entries: [] }, error: null };
      if (name === 'profit_manager_ledger_v1') return { data: { organization_id: ORG, route: 'LEGACY', as_of: '2026-11-15T00:00:00Z', managers: [] }, error: null };
      return { data: null, error: { code: '42501', message: 'PROFIT_LEDGER_FORBIDDEN: không xem được phiếu này' } };
    });
    const e1 = renderHook(() => useShareholderProfitLedger(ORG), { wrapper });
    const e2 = renderHook(() => useShareholderProfitLedgerEntries(ORG, SH), { wrapper });
    const e10 = renderHook(() => useProfitManagerLedger(ORG), { wrapper });
    const e7 = renderHook(() => useProfitLedgerPayoutDetail('v1'), { wrapper });
    await waitFor(() => expect(e1.result.current.data?.route).toBe('LEGACY'));
    await waitFor(() => expect(e2.result.current.data?.entries).toEqual([]));
    await waitFor(() => expect(e10.result.current.data?.managers).toEqual([]));
    await waitFor(() => expect(e7.result.current.isError).toBe(true));
    expect(m.rpc).toHaveBeenCalledWith('shareholder_profit_ledger_v1', { p_organization_id: ORG });
    expect(m.rpc).toHaveBeenCalledWith('shareholder_profit_ledger_entries_v1', { p_organization_id: ORG, p_shareholder_id: SH });
    expect(m.rpc).toHaveBeenCalledWith('profit_manager_ledger_v1', { p_organization_id: ORG });
    expect(m.rpc).toHaveBeenCalledWith('profit_ledger_payout_detail_v1', { p_voucher_id: 'v1' });
  });
  it('không có công ty ⇒ không gọi', () => {
    renderHook(() => useShareholderProfitLedger(null), { wrapper });
    renderHook(() => useMyProfitLedger(undefined), { wrapper });
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it('E3: 42501 PROFIT_LEDGER_FORBIDDEN ⇒ null (ẩn khối); lỗi khác vẫn ném', async () => {
    m.rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'PROFIT_LEDGER_FORBIDDEN: bạn chưa xem được lợi nhuận của mình ở công ty này' } });
    const hidden = renderHook(() => useMyProfitLedger(ORG), { wrapper });
    await waitFor(() => expect(hidden.result.current.isSuccess).toBe(true));
    expect(hidden.result.current.data).toBeNull();
    expect(m.rpc).toHaveBeenCalledWith('shareholder_profit_my_ledger_v1', { p_organization_id: ORG });
    client.clear();
    m.rpc.mockResolvedValueOnce({ data: null, error: { code: '55000', message: 'PROFIT_LEDGER_SHAREHOLDER_AMBIGUOUS: x' } });
    const failed = renderHook(() => useMyProfitLedger('org-b'), { wrapper });
    await waitFor(() => expect(failed.result.current.isError).toBe(true));
  });
  it('E8 gỡ mốc: tháng null; E14 mọi toà: không gửi khoá toà, có toà thì gửi đã sắp', async () => {
    m.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'profit_ledger_marker_preview_v1') return { data: { route: 'SHADOW', subject_kind: 'MANAGER', subject_id: 'm1', settled_through_month: null, current_marker: null, balance_now: 5, balance_after: 5, excluded: { allocated: 0, payouts: 0, salary: 0 }, advance_erased: 0, requires_acknowledge: false }, error: null };
      return { data: { organization_id: ORG, period_month: '2026-10-01', building_ids: args.p_building_ids ?? null, paid_via_salary: [], ledger_effects: [] }, error: null };
    });
    const e8 = renderHook(() => useProfitLedgerMarkerPreview({ organizationId: ORG, subjectKind: 'MANAGER', subjectId: 'm1', settledThroughMonth: null }), { wrapper });
    const all = renderHook(() => useProfitUnlockSalaryImpact({ organizationId: ORG, periodMonth: '2026-10-01', buildingIds: null }), { wrapper });
    const some = renderHook(() => useProfitUnlockSalaryImpact({ organizationId: ORG, periodMonth: '2026-10-01', buildingIds: ['b2', 'b1'] }), { wrapper });
    await waitFor(() => expect(e8.result.current.isSuccess && all.result.current.isSuccess && some.result.current.isSuccess).toBe(true));
    expect(m.rpc).toHaveBeenCalledWith('profit_ledger_marker_preview_v1', { p_organization_id: ORG, p_subject_kind: 'MANAGER', p_subject_id: 'm1', p_settled_through_month: null });
    expect(m.rpc).toHaveBeenCalledWith('profit_unlock_salary_impact_v1', { p_organization_id: ORG, p_period_month: '2026-10-01', p_building_ids: undefined });
    expect(m.rpc).toHaveBeenCalledWith('profit_unlock_salary_impact_v1', { p_organization_id: ORG, p_period_month: '2026-10-01', p_building_ids: ['b1', 'b2'] });
  });
});

describe('E6 / E9 / E16', () => {
  it('E6 gửi đủ p_voucher_id, p_reason (đã cắt), p_idempotency_key, p_expected_state', async () => {
    m.rpc.mockResolvedValue({ data: { voucher_id: 'v1', changed: true, cancellation_kind: 'CANCELLED_UNPOSTED', reversal_posting_id: null, balance_after: 10 }, error: null });
    const h = renderHook(() => useCancelProfitLedgerPayout(), { wrapper });
    await act(async () => { await h.result.current.mutateAsync({ voucherId: 'v1', organizationId: ORG, reason: '  Lập nhầm sổ quỹ  ', expectedState: 'PENDING' }); });
    expect(m.rpc).toHaveBeenCalledWith('profit_ledger_payout_cancel_v1', {
      p_voucher_id: 'v1', p_reason: 'Lập nhầm sổ quỹ', p_idempotency_key: expect.stringMatching(/^[0-9a-f-]{36}$/), p_expected_state: 'PENDING',
    });
  });
  it('E6 không bao giờ gửi kỳ vọng rỗng', async () => {
    const h = renderHook(() => useCancelProfitLedgerPayout(), { wrapper });
    await act(async () => { await expect(h.result.current.mutateAsync({ voucherId: 'v1', organizationId: ORG, reason: 'Lập nhầm sổ quỹ', expectedState: '' as never })).rejects.toBeTruthy(); });
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it('E9 gỡ mốc: tháng null + id mốc kỳ vọng null + cờ xác nhận', async () => {
    m.rpc.mockResolvedValue({ data: { marker_id: 'm9', settled_through_month: null, supersedes_id: null, balance_before: 0, balance_after: 0, advance_erased: 0 }, error: null });
    const h = renderHook(() => useSetProfitLedgerMarker(), { wrapper });
    await act(async () => { await h.result.current.mutateAsync({ organizationId: ORG, subjectKind: 'SHAREHOLDER', subjectId: SH, settledThroughMonth: null, reason: 'Gỡ mốc đặt nhầm tháng', expectedMarkerId: null, acknowledgeAdvanceErase: false }); });
    expect(m.rpc).toHaveBeenCalledWith('profit_ledger_set_marker_v1', expect.objectContaining({
      p_organization_id: ORG, p_subject_kind: 'SHAREHOLDER', p_subject_id: SH, p_settled_through_month: null, p_reason: 'Gỡ mốc đặt nhầm tháng',
      p_expected_marker_id: null, p_acknowledge_advance_erase: false,
    }));
  });
  it.each([
    {
      name: 'E6 huỷ', message: 'PROFIT_LEDGER_IDEMPOTENCY_REUSED: khoá chống gửi trùng đã dùng cho lệnh huỷ khác nội dung',
      run: async () => {
        const h = renderHook(() => useCancelProfitLedgerPayout(), { wrapper });
        return (reason: string) => h.result.current.mutateAsync({ voucherId: 'v1', organizationId: ORG, reason, expectedState: 'PENDING' });
      },
    },
    {
      name: 'E9 mốc', message: 'idempotency_key đã dùng với nội dung khác',
      run: async () => {
        const h = renderHook(() => useSetProfitLedgerMarker(), { wrapper });
        return (reason: string) => h.result.current.mutateAsync({ organizationId: ORG, subjectKind: 'SHAREHOLDER', subjectId: SH, settledThroughMonth: '2026-09-01', reason, expectedMarkerId: null, acknowledgeAdvanceErase: false });
      },
    },
    {
      name: 'E16 xác nhận lương', message: 'SALARY_PROFIT_IDEMPOTENCY_CONFLICT: khoá idempotency đã dùng với nội dung khác',
      run: async () => {
        const h = renderHook(() => useResolveSalaryProfitLine(), { wrapper });
        return (reason: string) => h.result.current.mutateAsync({ organizationId: ORG, lineId: 'l1', investment: 7, offset: 0, reason });
      },
    },
  ])('$name: đối chiếu gặp 23505 khoá-đã-dùng của chính lệnh ⇒ đã ghi, xoá dấu', async ({ run, message }) => {
    m.rpc
      .mockResolvedValueOnce({ data: null, error: { code: '', message: 'FetchError: Failed to fetch' } })
      .mockResolvedValueOnce({ data: null, error: { code: '23505', message } });
    const mutate = await run();
    await act(async () => { await expect(mutate('Lý do lần thứ nhất')).rejects.toMatchObject({ outcome: 'unknown' }); });
    expect(pendingKeys()).toHaveLength(1);
    await act(async () => { await expect(mutate('Lý do khác sau khi tải lại')).rejects.toBeInstanceOf(ProfitLedgerPriorWrittenError); });
    expect(m.rpc.mock.calls[1]![1].p_idempotency_key).toBe(m.rpc.mock.calls[0]![1].p_idempotency_key);
    expect(pendingKeys()).toEqual([]);
  });
  it('E16 gửi Y / D / lý do của dòng', async () => {
    m.rpc.mockResolvedValue({ data: { line_id: 'l1', shareholder_id: SH, salary_voucher_id: 'pl', period_month: '2026-09-01', investment_amount: 7, advance_offset_amount: 0, balance_before: 80, balance_after: 73 }, error: null });
    const h = renderHook(() => useResolveSalaryProfitLine(), { wrapper });
    await act(async () => { await h.result.current.mutateAsync({ organizationId: ORG, lineId: 'l1', investment: 7, offset: 0, reason: 'Đúng phần đầu tư tháng 9' }); });
    expect(m.rpc).toHaveBeenCalledWith('profit_ledger_salary_resolve_v1', expect.objectContaining({
      p_line_id: 'l1', p_investment_amount: 7, p_advance_offset_amount: 0, p_reason: 'Đúng phần đầu tư tháng 9',
    }));
  });
});

/* ───────────── Tạm ứng cổ đông + chốt chi lợi nhuận theo tháng (migration 20261118041911) ───────────── */

const position = (over: Record<string, unknown> = {}) => ({
  unpaid_profit: 100, advance_outstanding: 40, advance_pending: 5, settlement_cash_pending: 0, balance: 55,
  settled: { cash: 0, offset: 0, recognized: 0 }, last_settled_through_month: null, marker_month: null,
  needs_review: { count: 0, suggested: 0 },
  components: { allocated: 100, payouts_pending: 5, payouts_approved: 40, salary_investment: 0, salary_advance_offset: 0, unpaid_profit_raw: 100, advance_outstanding_raw: 40, advance_overoffset: 0 },
  ...over,
});
const r5 = (over: Record<string, unknown> = {}) => ({
  route: 'CANONICAL', shareholder_id: SH,
  months: [{ month: '2026-09-01', allocated: 60, selectable: true, unpaid_through: 60 }, { month: '2026-10-01', allocated: 40, selectable: true, unpaid_through: 100 }],
  min_through_month: '2026-09-01', through_month: '2026-10-01', recognized_amount: 100, advance_offset_amount: 40, cash_amount: 60,
  advance_left: 0, advance_pending: 5, can_submit: false, blocked_reason: 'ACCOUNT_REQUIRED', settlements: [], position: position(), ...over,
});
const w1 = (over: Record<string, unknown> = {}) => ({
  state: 'PENDING_APPROVAL', amount: 500000, within_amount: 0, advance_amount: 500000, balance_before: null, maker_kind: 'CUSTODIAN_FOR_PAYEE',
  payout_kind: 'ADVANCE', warnings: [{ code: 'ADVANCE', advance_amount: 500000 }, { code: 'NEEDS_OWNER_APPROVAL' }],
  voucher_id: 'v-adv', approval_request_id: 'r-adv', shareholder_id: SH, ...over,
});
const w2 = (over: Record<string, unknown> = {}) => ({
  state: 'PENDING_APPROVAL', settlement_id: 'st-1', through_month: '2026-10-01', recognized_amount: 100, advance_offset_amount: 40,
  cash_amount: 60, voucher_id: 'v-cash', approval_request_id: 'r-cash', ...over,
});
const advanceInput = { organizationId: ORG, shareholderId: SH, amount: 500000, accountId: 'acc-1', voucherDate: '2026-11-18', note: '  ' };
const settleInput = { organizationId: ORG, shareholderId: SH, throughMonth: '2026-10-01', expectedRecognized: 100, expectedCash: 60, accountId: 'acc-1', voucherDate: '2026-11-18', note: null };

describe('tạm ứng + chốt: hook đọc gọi đúng RPC + tham số', () => {
  it('R1 / R2 / R3: chỉ gửi p_organization_id, gọi kiểu mặc định (POST) — không có đối số thứ ba', async () => {
    m.rpc.mockImplementation(async (name: string) => {
      if (name === 'shareholder_profit_positions_v1') return { data: { organization_id: ORG, route: 'CANONICAL', as_of: '2026-11-18T00:00:00Z', shareholders: [{ shareholder_id: SH, name: 'A', is_active: true, is_deleted: false, has_login: true, has_advance_right: true, ...position() }] }, error: null };
      if (name === 'shareholder_profit_my_position_v1') return { data: { organization_id: ORG, route: 'CANONICAL', shareholder: { id: SH, name: 'A' }, ...position(), settlements: [] }, error: null };
      return { data: { route: 'CANONICAL', can_create: true, accounts: [{ account_id: 'acc-1', name: 'Sổ giữ' }], payees: [{ shareholder_id: SH, name: 'A', is_self: false }], advance_type: { id: 't1', name: 'Tạm Ứng' } }, error: null };
    });
    const positions = renderHook(() => useShareholderProfitPositions(ORG), { wrapper });
    const mine = renderHook(() => useMyShareholderPosition(ORG), { wrapper });
    const options = renderHook(() => useShareholderAdvanceOptions(ORG), { wrapper });
    await waitFor(() => expect(positions.result.current.data?.shareholders[0]?.unpaid_profit).toBe(100));
    await waitFor(() => expect(mine.result.current.data?.advance_outstanding).toBe(40));
    await waitFor(() => expect(options.result.current.data?.can_create).toBe(true));
    expect(m.rpc).toHaveBeenCalledWith('shareholder_profit_positions_v1', { p_organization_id: ORG });
    expect(m.rpc).toHaveBeenCalledWith('shareholder_profit_my_position_v1', { p_organization_id: ORG });
    expect(m.rpc).toHaveBeenCalledWith('shareholder_profit_advance_options_v1', { p_organization_id: ORG });
    // R1 / R3 là hàm VOLATILE: thêm { get: true } là máy chủ trả 25006.
    for (const call of m.rpc.mock.calls) expect(call).toHaveLength(2);
  });
  it('R2 / R3: 42501 PROFIT_LEDGER_FORBIDDEN ⇒ null (ẩn khối / không có chế độ Tạm Ứng); lỗi khác vẫn ném', async () => {
    m.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'PROFIT_LEDGER_FORBIDDEN: bạn không thuộc công ty này' } });
    const mine = renderHook(() => useMyShareholderPosition(ORG), { wrapper });
    const options = renderHook(() => useShareholderAdvanceOptions(ORG), { wrapper });
    await waitFor(() => expect(mine.result.current.isSuccess && options.result.current.isSuccess).toBe(true));
    expect(mine.result.current.data).toBeNull();
    expect(options.result.current.data).toBeNull();
    client.clear();
    m.rpc.mockResolvedValue({ data: null, error: { code: 'XX000', message: 'PROFIT_LEDGER_POSITION_DRIFT: x' } });
    const drift = renderHook(() => useMyShareholderPosition('org-b'), { wrapper });
    const broken = renderHook(() => useShareholderAdvanceOptions('org-b'), { wrapper });
    await waitFor(() => expect(drift.result.current.isError && broken.result.current.isError).toBe(true));
  });
  it('R1 không tự nuốt lỗi quyền; không có công ty / bị tắt ⇒ không gọi', async () => {
    renderHook(() => useShareholderProfitPositions(null), { wrapper });
    renderHook(() => useShareholderAdvanceOptions(ORG, { enabled: false }), { wrapper });
    expect(m.rpc).not.toHaveBeenCalled();
    m.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'PROFIT_LEDGER_FORBIDDEN: bạn không có quyền xem sổ tổng lợi nhuận của công ty này' } });
    const h = renderHook(() => useShareholderProfitPositions(ORG), { wrapper });
    await waitFor(() => expect(h.result.current.isError).toBe(true));
  });
  it('R4 chưa nhập số tiền / chưa chọn sổ: p_amount / p_account_id = null; người lập hộ nhận position = null', async () => {
    m.rpc.mockResolvedValue({ data: { route: 'CANONICAL', shareholder_id: SH, maker_kind: 'CUSTODIAN_FOR_PAYEE', payee_is_maker: false, can_submit: false, blocked_reason: null, warnings: [], position: null }, error: null });
    const h = renderHook(() => useShareholderAdvancePreview({ shareholderId: SH, amount: Number.NaN, accountId: null }), { wrapper });
    await waitFor(() => expect(h.result.current.isSuccess).toBe(true));
    expect(h.result.current.data).toMatchObject({ position: null, can_submit: false });
    expect(m.rpc).toHaveBeenCalledWith('shareholder_profit_advance_preview_v1', { p_shareholder_id: SH, p_amount: null, p_account_id: null });
    expect(m.rpc.mock.calls[0]).toHaveLength(2);
  });
  it('R5 không truyền tháng: p_through_month = null (máy chủ chọn); chọn tháng + sổ thì gửi đúng', async () => {
    m.rpc.mockImplementation(async (_name: string, args: Record<string, unknown>) => (args.p_through_month === null
      ? { data: r5(), error: null }
      : { data: r5({ through_month: '2026-09-01', recognized_amount: 60, advance_offset_amount: 40, cash_amount: 20, can_submit: true, blocked_reason: null }), error: null }));
    const auto = renderHook(() => useProfitSettlementPreview({ shareholderId: SH, throughMonth: null, accountId: null }), { wrapper });
    const picked = renderHook(() => useProfitSettlementPreview({ shareholderId: SH, throughMonth: '2026-09-01', accountId: 'acc-1' }), { wrapper });
    await waitFor(() => expect(auto.result.current.data?.through_month).toBe('2026-10-01'));
    await waitFor(() => expect(picked.result.current.data?.cash_amount).toBe(20));
    expect(m.rpc).toHaveBeenCalledWith('shareholder_profit_settlement_preview_v1', { p_shareholder_id: SH, p_through_month: null, p_account_id: null });
    expect(m.rpc).toHaveBeenCalledWith('shareholder_profit_settlement_preview_v1', { p_shareholder_id: SH, p_through_month: '2026-09-01', p_account_id: 'acc-1' });
  });
});

describe('W1 lập phiếu tạm ứng', () => {
  it('đúng tên RPC + sáu tham số (không có cờ xác nhận tạm ứng); mã phiếu đọc lại; khoá gắn công ty của cổ đông', async () => {
    m.rpc.mockImplementation(async (_name: string, args: Record<string, unknown>) => {
      const records = pendingKeys().map((k) => JSON.parse(localStorage.getItem(k)!));
      expect(records).toHaveLength(1);
      expect(args.p_idempotency_key).toBe(records[0].requestKey);
      expect(records[0]).toMatchObject({ userId: 'actor-a', organizationId: ORG, businessKey: `shareholder:${SH}` });
      return { data: w1(), error: null };
    });
    const h = renderHook(() => useCreateShareholderAdvance(), { wrapper });
    let result: Awaited<ReturnType<typeof h.result.current.mutateAsync>> | undefined;
    await act(async () => { result = await h.result.current.mutateAsync(advanceInput); });
    expect(m.rpc).toHaveBeenCalledTimes(1);
    expect(m.rpc.mock.calls[0]![0]).toBe('shareholder_profit_advance_v1');
    expect(Object.keys(m.rpc.mock.calls[0]![1]).sort()).toEqual(['p_account_id', 'p_amount', 'p_idempotency_key', 'p_note', 'p_shareholder_id', 'p_voucher_date']);
    expect(m.rpc.mock.calls[0]![1]).toMatchObject({ p_shareholder_id: SH, p_amount: 500000, p_account_id: 'acc-1', p_voucher_date: '2026-11-18', p_note: null });
    expect(result).toMatchObject({ voucher_id: 'v-adv', code: 'PC2611999', advance_amount: 500000, balance_before: null, maker_kind: 'CUSTODIAN_FOR_PAYEE' });
    expect(pendingKeys()).toEqual([]);
  });
  it('từ chối chắc chắn (người nhận chưa có quyền) ⇒ trả nguyên lỗi, không giữ dấu chờ', async () => {
    const failure = { code: '42501', message: 'PROFIT_LEDGER_ADVANCE_PAYEE_NO_RIGHT: người nhận chưa được cấp quyền tạm ứng' };
    m.rpc.mockResolvedValue({ data: null, error: failure });
    const h = renderHook(() => useCreateShareholderAdvance(), { wrapper });
    await act(async () => { await expect(h.result.current.mutateAsync(advanceInput)).rejects.toBe(failure); });
    expect(m.rpc).toHaveBeenCalledTimes(1);
    expect(pendingKeys()).toEqual([]);
  });
  it('biên nhận lệch hợp đồng (có phần "trong số dư") ⇒ chưa rõ kết quả; lần sau đối chiếu bằng ĐÚNG khoá cũ', async () => {
    m.rpc.mockResolvedValueOnce({ data: w1({ within_amount: 100000, advance_amount: 400000 }), error: null }).mockResolvedValueOnce({ data: w1(), error: null });
    const h = renderHook(() => useCreateShareholderAdvance(), { wrapper });
    await act(async () => { await expect(h.result.current.mutateAsync(advanceInput)).rejects.toMatchObject({ outcome: 'unknown' }); });
    expect(pendingKeys()).toHaveLength(1);
    await act(async () => { await expect(h.result.current.mutateAsync(advanceInput)).resolves.toMatchObject({ voucher_id: 'v-adv' }); });
    expect(m.rpc.mock.calls[1]![1].p_idempotency_key).toBe(m.rpc.mock.calls[0]![1].p_idempotency_key);
    expect(pendingKeys()).toEqual([]);
  });
  // Luồng chống gửi trùng dùng chung của mọi lệnh ghi sổ tổng (runLedgerWrite) — kiểm qua W1.
  it('kẹt khoá chéo 40P01 ⇒ tự gửi lại với CÙNG khoá', async () => {
    m.rpc.mockResolvedValueOnce({ data: null, error: { code: '40P01', message: 'deadlock detected' } }).mockResolvedValueOnce({ data: w1(), error: null });
    const h = renderHook(() => useCreateShareholderAdvance(), { wrapper });
    await act(async () => { await h.result.current.mutateAsync(advanceInput); });
    expect(m.rpc).toHaveBeenCalledTimes(2);
    expect(m.rpc.mock.calls[0]![1].p_idempotency_key).toBe(m.rpc.mock.calls[1]![1].p_idempotency_key);
  });
  it('chưa rõ kết quả (mất mạng) ⇒ giữ dấu; mở lại trang, lần sau đối chiếu bằng ĐÚNG khoá cũ rồi mới nhả', async () => {
    m.rpc.mockResolvedValueOnce({ data: null, error: { code: '', message: 'FetchError: Failed to fetch' } }).mockResolvedValueOnce({ data: w1(), error: null });
    const h = renderHook(() => useCreateShareholderAdvance(), { wrapper });
    await act(async () => { await expect(h.result.current.mutateAsync(advanceInput)).rejects.toMatchObject({ outcome: 'unknown' }); });
    expect(pendingKeys()).toHaveLength(1);
    const firstKey = m.rpc.mock.calls[0]![1].p_idempotency_key;
    h.unmount();
    const again = renderHook(() => useCreateShareholderAdvance(), { wrapper });
    await act(async () => { await expect(again.result.current.mutateAsync(advanceInput)).resolves.toMatchObject({ voucher_id: 'v-adv' }); });
    expect(m.rpc.mock.calls[1]![1].p_idempotency_key).toBe(firstKey);
    expect(pendingKeys()).toEqual([]);
  });
  it('đã ghi nhưng mất phản hồi, tải lại trang rồi gửi KHÁC nội dung ⇒ 23505 ⇒ báo đã ghi, xoá dấu, lần sau khoá mới', async () => {
    m.rpc
      .mockResolvedValueOnce({ data: null, error: { code: '', message: 'FetchError: Failed to fetch' } })
      .mockResolvedValueOnce({ data: null, error: { code: '23505', message: 'idempotency_key đã dùng với nội dung khác' } })
      .mockResolvedValueOnce({ data: w1({ amount: 1, advance_amount: 1, warnings: [{ code: 'ADVANCE', advance_amount: 1 }, { code: 'NEEDS_OWNER_APPROVAL' }] }), error: null });
    const h = renderHook(() => useCreateShareholderAdvance(), { wrapper });
    await act(async () => { await expect(h.result.current.mutateAsync(advanceInput)).rejects.toMatchObject({ outcome: 'unknown' }); });
    const firstKey = m.rpc.mock.calls[0]![1].p_idempotency_key;
    h.unmount(); // tải lại trang: chỉ còn dấu chờ trong localStorage
    const again = renderHook(() => useCreateShareholderAdvance(), { wrapper });
    let failure: unknown;
    await act(async () => { failure = await again.result.current.mutateAsync({ ...advanceInput, amount: 1 }).catch((e: unknown) => e); });
    expect(failure).toBeInstanceOf(ProfitLedgerPriorWrittenError);
    expect(profitLedgerErrorMessage(failure, 'advance')).toMatchObject({ kind: 'PRIOR_WRITTEN', reload: true });
    expect(profitLedgerErrorMessage(failure, 'advance').message).toMatch(/^Yêu cầu trước đó đã được ghi; tải lại để xem/);
    expect(m.rpc.mock.calls[1]![1].p_idempotency_key).toBe(firstKey); // đối chiếu bằng ĐÚNG khoá cũ
    expect(pendingKeys()).toEqual([]);
    await act(async () => { await expect(again.result.current.mutateAsync({ ...advanceInput, amount: 1 })).resolves.toMatchObject({ voucher_id: 'v-adv' }); });
    expect(m.rpc).toHaveBeenCalledTimes(3);
    expect(m.rpc.mock.calls[2]![1].p_idempotency_key).not.toBe(firstKey); // lệnh mới, khoá mới
    expect(pendingKeys()).toEqual([]);
  });
  it('đối chiếu gặp 23505 KHÁC (trùng khoá bảng / mã của lệnh khác) ⇒ vẫn khoá, vẫn khoá cũ', async () => {
    m.rpc
      .mockResolvedValueOnce({ data: null, error: { code: '', message: 'FetchError: Failed to fetch' } })
      .mockResolvedValueOnce({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "income_expenses_code_key"' } })
      .mockResolvedValueOnce({ data: null, error: { code: '23505', message: 'PROFIT_LEDGER_IDEMPOTENCY_REUSED: khoá chống gửi trùng đã dùng cho lệnh huỷ khác nội dung' } });
    const h = renderHook(() => useCreateShareholderAdvance(), { wrapper });
    await act(async () => { await expect(h.result.current.mutateAsync(advanceInput)).rejects.toMatchObject({ outcome: 'unknown' }); });
    const firstKey = m.rpc.mock.calls[0]![1].p_idempotency_key;
    await act(async () => { await expect(h.result.current.mutateAsync({ ...advanceInput, amount: 1 })).rejects.toMatchObject({ outcome: 'unknown' }); });
    await act(async () => { await expect(h.result.current.mutateAsync({ ...advanceInput, amount: 1 })).rejects.toMatchObject({ outcome: 'unknown' }); });
    expect(m.rpc.mock.calls.map((c) => c[1].p_idempotency_key)).toEqual([firstKey, firstKey, firstKey]);
    expect(pendingKeys()).toHaveLength(1);
  });
  it('làm mới đủ các khoá sau khi ghi (kể cả khi lỗi)', async () => {
    const spy = vi.spyOn(client, 'invalidateQueries');
    m.rpc.mockResolvedValue({ data: null, error: { code: '55000', message: 'PROFIT_LEDGER_ROUTE_OFF: x' } });
    const h = renderHook(() => useCreateShareholderAdvance(), { wrapper });
    await act(async () => { await expect(h.result.current.mutateAsync(advanceInput)).rejects.toBeTruthy(); });
    const keys = spy.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));
    for (const key of PROFIT_LEDGER_INVALIDATE_KEYS) expect(keys).toContain(JSON.stringify(key));
    for (const key of ['profit-ledger', 'profit-ledger-entries', 'my-profit-ledger', 'profit-manager-ledger', 'manager-ledger-payouts', 'income-expenses', 'accounts-with-balance', 'pending-approvals', 'manager-salary', 'cash-flow-by-day']) {
      expect(keys).toContain(JSON.stringify([key]));
    }
    // Khoá xem trước của hộp chi cũ đã bỏ cùng hook của nó.
    expect(keys).not.toContain(JSON.stringify(['profit-payout-preview']));
  });
});

describe('W2 chốt chi lợi nhuận / W3 huỷ lần chốt', () => {
  it('W2 gửi CẢ p_expected_recognized và p_expected_cash đúng số đã xem; có tiền thì gửi sổ + ngày', async () => {
    m.rpc.mockResolvedValue({ data: w2(), error: null });
    const h = renderHook(() => useSettleShareholderProfit(), { wrapper });
    let result: Awaited<ReturnType<typeof h.result.current.mutateAsync>> | undefined;
    await act(async () => { result = await h.result.current.mutateAsync(settleInput); });
    expect(m.rpc).toHaveBeenCalledWith('shareholder_profit_settle_v1', {
      p_shareholder_id: SH, p_through_month: '2026-10-01', p_account_id: 'acc-1', p_voucher_date: '2026-11-18', p_note: null,
      p_expected_recognized: 100, p_expected_cash: 60, p_idempotency_key: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(result).toMatchObject({ settlement_id: 'st-1', state: 'PENDING_APPROVAL', voucher_id: 'v-cash', code: 'PC2611999' });
  });
  it('W2 không ra tiền: sổ / ngày gửi null dù form còn giá trị; không đọc mã phiếu', async () => {
    m.rpc.mockResolvedValue({ data: w2({ state: 'SETTLED', recognized_amount: 80, advance_offset_amount: 80, cash_amount: 0, voucher_id: null, approval_request_id: null }), error: null });
    const h = renderHook(() => useSettleShareholderProfit(), { wrapper });
    let result: Awaited<ReturnType<typeof h.result.current.mutateAsync>> | undefined;
    await act(async () => { result = await h.result.current.mutateAsync({ ...settleInput, expectedRecognized: 80, expectedCash: 0 }); });
    expect(m.rpc.mock.calls[0]![1]).toMatchObject({ p_account_id: null, p_voucher_date: null, p_expected_recognized: 80, p_expected_cash: 0 });
    expect(result).toMatchObject({ state: 'SETTLED', voucher_id: null, code: null });
    expect(m.maybeSingle).not.toHaveBeenCalled();
  });
  it('W2 PT409 (số liệu vừa đổi) ⇒ trả nguyên lỗi, KHÔNG tự gửi lại, không giữ dấu chờ', async () => {
    const failure = { code: 'PT409', message: 'PROFIT_LEDGER_SETTLE_CHANGED: số liệu vừa đổi so với lúc xem trước — tải lại rồi xem trước lần nữa', details: '{"cash_amount": 40, "expected_cash": 60}' };
    m.rpc.mockResolvedValue({ data: null, error: failure });
    const h = renderHook(() => useSettleShareholderProfit(), { wrapper });
    await act(async () => { await expect(h.result.current.mutateAsync(settleInput)).rejects.toBe(failure); });
    expect(m.rpc).toHaveBeenCalledTimes(1);
    expect(pendingKeys()).toEqual([]);
    expect(profitLedgerErrorMessage(failure, 'settle')).toMatchObject({ kind: 'SETTLE_CHANGED', reload: true });
  });
  it.each([
    ['thiếu phần ghi nhận', { expectedRecognized: Number.NaN }],
    ['phần ghi nhận ≤ 0', { expectedRecognized: 0 }],
    ['thực chi âm', { expectedCash: -1 }],
    ['thiếu tháng', { throughMonth: '' }],
  ])('W2 %s ⇒ không gọi máy chủ', async (_name, over) => {
    const h = renderHook(() => useSettleShareholderProfit(), { wrapper });
    await act(async () => { await expect(h.result.current.mutateAsync({ ...settleInput, ...over })).rejects.toBeTruthy(); });
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it('W3 gửi mã lần chốt, lý do (đã cắt) và khoá', async () => {
    m.rpc.mockResolvedValue({ data: { state: 'VOID', settlement_id: 'st-1' }, error: null });
    const h = renderHook(() => useVoidProfitSettlement(), { wrapper });
    await act(async () => { await h.result.current.mutateAsync({ organizationId: ORG, settlementId: 'st-1', reason: '  Chốt nhầm tháng  ' }); });
    expect(m.rpc).toHaveBeenCalledWith('shareholder_profit_settlement_void_v1', {
      p_settlement_id: 'st-1', p_reason: 'Chốt nhầm tháng', p_idempotency_key: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });
  it.each([
    { name: 'W1 tạm ứng', run: async () => { const h = renderHook(() => useCreateShareholderAdvance(), { wrapper }); return (note: string) => h.result.current.mutateAsync({ ...advanceInput, note }); } },
    { name: 'W2 chốt', run: async () => { const h = renderHook(() => useSettleShareholderProfit(), { wrapper }); return (note: string) => h.result.current.mutateAsync({ ...settleInput, note }); } },
    { name: 'W3 huỷ chốt', run: async () => { const h = renderHook(() => useVoidProfitSettlement(), { wrapper }); return (note: string) => h.result.current.mutateAsync({ organizationId: ORG, settlementId: 'st-1', reason: note }); } },
  ])('$name: đối chiếu gặp 23505 khoá-đã-dùng của chính lệnh ⇒ đã ghi, xoá dấu', async ({ run }) => {
    m.rpc
      .mockResolvedValueOnce({ data: null, error: { code: '', message: 'FetchError: Failed to fetch' } })
      .mockResolvedValueOnce({ data: null, error: { code: '23505', message: 'idempotency_key đã dùng với nội dung khác' } });
    const mutate = await run();
    await act(async () => { await expect(mutate('Ghi chú lần thứ nhất')).rejects.toMatchObject({ outcome: 'unknown' }); });
    expect(pendingKeys()).toHaveLength(1);
    await act(async () => { await expect(mutate('Ghi chú khác sau khi tải lại')).rejects.toBeInstanceOf(ProfitLedgerPriorWrittenError); });
    expect(m.rpc.mock.calls[1]![1].p_idempotency_key).toBe(m.rpc.mock.calls[0]![1].p_idempotency_key);
    expect(pendingKeys()).toEqual([]);
  });
  it('làm mới cả khoá vị thế / xem trước sau khi ghi', async () => {
    const spy = vi.spyOn(client, 'invalidateQueries');
    m.rpc.mockResolvedValue({ data: w1(), error: null });
    const h = renderHook(() => useCreateShareholderAdvance(), { wrapper });
    await act(async () => { await h.result.current.mutateAsync(advanceInput); });
    const keys = spy.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));
    for (const key of ['profit-positions', 'my-profit-position', 'profit-advance-options', 'profit-advance-preview', 'profit-settlement-preview', 'profit-ledger', 'my-profit-ledger', 'pending-approvals', 'income-expenses']) {
      expect(keys).toContain(JSON.stringify([key]));
    }
  });
});

describe('phần lương: E12 / E13 / E15', () => {
  const staff = (id: string) => ({
    staff_id: id, organization_id: ORG, shareholder_id: null, sheet_status: 'NONE', profit_draft: false, allocations: [], by_building: [],
    allocated_total: 0, investment_month: 0, investment_cap: 0, marker_through: null, settled_by_marker: false, settlement: null, paid_lines: [],
    paid_investment: 0, paid_offset: 0, advance_open: 0, advance_offset_month: 0, suggested_advance_offset: 0, remaining_offset: 0,
    offset_conflict: false, needs_review: { count: 0, suggested: 0 },
  });
  it('E12: danh sách rỗng không gọi; > 200 người chia lô, giữ thứ tự', async () => {
    await expect(fetchSalaryProfitInputs('2026-10-01', [])).resolves.toEqual({ period_month: '2026-10-01', staff: [] });
    expect(m.rpc).not.toHaveBeenCalled();
    const ids = Array.from({ length: 201 }, (_, i) => `s${i}`);
    m.rpc.mockImplementation(async (_name: string, args: { p_staff_ids: string[] }) => ({ data: { period_month: '2026-10-01', staff: args.p_staff_ids.map(staff) }, error: null }));
    const result = await fetchSalaryProfitInputs('2026-10-01', ids);
    expect(m.rpc).toHaveBeenCalledTimes(2);
    expect(m.rpc.mock.calls[0]![0]).toBe('salary_profit_inputs_v1');
    expect(result.staff.map((s) => s.staff_id)).toEqual(ids);
  });
  it('E13: p_max_offset null khi để máy chủ tính; E15: khoá báo giá mới, khoá trả lương giữ nguyên', async () => {
    m.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'salary_profit_settlement_freeze_v1') return { data: { shareholder_id: null, staff_id: 's1', period_month: '2026-10-01', organization_id: ORG, settlement_id: null }, error: null };
      return { data: { quote_id: null, shareholder_id: null, staff_id: 's1', period_month: '2026-10-01', organization_id: ORG, echoed: args.p_payout_idempotency_key }, error: null };
    });
    await freezeSalaryProfitSettlement({ staffId: 's1', periodMonth: '2026-10-01', expectedInvestment: 0, maxOffset: null, expectedTakeHome: 5_000_000, idempotencyKey: 'req-12345678:fz:s1' });
    expect(m.rpc).toHaveBeenCalledWith('salary_profit_settlement_freeze_v1', {
      p_staff_id: 's1', p_period_month: '2026-10-01', p_expected_investment: 0, p_max_offset: null, p_expected_take_home: 5_000_000, p_idempotency_key: 'req-12345678:fz:s1',
    });
    const k1 = salaryQuoteKey('K-12345678');
    const k2 = salaryQuoteKey('K-12345678');
    expect(k1).not.toBe(k2);
    expect(k1).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/);
    await quoteSalaryProfitPayout({ staffId: 's1', periodMonth: '2026-10-01', investmentSelected: 0, offsetSelected: 0, expectedVoucherAmount: 5_000_000, payoutKey: 'K-12345678', idempotencyKey: k1 });
    expect(m.rpc).toHaveBeenLastCalledWith('salary_profit_payout_quote_v1', expect.objectContaining({ p_payout_idempotency_key: 'K-12345678', p_idempotency_key: k1 }));
  });
  it('E15 lỗi ⇒ ném nguyên lỗi để lớp gọi dừng, không lập phiếu lương', async () => {
    const failure = { code: 'PT409', message: 'SALARY_PROFIT_QUOTE_CHANGED: x' };
    m.rpc.mockResolvedValue({ data: null, error: failure });
    await expect(quoteSalaryProfitPayout({ staffId: 's1', periodMonth: '2026-10-01', investmentSelected: 1, offsetSelected: 0, expectedVoucherAmount: 1, payoutKey: 'K-12345678', idempotencyKey: 'K-12345678:q:abc12345' })).rejects.toBe(failure);
  });
});
