// @vitest-environment jsdom
// Đợt 11: quỹ chung, namespace `shared-fund`, cách B (gửi lại cùng mã). Hai hook dùng chung namespace, khoá nghiệp vụ khác
// nhau; phạm vi dấu mặc định (công ty đang chọn). Đo production 26/11/2026 (`pg_get_functiondef`, chỉ đọc; md5(prosrc)):
//   - useSharedFundWrite: shared_fund_record_source_v1 bf49030c, shared_fund_distribute_v1 d2163f30 (cùng con
//     app_private.shared_fund_write_v1 ead505a2), shareholder_profit_opening_advance_v1 4df84bf1. Khoá công ty trước, duy
//     nhất (công ty, người ghi, mã): cùng mã cùng nội dung ⇒ trả biên nhận cũ, khác nội dung ⇒ PT409. Hàm đối chiếu đọc
//     shared_fund_state_v1 theo người + mã; không thấy ⇒ gửi lại đúng mã ngay trong hàm đối chiếu.
//   - useHousePoolWrite: house_pool_activate_v1 966004d1, house_pool_return_v1 4b1b8a74; biên nhận house_pool_receipt_v1.
//     Cùng hợp đồng chống trùng theo (công ty, người ghi, mã).
// Ba kịch bản cho từng thao tác: (i) lệnh không tới máy chủ; (ii) tới nhưng mất phản hồi; (iii) dấu bản trước gieo sẵn.
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

import { useSharedFundWrite, type FundWrite } from '../useSharedFund';
import { useHousePoolWrite, type HousePoolWrite } from '../useHousePool';

type Row = Record<string, unknown>;
type Reply = { data: unknown; error: unknown };
const ORG = 'org-1';
const ACTOR = 'actor';
const LEGACY = 'legacy-attempt';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const conflict = (message: string): Reply => ({ data: null, error: { code: 'PT409', message } });
let queries: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queries}>{children}</QueryClientProvider>;
const legacyAge = () => new Date(Date.now() - 10 * 60_000);

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ihomecrm.selectedOrganizationId', ORG);
  io.server = fakeRecordServer();
  queries = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(cleanup);

/* ───────────────────────────── useSharedFundWrite ───────────────────────────── */

/** Sổ quỹ chung giả: giữ dòng theo (người ghi, mã); `shared_fund_state_v1` trả đúng các dòng đó. */
function installFund() {
  const fund = { sources: [] as Row[], distributions: [] as Row[], openings: [] as Row[] };
  const same = (row: Row, body: Row) => Object.entries(body).every(([field, value]) => JSON.stringify(row[field]) === JSON.stringify(value));
  const claim = (list: Row[], args: Row, body: Row, build: (n: number) => Row, reply: (row: Row) => Row): Reply => {
    const mark = String(args.p_idempotency_key);
    const prior = list.find((row) => row.created_by === ACTOR && row.request_key === mark);
    if (prior) return same(prior, body) ? { data: reply(prior), error: null } : conflict('Mã yêu cầu đã dùng với nội dung khác');
    const row = { ...build(list.length + 1), ...body, created_by: ACTOR, request_key: mark };
    list.push(row);
    return { data: reply(row), error: null };
  };
  io.server.rpcHandlers['shared_fund_record_source_v1'] = (args) => claim(
    fund.sources, args,
    { kind: args.p_kind, effective_date: args.p_effective_date, amount: args.p_amount, reference: args.p_reference, evidence: args.p_evidence },
    (n) => ({ id: `src-${n}` }),
    (row) => ({ id: row.id, organization_id: ORG, kind: row.kind, amount: row.amount, available_amount: row.amount }),
  );
  io.server.rpcHandlers['shared_fund_distribute_v1'] = (args) => {
    const lines = args.p_lines as { shareholder_id: string; amount: number; advance_offset_amount: number }[];
    const gross = lines.reduce((sum, line) => sum + line.amount, 0);
    const offset = lines.reduce((sum, line) => sum + line.advance_offset_amount, 0);
    return claim(
      fund.distributions, args,
      { effective_date: args.p_effective_date, reference: args.p_reference, evidence: args.p_evidence, amount: gross, advance_offset_amount: offset },
      (n) => ({
        id: `dist-${n}`, period_month: '2024-06-01', status: 'POSTED', payable_amount: gross - offset,
        lines: lines.map((line) => ({ ...line, name: 'Cổ đông', payable_amount: line.amount - line.advance_offset_amount })),
      }),
      (row) => ({
        id: row.id, organization_id: ORG, status: 'POSTED', amount: row.amount, available_amount: 0,
        advance_offset_amount: row.advance_offset_amount, payable_amount: row.payable_amount,
      }),
    );
  };
  io.server.rpcHandlers['shareholder_profit_opening_advance_v1'] = (args) => claim(
    fund.openings, args,
    { shareholder_id: args.p_shareholder_id, through_month: args.p_through_month, as_of_date: args.p_as_of_date, advance_amount: args.p_advance_amount, evidence: args.p_evidence },
    (n) => ({ opening_id: `open-${n}`, reconciled_approved: 0, reconciled_count: 0 }),
    (row) => ({
      opening_id: row.opening_id, shareholder_id: row.shareholder_id, through_month: row.through_month,
      as_of_date: row.as_of_date, advance_amount: row.advance_amount, evidence: row.evidence,
    }),
  );
  io.server.rpcHandlers['shared_fund_state_v1'] = () => ({
    data: {
      organization_id: ORG, route: 'CANONICAL', has_opening: true, available_amount: 0, last_effective_date: null,
      sources: fund.sources.map((row) => ({ ...row })), distributions: fund.distributions.map((row) => ({ ...row })),
      shareholders: [], openings: fund.openings.map((row) => ({ ...row })),
    },
    error: null,
  });
  return fund;
}

