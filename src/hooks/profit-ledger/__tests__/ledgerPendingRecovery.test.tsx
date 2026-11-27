// @vitest-environment jsdom
// Đợt 11: sổ tổng lợi nhuận, cách B (gửi lại cùng mã). Sáu RPC của useProfitLedgerMutations, đo production 26/11/2026
// (`pg_get_functiondef`, chỉ đọc; md5(prosrc)): shareholder_profit_advance_v1 0e180034, shareholder_profit_settle_v1
// 1674838b, shareholder_profit_settlement_void_v1 5ebbf3ed, profit_ledger_payout_cancel_v1 a990969e,
// profit_ledger_set_marker_v1 99bf06d8, profit_ledger_salary_resolve_v1 0d835486. Cả sáu khoá công ty TRƯỚC, rồi giữ mã ở
// canonical_write_operations: cùng mã cùng nội dung ⇒ trả kết quả cũ; khác nội dung ⇒ 23505. runLedgerWrite gửi lại ĐÚNG
// mã của dấu trong hàm đối chiếu. Máy chủ giả dưới đây làm đúng hợp đồng đó và đếm số bản ghi thật.
// Ba kịch bản cho từng lệnh: (i) lệnh không tới máy chủ; (ii) tới nhưng mất phản hồi; (iii) dấu bản trước gieo sẵn.
import { act, cleanup, renderHook } from '@testing-library/react';
import {
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRecordServer, seedLegacyPending, pendingKeys, type FakeRecordServer } from '../../__tests__/fakeRecordServer';

const io = vi.hoisted(() => ({ server: undefined as unknown as FakeRecordServer }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor' }) }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: (table: string) => io.server.from(table), get rpc() { return io.server.rpc; } },
}));

import {
  useCancelProfitLedgerPayout, useCreateShareholderAdvance, useResolveSalaryProfitLine, useSetProfitLedgerMarker,
  useSettleShareholderProfit, useVoidProfitSettlement,
} from '../useProfitLedgerMutations';

type Row = Record<string, unknown>;
const ORG = 'org-1';
const SH = 'sh-1';
const LEGACY = 'legacy-attempt';
let queries: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queries}>{children}</QueryClientProvider>;
/** Số bản ghi máy chủ giả đã tạo thật, theo tên RPC. */
let records: Record<string, number> = {};

/** Máy chủ theo hợp đồng đã đo: mã đã giữ + cùng nội dung ⇒ trả kết quả cũ; khác nội dung ⇒ 23505; mã mới ⇒ ghi mới. */
function installLedger(name: string, receipt: (n: number) => Row) {
  const claimed = new Map<string, { body: string; result: Row }>();
  io.server.rpcHandlers[name] = (args) => {
    const { p_idempotency_key: mark, ...rest } = args;
    const body = JSON.stringify(rest);
    const prior = claimed.get(String(mark));
    if (prior) {
      return prior.body === body
        ? { data: prior.result, error: null }
        : { data: null, error: { code: '23505', message: 'idempotency_key đã dùng với nội dung khác' } };
    }
    records[name] = (records[name] ?? 0) + 1;
    const result = receipt(records[name]!);
    claimed.set(String(mark), { body, result });
    return { data: result, error: null };
  };
}
const sentMarks = (name: string) =>
  io.server.rpcCalls.filter((call) => call.name === name).map((call) => String(call.args.p_idempotency_key));

interface LedgerCase {
  name: string;
  rpc: string;
  namespace: string;
  /** Khoá nghiệp vụ của dấu (phạm vi `target`: công ty của chủ thể). */
  mark: string;
  receipt: (n: number) => Row;
  /** Phần kết quả trả về phải khớp biên nhận của bản ghi ĐẦU TIÊN. */
  first: Row;
  mount: () => () => Promise<unknown>;
}

