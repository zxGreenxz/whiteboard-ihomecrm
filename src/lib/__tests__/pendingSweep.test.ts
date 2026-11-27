// @vitest-environment jsdom
// Đợt 11: quét nền dấu «chờ đối chiếu» khi mở app. Ba kịch bản của plan (đã ghi ⇒ gỡ + báo; chưa ghi chắc chắn ⇒ gỡ, không
// gửi gì; nơi máy chủ khử trùng theo mã ⇒ dấu còn nguyên, KHÔNG lệnh ghi nào) cộng đọc lỗi, dấu chưa lắng, dấu người khác /
// công ty khác / namespace chưa đăng ký, chạy trùng — trên dấu gieo sẵn và máy chủ giả.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type ReactNode } from 'react';
import * as ReactQuery from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import ts from 'typescript';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRecordServer, type FakeRecordServer } from '@/hooks/__tests__/fakeRecordServer';
import { PENDING_SWEEP_OPEN_DELAY_MS, usePendingSweepOnOpen } from '@/hooks/usePendingSweepOnOpen';
import { isAttemptRunning, trackRunningAttempt, type FinancialPendingRecord } from '@/lib/financialPending';
import { reconcilePendingOnly } from '@/lib/financialWorkflow';
import { PENDING_STRATEGIES } from '@/lib/pendingStrategies';
import { PENDING_SWEEP_SOURCES, pendingMarkScopes, pendingSweepNotice, runPendingSweepOnOpen, sweepPendingMarks } from '@/lib/pendingSweep';