interface FundCase { name: string; rpc: string; op: FundWrite; list: 'sources' | 'distributions' | 'openings'; first: string }
const fundCases: FundCase[] = [
  {
    name: 'nguồn quỹ (source)', rpc: 'shared_fund_record_source_v1', list: 'sources', first: 'src-1',
    op: { action: 'source', kind: 'CREDIT', effectiveDate: '2024-06-01', amount: 750, reference: 'BB-A', evidence: 'Đã đối chiếu', expected: 0 },
  },
  {
    name: 'phân bổ (distribute)', rpc: 'shared_fund_distribute_v1', list: 'distributions', first: 'dist-1',
    op: {
      action: 'distribute', effectiveDate: '2024-06-02', reference: 'PB-A', evidence: 'Đã đối chiếu', expected: 750,
      lines: [{ shareholder_id: 'alpha', amount: 500, advance_offset_amount: 100 }, { shareholder_id: 'beta', amount: 250, advance_offset_amount: 0 }],
    },
  },
  {
    name: 'mốc đầu kỳ (opening)', rpc: 'shareholder_profit_opening_advance_v1', list: 'openings', first: 'open-1',
    op: {
      action: 'opening', shareholderId: 'alpha', throughMonth: '2024-04-01', asOfDate: '2024-05-03', advance: 75,
      expectedUnpaid: 60, expectedApproved: 90, evidence: 'Đã đối chiếu',
    },
  },
];
const fundMarks = (name: string) =>
  io.server.rpcCalls.filter((call) => call.name === name).map((call) => String(call.args.p_idempotency_key));

