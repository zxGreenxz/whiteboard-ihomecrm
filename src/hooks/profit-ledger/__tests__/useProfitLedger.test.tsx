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
  useMyProfitLedger, useProfitLedgerMarkerPreview, useProfitLedgerPayoutDetail, useProfitManagerLedger,
  useProfitPayoutPreview, useProfitUnlockSalaryImpact, useShareholderProfitLedger, useShareholderProfitLedgerEntries,
} from '../useProfitLedgerQueries';
import {
  PROFIT_LEDGER_INVALIDATE_KEYS, useCancelProfitLedgerPayout, useCreateProfitLedgerPayout, useResolveSalaryProfitLine,
  useSetProfitLedgerMarker,
} from '../useProfitLedgerMutations';
import { fetchSalaryProfitInputs, freezeSalaryProfitSettlement, quoteSalaryProfitPayout, salaryQuoteKey } from '@/lib/profitLedger/salaryProfitApi';

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

const e5 = (over: Record<string, unknown> = {}) => ({
  voucher_id: 'v9', approval_request_id: 'r9', shareholder_id: SH, amount: 500000, within_amount: 500000, advance_amount: 0,
  balance_before: 1000000, warnings: [{ code: 'NEEDS_OWNER_APPROVAL' }], maker_kind: 'OWNER', state: 'PENDING_APPROVAL', ...over,
});
const payoutInput = { organizationId: ORG, shareholderId: SH, amount: 500000, accountId: 'acc-1', voucherDate: '2026-11-15', note: '  ', allowAdvance: false };

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
  it('E4 xem số dư khi CHƯA nhập số tiền: p_amount / p_account_id = null', async () => {
    m.rpc.mockResolvedValue({ data: { route: 'LEGACY', shareholder_id: SH, maker_kind: 'OWNER', payee_is_maker: false, balance_before: 100, within_amount: null, advance_amount: null, open_estimate: 0, warnings: [], requires_owner_approval: true, can_submit: false, blocked_reason: 'ROUTE', needs_review: { count: 0, suggested: 0 } }, error: null });
    const h = renderHook(() => useProfitPayoutPreview({ shareholderId: SH, amount: Number.NaN, accountId: null }), { wrapper });
    await waitFor(() => expect(h.result.current.data?.blocked_reason).toBe('ROUTE'));
    expect(m.rpc).toHaveBeenCalledWith('shareholder_profit_payout_preview_v1', { p_shareholder_id: SH, p_amount: null, p_account_id: null });
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

describe('E5 lập phiếu chi lợi nhuận', () => {
  it('đúng tên RPC + tham số; khoá = khoá đã lưu trước khi gọi; mã phiếu đọc lại', async () => {
    m.rpc.mockImplementation(async (_name: string, args: Record<string, unknown>) => {
      const records = pendingKeys().map((k) => JSON.parse(localStorage.getItem(k)!));
      expect(records).toHaveLength(1);
      expect(args.p_idempotency_key).toBe(records[0].requestKey);
      expect(records[0]).toMatchObject({ userId: 'actor-a', organizationId: ORG, businessKey: `shareholder:${SH}` });
      return { data: e5(), error: null };
    });
    const h = renderHook(() => useCreateProfitLedgerPayout(), { wrapper });
    let result: Awaited<ReturnType<typeof h.result.current.mutateAsync>> | undefined;
    await act(async () => { result = await h.result.current.mutateAsync(payoutInput); });
    expect(m.rpc).toHaveBeenCalledWith('shareholder_profit_ledger_payout_v1', expect.objectContaining({
      p_shareholder_id: SH, p_amount: 500000, p_account_id: 'acc-1', p_voucher_date: '2026-11-15', p_note: null, p_allow_advance: false,
    }));
    expect(result).toMatchObject({ voucher_id: 'v9', code: 'PC2611999', within_amount: 500000, advance_amount: 0 });
    expect(pendingKeys()).toEqual([]);
  });
  it('kẹt khoá chéo 40P01 ⇒ tự gửi lại với CÙNG khoá', async () => {
    m.rpc.mockResolvedValueOnce({ data: null, error: { code: '40P01', message: 'deadlock detected' } }).mockResolvedValueOnce({ data: e5(), error: null });
    const h = renderHook(() => useCreateProfitLedgerPayout(), { wrapper });
    await act(async () => { await h.result.current.mutateAsync(payoutInput); });
    expect(m.rpc).toHaveBeenCalledTimes(2);
    expect(m.rpc.mock.calls[0]![1].p_idempotency_key).toBe(m.rpc.mock.calls[1]![1].p_idempotency_key);
  });
  it('ADVANCE_CONFIRM (22023) ⇒ trả nguyên lỗi, KHÔNG tự gọi lần hai', async () => {
    const failure = { code: '22023', message: 'PROFIT_LEDGER_ADVANCE_CONFIRM: x', details: '{"balance":100,"within":100,"advance":20}' };
    m.rpc.mockResolvedValue({ data: null, error: failure });
    const h = renderHook(() => useCreateProfitLedgerPayout(), { wrapper });
    await act(async () => { await expect(h.result.current.mutateAsync(payoutInput)).rejects.toBe(failure); });
    expect(m.rpc).toHaveBeenCalledTimes(1);
    expect(pendingKeys()).toEqual([]);
  });
  it('chưa rõ kết quả ⇒ giữ dấu; lần sau đối chiếu bằng ĐÚNG khoá cũ rồi mới nhả', async () => {
    m.rpc.mockResolvedValueOnce({ data: null, error: { code: '', message: 'FetchError: Failed to fetch' } }).mockResolvedValueOnce({ data: e5(), error: null });
    const h = renderHook(() => useCreateProfitLedgerPayout(), { wrapper });
    await act(async () => { await expect(h.result.current.mutateAsync(payoutInput)).rejects.toMatchObject({ outcome: 'unknown' }); });
    expect(pendingKeys()).toHaveLength(1);
    const firstKey = m.rpc.mock.calls[0]![1].p_idempotency_key;
    h.unmount();
    const again = renderHook(() => useCreateProfitLedgerPayout(), { wrapper });
    await act(async () => { await expect(again.result.current.mutateAsync(payoutInput)).resolves.toMatchObject({ voucher_id: 'v9' }); });
    expect(m.rpc.mock.calls[1]![1].p_idempotency_key).toBe(firstKey);
    expect(pendingKeys()).toEqual([]);
  });
  it('đối chiếu mà máy chủ trả lỗi (khác nội dung) ⇒ vẫn khoá, không lập lại', async () => {
    m.rpc.mockResolvedValueOnce({ data: null, error: { code: '', message: 'FetchError: Failed to fetch' } })
      .mockResolvedValueOnce({ data: null, error: { code: '23505', message: 'idempotency_key đã dùng với nội dung khác' } });
    const h = renderHook(() => useCreateProfitLedgerPayout(), { wrapper });
    await act(async () => { await expect(h.result.current.mutateAsync(payoutInput)).rejects.toBeTruthy(); });
    await act(async () => { await expect(h.result.current.mutateAsync({ ...payoutInput, amount: 1 })).rejects.toMatchObject({ outcome: 'unknown' }); });
    expect(pendingKeys()).toHaveLength(1);
  });
  it('biên nhận lệch hợp đồng (thiếu số) ⇒ chưa rõ kết quả, không coi là thành công', async () => {
    m.rpc.mockResolvedValue({ data: e5({ within_amount: null }), error: null });
    const h = renderHook(() => useCreateProfitLedgerPayout(), { wrapper });
    await act(async () => { await expect(h.result.current.mutateAsync(payoutInput)).rejects.toMatchObject({ outcome: 'unknown' }); });
  });
  it('làm mới đủ các khoá sau khi ghi (kể cả khi lỗi)', async () => {
    const spy = vi.spyOn(client, 'invalidateQueries');
    m.rpc.mockResolvedValue({ data: null, error: { code: '55000', message: 'PROFIT_LEDGER_ROUTE_OFF: x' } });
    const h = renderHook(() => useCreateProfitLedgerPayout(), { wrapper });
    await act(async () => { await expect(h.result.current.mutateAsync(payoutInput)).rejects.toBeTruthy(); });
    const keys = spy.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));
    for (const key of PROFIT_LEDGER_INVALIDATE_KEYS) expect(keys).toContain(JSON.stringify(key));
    for (const key of ['profit-ledger', 'profit-ledger-entries', 'my-profit-ledger', 'profit-manager-ledger', 'manager-ledger-payouts', 'income-expenses', 'accounts-with-balance', 'pending-approvals', 'manager-salary', 'cash-flow-by-day']) {
      expect(keys).toContain(JSON.stringify([key]));
    }
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
  it('E16 gửi Y / D / lý do của dòng', async () => {
    m.rpc.mockResolvedValue({ data: { line_id: 'l1', shareholder_id: SH, salary_voucher_id: 'pl', period_month: '2026-09-01', investment_amount: 7, advance_offset_amount: 0, balance_before: 80, balance_after: 73 }, error: null });
    const h = renderHook(() => useResolveSalaryProfitLine(), { wrapper });
    await act(async () => { await h.result.current.mutateAsync({ organizationId: ORG, lineId: 'l1', investment: 7, offset: 0, reason: 'Đúng phần đầu tư tháng 9' }); });
    expect(m.rpc).toHaveBeenCalledWith('profit_ledger_salary_resolve_v1', expect.objectContaining({
      p_line_id: 'l1', p_investment_amount: 7, p_advance_offset_amount: 0, p_reason: 'Đúng phần đầu tư tháng 9',
    }));
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