const io = vi.hoisted(() => ({
  server: null as unknown as FakeRecordServer,
  reads: [] as string[],
  writes: [] as string[],
  toast: vi.fn(),
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (table: string) => {
      const query = io.server.from(table) as Record<string, unknown>;
      // Mọi chuỗi lời gọi bắt đầu bằng thao tác của nó (`.from(t).update(…)`, `.from(t).select(…)`): ghi lại thao tác đầu.
      return new Proxy(query, {
        get(target, property) {
          const name = String(property);
          if (['insert', 'update', 'upsert', 'delete'].includes(name)) io.writes.push(`${table}.${name}`);
          if (name === 'select') io.reads.push(table);
          return target[name];
        },
      });
    },
    rpc: (name: string, args: Record<string, unknown>) => io.server.rpc(name, args),
  },
}));
vi.mock('sonner', () => ({ toast: { info: io.toast, success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const USER = 'actor';
const ORG = 'org-a';
const OLD = () => new Date(Date.now() - 10 * 60_000);
const markKey = (scope: { namespace: string; userId: string; organizationId: string; businessKey: string }) =>
  'ihome:financial-pending:v1:' + [scope.namespace, scope.userId, scope.organizationId, scope.businessKey].map(encodeURIComponent).join(':');
function seedMark(namespace: string, businessKey: string, extra: { userId?: string; organizationId?: string; attemptId?: string; operation?: string; meta?: Record<string, string | number | boolean>; startedAt?: Date } = {}) {
  const scope = { namespace, userId: extra.userId ?? USER, organizationId: extra.organizationId ?? 'actor-scope', businessKey };
  const attemptId = extra.attemptId ?? `att-${namespace}-${businessKey}`;
  const key = markKey(scope);
  localStorage.setItem(key, JSON.stringify({
    ...scope, attemptId, requestKey: attemptId, completedIds: [], startedAt: (extra.startedAt ?? OLD()).toISOString(),
    ...(extra.operation ? { operation: extra.operation } : {}), ...(extra.meta ? { meta: extra.meta } : {}),
  }));
  return key;
}
const voucher = (id: string, fields: Record<string, unknown>) => ({
  id, code: `PT-${id}`, type: 'INCOME', payment_id: null, approval_status: 'APPROVED', posting_status: 'POSTED',
  approval_version: 3, posting_version: 1, verified_at: null, ...fields,
});
const signatureOf = (row: Record<string, unknown>) => [row.approval_status, row.posting_status, row.approval_version, row.posting_version].map(value => value ?? '').join('|');
const queryClient = () => ({ invalidateQueries: vi.fn() });
const queryWrapper = ({ children }: { children: ReactNode }) => createElement(ReactQuery.QueryClientProvider, { client: new ReactQuery.QueryClient() }, children);
const sweep = (overrides: Partial<Parameters<typeof sweepPendingMarks>[0]> = {}) => sweepPendingMarks({ userId: USER, organizationId: ORG, ...overrides });

// Nạp trước ba tệp hook đăng ký (đồ thị import lớn): máy đang tải nặng thì lần nạp đầu có thể quá 5 giây của một ca test.
beforeAll(async () => { for (const source of PENDING_SWEEP_SOURCES) await source.load(); }, 120_000);
beforeEach(() => {
  localStorage.clear();
  io.server = fakeRecordServer();
  io.reads = [];
  io.writes = [];
  io.toast.mockReset();
});
afterEach(() => { vi.useRealTimers(); });

describe('quét nền khi mở app — ba kịch bản của plan', () => {
  it('lần trước ĐÃ ghi ⇒ gỡ dấu, làm mới dữ liệu, báo MỘT câu nêu thao tác + giờ + bản ghi; không gửi lệnh nào', async () => {
    const before = voucher('v1', {});
    io.server.rows.income_expenses = [voucher('v1', { approval_status: 'UNAPPROVED', posting_status: 'UNPOSTED', approval_version: 4 })];
    const key = seedMark('voucher-unapprove', 'v1', { operation: 'bỏ duyệt phiếu', meta: { before: signatureOf(before) } });
    const client = queryClient();
    const report = await runPendingSweepOnOpen({ userId: USER, organizationId: ORG, queryClient: client, seen: new Set(), locks: null });
    expect(localStorage.getItem(key)).toBeNull();
    expect(report?.settled.map(item => item.outcome.kind)).toEqual(['written']);
    expect(io.toast).toHaveBeenCalledTimes(1);
    const [title, options] = io.toast.mock.calls[0] as [string, { description: string }];
    expect(title).toMatch(/Đã đối chiếu/);
    expect(options.description).toMatch(/«bỏ duyệt phiếu» gửi lúc \d{2}:\d{2} ngày/);
    expect(options.description).toContain('PT-v1');
    expect(client.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['income-expenses'] });
    expect(io.writes).toEqual([]);
    expect(io.server.rpcCalls).toEqual([]);
  });

  it('lần trước CHƯA ghi (tra chắc chắn: trạng thái y như lúc bấm, đã quá 2 phút) ⇒ gỡ dấu, KHÔNG gửi gì', async () => {
    const row = voucher('v2', { approval_status: 'CANCELLED', posting_status: 'REVERSED' });
    io.server.rows.income_expenses = [row];
    const key = seedMark('voucher-restore', 'v2', { meta: { before: signatureOf(row) } });
    const report = await sweep();
    expect(localStorage.getItem(key)).toBeNull();
    expect(report.settled.map(item => item.outcome.kind)).toEqual(['not-written']);
    expect(pendingSweepNotice(report.settled)?.description).toMatch(/chưa được ghi; làm lại nếu vẫn cần/);
    expect(io.writes).toEqual([]);
    expect(io.server.rpcCalls).toEqual([]);
  });

  it('nơi máy chủ khử trùng theo mã (`serverDedupesRequestKey`) ⇒ dấu còn nguyên, KHÔNG có lệnh ghi nào', async () => {
    // «Đã kiểm» bản đặt giá trị (đợt 10c): hàm đối chiếu không đọc gì, kết luận «gửi lại cùng giá trị ngay».
    const verify = seedMark('voucher-verify', 'v3', { meta: { target_verified: true } });
    // Phiên bàn giao: máy chủ khoá phiên rồi mới xét; «như trước khi bấm» = gửi lại ngay.
    io.server.rows.cash_handovers = [{ id: 'h1', code: 'BG1', status: 'PENDING', cancel_requested_by: null, cancel_requested_at: null }];
    const handover = seedMark('handover-confirm', 'h1', { meta: { before: 'PENDING||' } });
    // Hoá đơn: khoá rồi mới xét; còn Đã huỷ như lúc bấm khôi phục.
    io.server.rows.invoices = [{ id: 'i1', invoice_number: 'HD1', status: 'CANCELLED', deleted_at: null, paid_amount: 0 }];
    const invoice = seedMark('invoice-restore', 'i1', { organizationId: ORG, meta: { before: 'CANCELLED||0' } });
    const report = await sweep();
    expect([verify, handover, invoice].map(key => localStorage.getItem(key) !== null)).toEqual([true, true, true]);
    expect(report.settled).toEqual([]);
    expect(report.kept.map(item => [item.pending.namespace, item.reason]).sort()).toEqual([
      ['handover-confirm', 'resend-needed'], ['invoice-restore', 'resend-needed'], ['voucher-verify', 'resend-needed'],
    ]);
    expect(io.writes).toEqual([]);
    expect(io.server.rpcCalls).toEqual([]);
    expect(pendingSweepNotice(report.settled)).toBeNull();
  });
});

describe('quét nền — dấu không được đụng tới', () => {
  it('đọc lỗi / mất mạng ⇒ dấu còn nguyên, im lặng, không thử lại trong cùng phiên', async () => {
    io.server.rows.income_expenses = [voucher('v4', {})];
    const key = seedMark('voucher-unapprove', 'v4', { meta: { before: 'APPROVED|POSTED|3|1' } });
    io.server.failNext('income_expenses', 'read', 'drop-before');
    const seen = new Set<string>();
    const first = await runPendingSweepOnOpen({ userId: USER, organizationId: ORG, queryClient: queryClient(), seen, locks: null });
    expect(localStorage.getItem(key)).not.toBeNull();
    expect(first?.kept.map(item => item.reason)).toEqual(['failed']);
    expect(io.toast).not.toHaveBeenCalled();
    io.reads = [];
    await runPendingSweepOnOpen({ userId: USER, organizationId: ORG, queryClient: queryClient(), seen, locks: null });
    expect(io.reads).toEqual([]);
    expect(localStorage.getItem(key)).not.toBeNull();
  });

  it('dấu chưa lắng (dưới 2 phút) ⇒ không đọc, không đụng; báo giờ hẹn xét lại', async () => {
    const startedAt = new Date(Date.now() - 30_000);
    io.server.rows.income_expenses = [voucher('v5', { approval_status: 'UNAPPROVED' })];
    const key = seedMark('voucher-unapprove', 'v5', { startedAt, meta: { before: 'APPROVED|POSTED|3|1' } });
    const report = await sweep();
    expect(localStorage.getItem(key)).not.toBeNull();
    expect(io.reads).toEqual([]);
    expect(report.recheckAt).toBe(startedAt.getTime() + 120_000);
  });

  it('dấu của người khác, công ty khác, namespace chưa đăng ký hay dấu khoá chung bản trước ⇒ không đụng', async () => {
    io.server.rows.income_expenses = [voucher('v6', { approval_status: 'UNAPPROVED' })];
    io.server.rows.invoices = [{ id: 'i2', invoice_number: 'HD2', status: 'APPROVED', deleted_at: null, paid_amount: 0 }];
    const keys = [
      seedMark('voucher-unapprove', 'v6', { userId: 'someone-else', meta: { before: 'APPROVED|POSTED|3|1' } }),
      // Hoá đơn dùng phạm vi công ty đang chọn: dấu của công ty khác để nguyên.
      seedMark('invoice-restore', 'i2', { organizationId: 'org-b', meta: { before: 'CANCELLED||0' } }),
      // Phạm vi lệch với nơi ghi (phiếu dùng phạm vi người dùng): không phải dấu của nơi ghi này.
      seedMark('voucher-unapprove', 'v6', { organizationId: ORG, meta: { before: 'APPROVED|POSTED|3|1' } }),
      // Namespace có hàm đối chiếu ghi tiếp (huỷ phiếu) hoặc chưa đăng ký: không đụng.
      seedMark('voucher-cancel', 'v6', { meta: { before: 'APPROVED|POSTED|3|1' } }),
      seedMark('voucher-lifecycle', 'v6'),
      seedMark('invoice-approve', 'i2', { organizationId: ORG }),
    ];
    const report = await sweep();
    expect(keys.map(key => localStorage.getItem(key) !== null)).toEqual(keys.map(() => true));
    expect(report.settled).toEqual([]);
    expect(io.reads).toEqual([]);
  });

  it('lần bấm đang chạy đúng dấu này trong tab ⇒ quét nền bỏ qua, không đọc', async () => {
    io.server.rows.income_expenses = [voucher('v7', { approval_status: 'UNAPPROVED' })];
    const key = seedMark('voucher-unapprove', 'v7', { attemptId: 'running', meta: { before: 'APPROVED|POSTED|3|1' } });
    const stop = trackRunningAttempt('running');
    try {
      const report = await sweep();
      expect(report.settled).toEqual([]);
      expect(report.recheckAt).toBeNull();
    } finally { stop(); }
    expect(localStorage.getItem(key)).not.toBeNull();
    expect(io.reads).toEqual([]);
  });
});

describe('quét nền — dấu «Đã kiểm» bản trước và chạy trùng', () => {
  it('dấu «Đã kiểm» bản bật/tắt (chỉ có chữ ký lúc bấm) đã đổi ⇒ đã ghi: gỡ + báo; dấu không mang chữ ký ⇒ để nguyên', async () => {
    io.server.rows.income_expenses = [voucher('v8', { verified_at: '2026-11-20T03:00:00.000Z' }), voucher('v9', {})];
    const flipped = seedMark('voucher-verify', 'v8', { meta: { before: 'chua-kiem' } });
    const unsigned = seedMark('voucher-verify', 'v9');
    const report = await sweep();
    expect(localStorage.getItem(flipped)).toBeNull();
    expect(localStorage.getItem(unsigned)).not.toBeNull();
    expect(report.settled.map(item => [item.pending.businessKey, item.outcome.kind])).toEqual([['v8', 'written']]);
    expect(pendingSweepNotice(report.settled)?.description).toMatch(/Đã kiểm/);
    expect(io.writes).toEqual([]);
  });

  it('nhiều dấu có kết luận ⇒ một thông báo gộp', async () => {
    io.server.rows.income_expenses = [voucher('a1', { approval_status: 'UNAPPROVED' }), voucher('a2', { approval_status: 'UNAPPROVED' }), voucher('a3', {})];
    seedMark('voucher-unapprove', 'a1', { meta: { before: 'APPROVED|POSTED|3|1' } });
    seedMark('voucher-unapprove', 'a2', { meta: { before: 'APPROVED|POSTED|3|1' } });
    seedMark('voucher-restore', 'a3', { meta: { before: 'APPROVED|POSTED|3|1' } });
    await runPendingSweepOnOpen({ userId: USER, organizationId: ORG, queryClient: queryClient(), seen: new Set(), locks: null });
    expect(io.toast).toHaveBeenCalledTimes(1);
    expect(io.toast.mock.calls[0][0]).toBe('Đã đối chiếu 3 yêu cầu gửi trước đó');
  });

  it('tab khác đang quét (khoá Web Locks bận) ⇒ lượt này không quét; hai lượt nối nhau vô hại', async () => {
    io.server.rows.income_expenses = [voucher('b1', { approval_status: 'UNAPPROVED' })];
    const key = seedMark('voucher-unapprove', 'b1', { meta: { before: 'APPROVED|POSTED|3|1' } });
    const busy = { request: vi.fn(async (_name: string, _options: unknown, callback: (lock: null) => Promise<unknown>) => callback(null)) };
    const skipped = await runPendingSweepOnOpen({ userId: USER, organizationId: ORG, queryClient: queryClient(), seen: new Set(), locks: busy as never });
    expect(skipped).toBeNull();
    expect(busy.request).toHaveBeenCalledWith(`ihome:pending-sweep:${USER}`, { ifAvailable: true }, expect.any(Function));
    expect(localStorage.getItem(key)).not.toBeNull();
    // Hai «tab» (hai tập `seen` riêng) chạy nối nhau: lượt đầu gỡ, lượt sau không còn gì để làm.
    const first = await sweep({ seen: new Set() });
    const second = await sweep({ seen: new Set() });
    expect(first.settled).toHaveLength(1);
    expect(second.settled).toEqual([]);
    expect(io.writes).toEqual([]);
  });

  it('khoá của kho dấu: chỉ nhận đúng bốn phần, bỏ khoá hỏng dạng', () => {
    const storage = {
      keys: [markKey({ namespace: 'voucher-verify', userId: 'u:1', organizationId: 'actor-scope', businessKey: 'k' }), 'ihome:financial-pending:v1:a:b:c', 'ihome:financial-pending:v1:a:b:c:%E0%A4%A', 'other'],
      get length() { return this.keys.length; },
      key(index: number) { return this.keys[index] ?? null; },
    };
    expect(pendingMarkScopes(storage)).toEqual([{ namespace: 'voucher-verify', userId: 'u:1', organizationId: 'actor-scope', businessKey: 'k' }]);
    const blocked = { get length(): number { throw new DOMException('blocked', 'SecurityError'); }, key: () => null };
    expect(pendingMarkScopes(blocked)).toEqual([]);
  });
});

describe('chế độ chỉ đối chiếu của lõi (`reconcilePendingOnly`)', () => {
  const prior = (over: Partial<FinancialPendingRecord> = {}): FinancialPendingRecord => ({
    namespace: 'voucher-verify', userId: USER, organizationId: 'actor-scope', businessKey: 'k', attemptId: 'p1', requestKey: 'p1',
    completedIds: ['rec-1'], startedAt: OLD().toISOString(), ...over,
  });
  const clearing = () => ({ clearConfirmed: vi.fn(() => true) });

  it('không bao giờ gọi việc ghi: chỉ nhận hàm đối chiếu; kết luận gỡ đúng dấu theo attemptId', async () => {
    const store = clearing();
    await expect(reconcilePendingOnly(prior(), async () => ({ result: 'x' }), { store })).resolves.toEqual({ kind: 'written', message: null, recordIds: ['rec-1'] });
    await expect(reconcilePendingOnly(prior(), async () => ({ outcome: 'already-written', message: 'Đã ghi.', recordIds: ['R'] }), { store })).resolves.toEqual({ kind: 'written', message: 'Đã ghi.', recordIds: ['R'] });
    await expect(reconcilePendingOnly(prior(), async () => ({ outcome: 'not-written' }), { store })).resolves.toEqual({ kind: 'not-written' });
    expect(store.clearConfirmed).toHaveBeenCalledTimes(3);
    expect(store.clearConfirmed).toHaveBeenCalledWith({ namespace: 'voucher-verify', userId: USER, organizationId: 'actor-scope', businessKey: 'k' }, 'p1');
  });

  it('«chưa ghi» kèm `serverDedupesRequestKey` ⇒ KHÔNG gỡ (gỡ là mất mã cũ, lần bấm sau sinh mã mới)', async () => {
    const store = clearing();
    await expect(reconcilePendingOnly(prior(), async () => ({ outcome: 'not-written', serverDedupesRequestKey: true }), { store })).resolves.toEqual({ kind: 'kept', reason: 'resend-needed' });
    expect(store.clearConfirmed).not.toHaveBeenCalled();
  });

  it('dấu chưa lắng, đang chạy, đọc hỏng, kết luận null / lạ dạng, dấu đã đổi ⇒ giữ dấu', async () => {
    const store = clearing();
    const reconcile = vi.fn(async () => ({ outcome: 'not-written' as const }));
    await expect(reconcilePendingOnly(prior({ startedAt: new Date().toISOString() }), reconcile, { store })).resolves.toEqual({ kind: 'kept', reason: 'unsettled' });
    const stop = trackRunningAttempt('p1');
    try { await expect(reconcilePendingOnly(prior(), reconcile, { store })).resolves.toEqual({ kind: 'kept', reason: 'running' }); }
    finally { stop(); }
    expect(reconcile).not.toHaveBeenCalled();
    await expect(reconcilePendingOnly(prior(), async () => { throw new Error('offline'); }, { store })).resolves.toEqual({ kind: 'kept', reason: 'failed' });
    await expect(reconcilePendingOnly(prior(), async () => null, { store })).resolves.toEqual({ kind: 'kept', reason: 'inconclusive' });
    await expect(reconcilePendingOnly(prior(), async () => ({ outcome: 'later' }) as never, { store })).resolves.toEqual({ kind: 'kept', reason: 'inconclusive' });
    expect(store.clearConfirmed).not.toHaveBeenCalled();
    await expect(reconcilePendingOnly(prior(), async () => ({ outcome: 'not-written' }), { store: { clearConfirmed: () => false } })).resolves.toEqual({ kind: 'kept', reason: 'gone' });
  });

  it('trong lúc đối chiếu, dấu được coi là đang chạy (lần bấm cùng thao tác trong tab chờ, không đối chiếu song song)', async () => {
    let runningDuring = false;
    await reconcilePendingOnly(prior(), async pending => { runningDuring = isAttemptRunning(pending.attemptId); return null; }, { store: clearing() });
    expect(runningDuring).toBe(true);
    expect(isAttemptRunning('p1')).toBe(false);
  });
});

describe('gắn quét nền lúc mở app (`usePendingSweepOnOpen`)', () => {
  it('chờ app dựng xong rồi mới nạp bộ quét; cần cả người dùng lẫn công ty; hẹn xét lại dấu chưa lắng tối đa vài lần', async () => {
    vi.useFakeTimers();
    io.server.rows.income_expenses = [voucher('c1', { approval_status: 'UNAPPROVED' })];
    const startedAt = new Date(Date.now() - 60_000);
    const key = seedMark('voucher-unapprove', 'c1', { startedAt, meta: { before: 'APPROVED|POSTED|3|1' } });
    const { unmount, rerender } = renderHook(({ user, org }) => usePendingSweepOnOpen(user, org), { initialProps: { user: null as string | null, org: ORG }, wrapper: queryWrapper });
    await vi.advanceTimersByTimeAsync(PENDING_SWEEP_OPEN_DELAY_MS + 100);
    expect(io.reads).toEqual([]);
    rerender({ user: USER, org: ORG });
    await vi.advanceTimersByTimeAsync(PENDING_SWEEP_OPEN_DELAY_MS - 500);
    expect(localStorage.getItem(key)).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    // Lượt đầu: dấu chưa lắng (mới 1 phút) ⇒ để nguyên, hẹn xét lại khi đủ 2 phút.
    expect(localStorage.getItem(key)).not.toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(localStorage.getItem(key)).toBeNull();
    expect(io.toast).toHaveBeenCalledTimes(1);
    unmount();
  });
});

describe('nơi đăng ký quét nền', () => {
  it('mọi namespace đăng ký là thao tác đã có cách đối chiếu trong sổ, và tệp hook khai đúng bộ đó', async () => {
    for (const source of PENDING_SWEEP_SOURCES) {
      const handlers = await source.load();
      expect(Object.keys(handlers).sort()).toEqual([...source.namespaces].sort());
      for (const namespace of source.namespaces) {
        expect(PENDING_STRATEGIES[namespace]?.reconcile, namespace).toMatch(/^[ABCD]$/);
      }
    }
  });

  // Phạm vi công ty mà quét nền lọc phải trùng phạm vi guard của nơi ghi (đọc cây cú pháp của tệp hook).
  it('phạm vi khai cho quét nền trùng phạm vi guard của nơi ghi', async () => {
    const files: Record<string, string> = {
      'voucher-unapprove': 'src/hooks/income-expenses/statusMutations.ts', 'voucher-restore': 'src/hooks/income-expenses/statusMutations.ts',
      'voucher-verify': 'src/hooks/income-expenses/statusMutations.ts', 'handover-confirm': 'src/hooks/useCashHandovers.ts',
      'handover-cancel-request': 'src/hooks/useCashHandovers.ts', 'handover-cancel-confirm': 'src/hooks/useCashHandovers.ts',
      'handover-cancel-reject': 'src/hooks/useCashHandovers.ts', 'invoice-restore': 'src/hooks/useInvoices.ts', 'invoice-force-cancel': 'src/hooks/useInvoices.ts',
    };
    const guardScope = (file: string, namespace: string) => {
      const source = ts.createSourceFile(file, readFileSync(join(process.cwd(), file), 'utf8'), ts.ScriptTarget.Latest, true);
      const found: string[] = [];
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'persistentFinancialWorkflow'
          && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]) && node.arguments[0].text === namespace) {
          const options = node.arguments[1];
          const scope = options && ts.isObjectLiteralExpression(options)
            ? options.properties.find((item): item is ts.PropertyAssignment => ts.isPropertyAssignment(item) && item.name.getText(source) === 'scope')
            : undefined;
          found.push(scope && ts.isStringLiteralLike(scope.initializer) ? scope.initializer.text : 'selected');
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      return found;
    };
    const registered = PENDING_SWEEP_SOURCES.flatMap(source => [...source.namespaces]).sort();
    expect(Object.keys(files).sort()).toEqual(registered);
    for (const source of PENDING_SWEEP_SOURCES) {
      const handlers = await source.load();
      for (const namespace of source.namespaces) expect(guardScope(files[namespace], namespace), namespace).toEqual([handlers[namespace].scope]);
    }
  });

  it('mọi namespace đăng ký: quét nền không gửi lệnh ghi nào, dù bản ghi ở đích, như cũ, đã đổi hay không thấy', async () => {
    const tables: Record<string, { table: string; organizationId: string; row: (state: 'reached' | 'same' | 'other') => Record<string, unknown>; before: string }> = {
      'voucher-unapprove': { table: 'income_expenses', organizationId: 'actor-scope', before: 'APPROVED|POSTED|3|1', row: s => voucher('x', s === 'reached' ? { approval_status: 'UNAPPROVED' } : s === 'other' ? { approval_status: 'CANCELLED' } : {}) },
      'voucher-restore': { table: 'income_expenses', organizationId: 'actor-scope', before: 'CANCELLED|REVERSED|3|1', row: s => voucher('x', s === 'reached' ? { approval_status: 'APPROVED' } : s === 'other' ? { posting_status: 'UNPOSTED' } : { approval_status: 'CANCELLED', posting_status: 'REVERSED' }) },
      'voucher-verify': { table: 'income_expenses', organizationId: 'actor-scope', before: 'chua-kiem', row: s => voucher('x', s === 'same' ? {} : { verified_at: '2026-11-20T03:00:00.000Z' }) },
      'handover-confirm': { table: 'cash_handovers', organizationId: 'actor-scope', before: 'PENDING||', row: s => ({ id: 'x', code: 'BG', status: s === 'reached' ? 'CONFIRMED' : s === 'other' ? 'CANCELLED' : 'PENDING', cancel_requested_by: null, cancel_requested_at: null }) },
      'handover-cancel-request': { table: 'cash_handovers', organizationId: 'actor-scope', before: 'PENDING||', row: s => ({ id: 'x', code: 'BG', status: s === 'other' ? 'CONFIRMED' : 'PENDING', cancel_requested_by: s === 'reached' ? 'u' : null, cancel_requested_at: s === 'reached' ? '2026-11-20' : null }) },
      'handover-cancel-confirm': { table: 'cash_handovers', organizationId: 'actor-scope', before: 'PENDING|u|2026-11-20', row: s => ({ id: 'x', code: 'BG', status: s === 'reached' ? 'CANCELLED' : s === 'other' ? 'CONFIRMED' : 'PENDING', cancel_requested_by: 'u', cancel_requested_at: '2026-11-20' }) },
      'handover-cancel-reject': { table: 'cash_handovers', organizationId: 'actor-scope', before: 'PENDING|u|2026-11-20', row: s => ({ id: 'x', code: 'BG', status: s === 'other' ? 'CANCELLED' : 'PENDING', cancel_requested_by: s === 'reached' ? null : 'u', cancel_requested_at: s === 'reached' ? null : '2026-11-20' }) },
      'invoice-restore': { table: 'invoices', organizationId: ORG, before: 'CANCELLED||0', row: s => ({ id: 'x', invoice_number: 'HD', status: s === 'reached' ? 'APPROVED' : s === 'other' ? 'DRAFT' : 'CANCELLED', deleted_at: null, paid_amount: 0 }) },
      'invoice-force-cancel': { table: 'invoices', organizationId: ORG, before: 'APPROVED||0', row: s => ({ id: 'x', invoice_number: 'HD', status: s === 'reached' ? 'CANCELLED' : s === 'other' ? 'PAID' : 'APPROVED', deleted_at: null, paid_amount: s === 'other' ? 5 : 0 }) },
    };
    expect(Object.keys(tables).sort()).toEqual(PENDING_SWEEP_SOURCES.flatMap(source => [...source.namespaces]).sort());
    for (const [namespace, spec] of Object.entries(tables)) {
      for (const state of ['reached', 'same', 'other', 'missing'] as const) {
        localStorage.clear();
        io.server = fakeRecordServer();
        io.writes = [];
        io.server.rows[spec.table] = state === 'missing' ? [] : [spec.row(state)];
        const key = seedMark(namespace, 'x', { organizationId: spec.organizationId, meta: { before: spec.before } });
        const report = await sweep();
        expect(io.writes, `${namespace}/${state}`).toEqual([]);
        expect(io.server.rpcCalls, `${namespace}/${state}`).toEqual([]);
        // Không thấy bản ghi (quyền, đã xoá) thì chưa kết luận được: dấu để nguyên.
        if (state === 'missing') expect(localStorage.getItem(key), `${namespace}/${state}`).not.toBeNull();
        // Đã ở đích hoặc đã đổi hẳn: lần trước (hoặc ai đó) đã làm — gỡ dấu.
        if (state === 'reached' || state === 'other') expect(report.settled.map(item => item.outcome.kind), `${namespace}/${state}`).toEqual(['written']);
      }
    }
  });
});