const cases: LedgerCase[] = [
  {
    name: 'W1 lập phiếu tạm ứng',
    rpc: 'shareholder_profit_advance_v1',
    namespace: 'profit-ledger-advance',
    mark: `shareholder:${SH}`,
    receipt: (n) => ({
      state: 'PENDING_APPROVAL', amount: 500, within_amount: 0, advance_amount: 500, balance_before: null,
      maker_kind: 'CUSTODIAN_FOR_PAYEE', payout_kind: 'ADVANCE',
      warnings: [{ code: 'ADVANCE', advance_amount: 500 }, { code: 'NEEDS_OWNER_APPROVAL' }],
      voucher_id: `v-${n}`, approval_request_id: `r-${n}`, shareholder_id: SH,
    }),
    first: { voucher_id: 'v-1' },
    mount: () => {
      const h = renderHook(() => useCreateShareholderAdvance(), { wrapper });
      return () => h.result.current.mutateAsync({ organizationId: ORG, shareholderId: SH, amount: 500, accountId: 'acc-1', voucherDate: '2026-11-18', note: null });
    },
  },
  {
    name: 'W2 chốt chi lợi nhuận',
    rpc: 'shareholder_profit_settle_v1',
    namespace: 'profit-ledger-settle',
    mark: `shareholder:${SH}`,
    receipt: (n) => ({
      state: 'PENDING_APPROVAL', settlement_id: `st-${n}`, through_month: '2026-10-01', recognized_amount: 100,
      advance_offset_amount: 40, cash_amount: 60, voucher_id: `v-${n}`, approval_request_id: `r-${n}`,
    }),
    first: { settlement_id: 'st-1', voucher_id: 'v-1' },
    mount: () => {
      const h = renderHook(() => useSettleShareholderProfit(), { wrapper });
      return () => h.result.current.mutateAsync({
        organizationId: ORG, shareholderId: SH, throughMonth: '2026-10-01', expectedRecognized: 100, expectedCash: 60,
        accountId: 'acc-1', voucherDate: '2026-11-18', note: null,
      });
    },
  },
  {
    name: 'W3 huỷ lần chốt',
    rpc: 'shareholder_profit_settlement_void_v1',
    namespace: 'profit-ledger-settle-void',
    mark: 'settlement:st-1',
    receipt: () => ({ state: 'VOID', settlement_id: 'st-1' }),
    first: { settlement_id: 'st-1', state: 'VOID' },
    mount: () => {
      const h = renderHook(() => useVoidProfitSettlement(), { wrapper });
      return () => h.result.current.mutateAsync({ organizationId: ORG, settlementId: 'st-1', reason: 'Chốt nhầm tháng' });
    },
  },
  {
    name: 'E6 huỷ phiếu chi',
    rpc: 'profit_ledger_payout_cancel_v1',
    namespace: 'profit-ledger-cancel',
    mark: 'voucher:v1',
    receipt: (n) => ({ voucher_id: 'v1', changed: true, cancellation_kind: 'CANCELLED_UNPOSTED', reversal_posting_id: null, balance_after: 10 * n }),
    first: { voucher_id: 'v1', balance_after: 10 },
    mount: () => {
      const h = renderHook(() => useCancelProfitLedgerPayout(), { wrapper });
      return () => h.result.current.mutateAsync({ voucherId: 'v1', organizationId: ORG, reason: 'Lập nhầm sổ quỹ', expectedState: 'PENDING' });
    },
  },
  {
    name: 'E9 đặt mốc đã trả đủ',
    rpc: 'profit_ledger_set_marker_v1',
    namespace: 'profit-ledger-marker',
    mark: `SHAREHOLDER:${SH}`,
    receipt: (n) => ({ marker_id: `m-${n}`, settled_through_month: '2026-09-01', supersedes_id: null, balance_before: 0, balance_after: 0, advance_erased: 0 }),
    first: { marker_id: 'm-1' },
    mount: () => {
      const h = renderHook(() => useSetProfitLedgerMarker(), { wrapper });
      return () => h.result.current.mutateAsync({
        organizationId: ORG, subjectKind: 'SHAREHOLDER', subjectId: SH, settledThroughMonth: '2026-09-01',
        reason: 'Đặt mốc đã trả đủ', expectedMarkerId: null, acknowledgeAdvanceErase: false,
      });
    },
  },
  {
    name: 'E16 xác nhận phần lợi nhuận trong phiếu lương',
    rpc: 'profit_ledger_salary_resolve_v1',
    namespace: 'profit-ledger-salary-resolve',
    mark: 'line:l1',
    receipt: (n) => ({
      line_id: 'l1', shareholder_id: SH, salary_voucher_id: `pl-${n}`, period_month: '2026-09-01', investment_amount: 7,
      advance_offset_amount: 0, balance_before: 80, balance_after: 73,
    }),
    first: { salary_voucher_id: 'pl-1' },
    mount: () => {
      const h = renderHook(() => useResolveSalaryProfitLine(), { wrapper });
      return () => h.result.current.mutateAsync({ organizationId: ORG, lineId: 'l1', investment: 7, offset: 0, reason: 'Đúng phần đầu tư tháng 9' });
    },
  },
];

beforeEach(() => {
  localStorage.clear();
  records = {};
  io.server = fakeRecordServer();
  queries = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(cleanup);

describe.each(cases)('$name', (c) => {
  it('(i) lệnh không tới máy chủ ⇒ báo chưa rõ; bấm lại gửi ĐÚNG mã lần đầu, đúng một bản ghi, gỡ dấu', async () => {
    installLedger(c.rpc, c.receipt);
    io.server.failNext(c.rpc, 'rpc', 'drop-before');
    const submit = c.mount();
    await act(async () => { await expect(submit()).rejects.toMatchObject({ outcome: 'unknown' }); });
    expect(pendingKeys()).toHaveLength(1);
    await act(async () => { await expect(submit()).resolves.toMatchObject(c.first); });
    const marks = sentMarks(c.rpc);
    expect(marks).toHaveLength(2);
    expect(marks[1]).toBe(marks[0]);
    expect(records[c.rpc]).toBe(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('(ii) tới nhưng mất phản hồi ⇒ bấm lại nhận biên nhận cũ theo mã, không có bản ghi thứ hai', async () => {
    installLedger(c.rpc, c.receipt);
    io.server.failNext(c.rpc, 'rpc', 'drop-after');
    const submit = c.mount();
    await act(async () => { await expect(submit()).rejects.toMatchObject({ outcome: 'unknown' }); });
    expect(records[c.rpc]).toBe(1);
    expect(pendingKeys()).toHaveLength(1);
    await act(async () => { await expect(submit()).resolves.toMatchObject(c.first); });
    const marks = sentMarks(c.rpc);
    expect(marks).toHaveLength(2);
    expect(marks[1]).toBe(marks[0]);
    expect(records[c.rpc]).toBe(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('(iii) dấu bản trước gieo sẵn (không tên thao tác, 10 phút trước) ⇒ không chặn: gửi đúng mã của dấu, xong thì gỡ dấu', async () => {
    installLedger(c.rpc, c.receipt);
    seedLegacyPending({ namespace: c.namespace, userId: 'actor', organizationId: ORG, businessKey: c.mark }, new Date(Date.now() - 10 * 60_000));
    expect(pendingKeys()).toHaveLength(1);
    const submit = c.mount();
    await act(async () => { await expect(submit()).resolves.toMatchObject(c.first); });
    expect(sentMarks(c.rpc)).toEqual([LEGACY]);
    expect(records[c.rpc]).toBe(1);
    expect(pendingKeys()).toEqual([]);
  });
});