describe.each(fundCases)('useSharedFundWrite — $name', (c) => {
  it('(i) lệnh không tới máy chủ ⇒ báo chưa rõ; bấm lại gửi ĐÚNG mã lần đầu, đúng một bản ghi, gỡ dấu', async () => {
    const fund = installFund();
    io.server.failNext(c.rpc, 'rpc', 'drop-before');
    const h = renderHook(() => useSharedFundWrite(ORG), { wrapper });
    await act(async () => { await expect(h.result.current.mutateAsync(c.op)).rejects.toMatchObject({ outcome: 'unknown' }); });
    expect(pendingKeys()).toHaveLength(1);
    await act(async () => { await expect(h.result.current.mutateAsync(c.op)).resolves.toEqual({ id: c.first, reconciled: false }); });
    const marks = fundMarks(c.rpc);
    expect(marks).toHaveLength(2);
    expect(marks[1]).toBe(marks[0]);
    expect(fund[c.list]).toHaveLength(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('(ii) tới nhưng mất phản hồi ⇒ bấm lại tìm thấy bản ghi theo người + mã, không gửi lần hai', async () => {
    const fund = installFund();
    io.server.failNext(c.rpc, 'rpc', 'drop-after');
    const h = renderHook(() => useSharedFundWrite(ORG), { wrapper });
    await act(async () => { await expect(h.result.current.mutateAsync(c.op)).rejects.toMatchObject({ outcome: 'unknown' }); });
    expect(fund[c.list]).toHaveLength(1);
    await act(async () => { await expect(h.result.current.mutateAsync(c.op)).resolves.toEqual({ id: c.first, reconciled: true }); });
    expect(fundMarks(c.rpc)).toHaveLength(1);
    expect(fund[c.list]).toHaveLength(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('(iii) dấu bản trước gieo sẵn ⇒ không chặn: gửi đúng mã của dấu, xong thì gỡ dấu', async () => {
    const fund = installFund();
    const { action } = c.op;
    seedLegacyPending({ namespace: 'shared-fund', userId: ACTOR, organizationId: ORG, businessKey: action }, legacyAge());
    const h = renderHook(() => useSharedFundWrite(ORG), { wrapper });
    await act(async () => { await expect(h.result.current.mutateAsync(c.op)).resolves.toEqual({ id: c.first, reconciled: false }); });
    expect(fundMarks(c.rpc)).toEqual([LEGACY]);
    expect(fund[c.list]).toHaveLength(1);
    expect(pendingKeys()).toEqual([]);
  });
});

/* ───────────────────────────── useHousePoolWrite ───────────────────────────── */

/** Quỹ góp theo nhà giả: biên nhận theo (người ghi, loại, mã); cùng mã cùng nội dung ⇒ biên nhận cũ, khác ⇒ PT409. */
function installHousePool() {
  const done = { activate: new Map<string, { body: string; reply: Row }>(), return: new Map<string, { body: string; reply: Row }>() };
  const claim = (kind: 'activate' | 'return', args: Row, body: unknown[], build: (n: number) => Row): Reply => {
    const mark = String(args.p_request_key);
    const prior = done[kind].get(mark);
    const text = JSON.stringify(body);
    if (prior) return prior.body === text ? { data: prior.reply, error: null } : conflict('Mã đã dùng với nội dung khác');
    const reply = build(done[kind].size + 1);
    done[kind].set(mark, { body: text, reply });
    return { data: reply, error: null };
  };
  io.server.rpcHandlers['house_pool_activate_v1'] = (args) => claim(
    'activate', args, [args.p_partner, args.p_rules, args.p_history_from, args.p_automatic_from, args.p_opening_id],
    (n) => ({ imported: n + 2, shareholders: [uuid(91), uuid(92)] }),
  );
  io.server.rpcHandlers['house_pool_return_v1'] = (args) => claim(
    'return', args, [args.p_rate, args.p_account, args.p_voucher_date, args.p_expected_hash],
    (n) => ({ id: uuid(100 + n), voucher_id: uuid(200 + n), total: 300 }),
  );
  io.server.rpcHandlers['house_pool_receipt_v1'] = (args) => {
    const kind = args.p_kind as 'activate' | 'return';
    const prior = done[kind].get(String(args.p_request_key));
    if (!prior) return { data: null, error: null };
    return {
      data: kind === 'return' ? { voucher: prior.reply.voucher_id, imported: null } : { voucher: null, imported: prior.reply.imported },
      error: null,
    };
  };
  return done;
}

interface PoolCase { name: string; rpc: string; op: HousePoolWrite; first: Row }
const poolCases: PoolCase[] = [
  {
    name: 'kích hoạt (activate)', rpc: 'house_pool_activate_v1', first: { imported: 3, voucher: null },
    op: { kind: 'activate', partner: uuid(1), opening: null, rules: [{ building_id: uuid(2), share_percent: 50, retained_percent: 0, baseline_revision: uuid(3) }] },
  },
  {
    name: 'hoàn quỹ (return)', rpc: 'house_pool_return_v1', first: { voucher: uuid(201), imported: null },
    op: { kind: 'return', rate: 100, account: uuid(4), date: '2026-11-20', hash: 'h1', total: 300 },
  },
];
const poolMarks = (name: string) =>
  io.server.rpcCalls.filter((call) => call.name === name).map((call) => String(call.args.p_request_key));

describe.each(poolCases)('useHousePoolWrite — $name', (c) => {
  it('(i) lệnh không tới máy chủ ⇒ báo chưa rõ; bấm lại gửi NGAY đúng mã lần đầu, đúng một bản ghi, gỡ dấu', async () => {
    const done = installHousePool();
    io.server.failNext(c.rpc, 'rpc', 'drop-before');
    const h = renderHook(() => useHousePoolWrite(ORG), { wrapper });
    await act(async () => { await expect(h.result.current.mutateAsync(c.op)).rejects.toMatchObject({ outcome: 'unknown' }); });
    expect(pendingKeys()).toHaveLength(1);
    await act(async () => { await expect(h.result.current.mutateAsync(c.op)).resolves.toEqual(c.first); });
    const marks = poolMarks(c.rpc);
    expect(marks).toHaveLength(2);
    expect(marks[1]).toBe(marks[0]);
    expect(done[c.op.kind].size).toBe(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('(ii) tới nhưng mất phản hồi ⇒ bấm lại nhận biên nhận cũ theo mã, không gửi lần hai', async () => {
    const done = installHousePool();
    io.server.failNext(c.rpc, 'rpc', 'drop-after');
    const h = renderHook(() => useHousePoolWrite(ORG), { wrapper });
    await act(async () => { await expect(h.result.current.mutateAsync(c.op)).rejects.toMatchObject({ outcome: 'unknown' }); });
    expect(done[c.op.kind].size).toBe(1);
    await act(async () => { await expect(h.result.current.mutateAsync(c.op)).resolves.toEqual(c.first); });
    expect(poolMarks(c.rpc)).toHaveLength(1);
    expect(poolMarks('house_pool_receipt_v1')).toEqual(poolMarks(c.rpc));
    expect(done[c.op.kind].size).toBe(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('(iii) dấu bản trước gieo sẵn ⇒ không chặn: gửi đúng mã của dấu, xong thì gỡ dấu', async () => {
    const done = installHousePool();
    seedLegacyPending({ namespace: 'shared-fund', userId: ACTOR, organizationId: ORG, businessKey: ['house', 'pool', c.op.kind].join('-') }, legacyAge());
    const h = renderHook(() => useHousePoolWrite(ORG), { wrapper });
    await act(async () => { await expect(h.result.current.mutateAsync(c.op)).resolves.toEqual(c.first); });
    expect(poolMarks(c.rpc)).toEqual([LEGACY]);
    expect(done[c.op.kind].size).toBe(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('hàng rào: đọc biên nhận hỏng ⇒ chưa kết luận, GIỮ dấu, không gửi lại', async () => {
    const done = installHousePool();
    io.server.failNext(c.rpc, 'rpc', 'drop-before');
    io.server.failNext('house_pool_receipt_v1', 'rpc', 'drop-before');
    const h = renderHook(() => useHousePoolWrite(ORG), { wrapper });
    await act(async () => { await expect(h.result.current.mutateAsync(c.op)).rejects.toMatchObject({ outcome: 'unknown' }); });
    await act(async () => { await expect(h.result.current.mutateAsync(c.op)).rejects.toMatchObject({ outcome: 'unknown' }); });
    expect(poolMarks(c.rpc)).toHaveLength(1);
    expect(done[c.op.kind].size).toBe(0);
    expect(pendingKeys()).toHaveLength(1);
  });
});
