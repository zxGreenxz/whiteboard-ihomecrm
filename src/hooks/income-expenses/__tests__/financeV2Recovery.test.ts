// @vitest-environment jsdom
// Đợt 5: duyệt / ghi sổ / duyệt và ghi sổ / hoàn tác V2 (cách B). Thân hàm production (25/11/2026) khoá phiếu rồi tra
// mã yêu cầu trong canonical_write_operations: cùng mã + cùng nội dung ⇒ trả kết quả cũ; cùng mã khác nội dung ⇒ 23505.
// Trình duyệt gửi lại đúng mã khi nội dung như lần trước; nội dung đổi (hoàn tác qua ngày) thì đọc trạng thái phiếu.
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRecordServer, pendingKeys, seedLegacyPending, type FakeRecordServer } from '../../__tests__/fakeRecordServer';

const io = vi.hoisted(() => ({ server: undefined as unknown as FakeRecordServer }));
vi.mock('@tanstack/react-query', () => ({ useMutation: (config: unknown) => config, useQuery: (config: unknown) => config, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (table: string) => io.server.from(table), get rpc() { return io.server.rpc; } } }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor' }) }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org-a' }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() } }));

import { useApproveIncomeExpenseV2, usePostApprovedIncomeExpenseV2, useReversePostingV2 } from '../financeV2Mutations';

type Row = Record<string, unknown>;
const fn = <I>(hook: () => unknown) => {
  const { result } = renderHook(hook);
  return (result.current as { mutationFn: (input: I) => Promise<unknown> }).mutationFn;
};
const voucher = () => io.server.rows.income_expenses[0] as Row;
const sent = (name: string) => io.server.rpcCalls.filter(call => call.name === name);
const keyOf = (args: Row) => String(args.p_idempotency_key ?? (args.input as Row | undefined)?.idempotencyKey);
const T0 = Date.parse('2026-11-25T03:00:00.000Z'); // bấm lại sau 26 giờ là qua ngày ở mọi múi giờ.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  localStorage.clear();
  localStorage.setItem('ihomecrm.selectedOrganizationId', 'org-a');
  io.server = fakeRecordServer();
  io.server.rows.income_expenses = [{ id: 'v1', code: 'PC2511009', approval_status: 'UNAPPROVED', posting_status: 'UNPOSTED', approval_version: 1, posting_version: 1 }];
  // finance_v2_begin_canonical_op: (thao tác, phiếu, mã) đã xong ⇒ trả kết quả cũ; khác nội dung ⇒ 23505.
  const ops = new Map<string, { hash: string; response: Row }>();
  const canonical = (operation: string, args: Row, hashOf: Row, apply: (row: Row) => Row | { error: Row }) => {
    const id = String(args.p_voucher ?? (args.input as Row).subjectId);
    const key = `${operation}:${id}:${keyOf(args)}`;
    const hash = JSON.stringify(hashOf);
    const done = ops.get(key);
    if (done) return done.hash === hash ? { data: done.response, error: null } : { data: null, error: { code: '23505', message: 'idempotency key reused with a different payload' } };
    const outcome = apply(voucher());
    if ('error' in outcome) return { data: null, error: outcome.error };
    ops.set(key, { hash, response: outcome });
    return { data: outcome, error: null };
  };
  io.server.rpcHandlers.approve_income_expense_v2 = args => canonical('approve', args, { v: args.p_voucher, eav: args.p_expected_approval_version }, row => {
    if (row.approval_status !== 'UNAPPROVED') return { error: { code: '55000', message: 'voucher not in an approvable state' } };
    Object.assign(row, { approval_status: 'APPROVED', approval_version: Number(row.approval_version) + 1 });
    return { voucherId: row.id, approvalStatus: 'APPROVED', reviewState: 'RESOLVED', approvalVersion: row.approval_version };
  });
  io.server.rpcHandlers.post_approved_income_expense_v2 = args => canonical('post', args, args.input as Row, row => {
    if (row.posting_status === 'POSTED') return { error: { code: '55000', message: 'đã có bút toán ghi sổ' } };
    Object.assign(row, { posting_status: 'POSTED', posting_version: Number(row.posting_version) + 1 });
    return { voucherId: row.id, postingId: 'p1', postingStatus: 'POSTED', postingVersion: row.posting_version };
  });
  io.server.rpcHandlers.reverse_posted_income_expense_v2 = args => canonical('reverse', args, { v: args.p_voucher, cb: args.p_cashbook, on: args.p_posted_on, r: args.p_reason }, row => {
    if (row.posting_status !== 'POSTED') return { error: { code: '55000', message: 'only an APPROVED+POSTED voucher can be reversed' } };
    Object.assign(row, { posting_status: 'REVERSED', posting_version: Number(row.posting_version) + 1 });
    return { voucherId: row.id, reversalPostingId: 'r1', postingStatus: 'REVERSED', postingVersion: row.posting_version };
  });
});
afterEach(() => { vi.useRealTimers(); });

describe('duyệt phiếu V2', () => {
  const approve = () => fn<{ voucherId: string; expectedApprovalVersion: number }>(() => useApproveIncomeExpenseV2());
  it('lệnh không tới máy chủ: bấm lại gửi lại NGAY đúng mã cũ, duyệt một lần', async () => {
    io.server.failNext('approve_income_expense_v2', 'rpc', 'drop-before');
    await expect(approve()({ voucherId: 'v1', expectedApprovalVersion: 1 })).rejects.toBeTruthy();
    await expect(approve()({ voucherId: 'v1', expectedApprovalVersion: 1 })).resolves.toMatchObject({ approvalStatus: 'APPROVED' });
    const keys = sent('approve_income_expense_v2').map(call => keyOf(call.args));
    expect(keys).toHaveLength(2); expect(keys[1]).toBe(keys[0]);
    expect(voucher().approval_version).toBe(2);
    expect(pendingKeys()).toEqual([]);
  });
  it('lệnh tới nhưng mất phản hồi: gửi lại cùng mã, máy chủ trả kết quả cũ, không duyệt lần hai', async () => {
    io.server.failNext('approve_income_expense_v2', 'rpc', 'drop-after');
    await expect(approve()({ voucherId: 'v1', expectedApprovalVersion: 1 })).rejects.toBeTruthy();
    await expect(approve()({ voucherId: 'v1', expectedApprovalVersion: 1 })).resolves.toMatchObject({ approvalStatus: 'APPROVED', approvalVersion: 2 });
    expect(voucher().approval_version).toBe(2);
    expect(pendingKeys()).toEqual([]);
  });
  it('dấu cũ gieo sẵn (không có dấu vân tay nội dung): đọc trạng thái phiếu; còn Chờ duyệt ⇒ gửi lại đúng mã cũ', async () => {
    seedLegacyPending({ namespace: 'voucher-v2-approve', userId: 'actor', organizationId: 'org-a', businessKey: 'v1' }, new Date(T0 - 10 * 60_000));
    await expect(approve()({ voucherId: 'v1', expectedApprovalVersion: 1 })).resolves.toMatchObject({ approvalStatus: 'APPROVED' });
    expect(keyOf(sent('approve_income_expense_v2')[0].args)).toBe('legacy-attempt');
    expect(pendingKeys()).toEqual([]);
  });
  it('dấu cũ gieo sẵn mà phiếu đã duyệt: báo kèm mã phiếu, không gửi', async () => {
    Object.assign(voucher(), { approval_status: 'APPROVED', approval_version: 2 });
    seedLegacyPending({ namespace: 'voucher-v2-approve', userId: 'actor', organizationId: 'org-a', businessKey: 'v1' }, new Date(T0 - 10 * 60_000));
    await expect(approve()({ voucherId: 'v1', expectedApprovalVersion: 1 })).rejects.toMatchObject({ outcome: 'failure', message: expect.stringContaining('PC2511009') });
    expect(sent('approve_income_expense_v2')).toHaveLength(0);
    expect(pendingKeys()).toEqual([]);
  });
});

describe('ghi sổ phiếu đã duyệt V2', () => {
  beforeEach(() => { Object.assign(voucher(), { approval_status: 'APPROVED', approval_version: 2 }); });
  const input = { subjectKind: 'VOUCHER', subjectId: 'v1', cashbookId: 'a1', postedOn: '2026-11-25', evidenceIds: ['e1'], expectedExecutionRevision: 1, expectedApprovalVersion: 2, expectedPostingVersion: 1, idempotencyKey: 'ui-key' };
  const post = () => fn<typeof input>(() => usePostApprovedIncomeExpenseV2());
  it('lệnh tới nhưng mất phản hồi: cùng nội dung ⇒ gửi lại cùng mã, máy chủ trả kết quả cũ', async () => {
    io.server.failNext('post_approved_income_expense_v2', 'rpc', 'drop-after');
    await expect(post()(input)).rejects.toBeTruthy();
    await expect(post()({ ...input, idempotencyKey: 'ui-key-2' })).resolves.toMatchObject({ postingStatus: 'POSTED' });
    expect(voucher().posting_version).toBe(2);
    expect(pendingKeys()).toEqual([]);
  });
  it('lệnh không tới máy chủ, lần sau đổi chứng từ (trong 2 phút): phiếu còn chưa ghi sổ ⇒ gửi lại ngay đúng mã cũ', async () => {
    io.server.failNext('post_approved_income_expense_v2', 'rpc', 'drop-before');
    await expect(post()(input)).rejects.toBeTruthy();
    await expect(post()({ ...input, evidenceIds: ['e2'] })).resolves.toMatchObject({ postingStatus: 'POSTED' });
    const calls = sent('post_approved_income_expense_v2');
    expect(calls).toHaveLength(2); expect(keyOf(calls[1].args)).toBe(keyOf(calls[0].args));
    expect(pendingKeys()).toEqual([]);
  });
  it('lệnh tới nhưng mất phản hồi, lần sau đổi chứng từ: đọc thấy đã ghi sổ, báo, không gửi', async () => {
    io.server.failNext('post_approved_income_expense_v2', 'rpc', 'drop-after');
    await expect(post()(input)).rejects.toBeTruthy();
    await expect(post()({ ...input, evidenceIds: ['e2'] })).rejects.toMatchObject({ outcome: 'failure', message: expect.stringContaining('PC2511009') });
    expect(sent('post_approved_income_expense_v2')).toHaveLength(1);
    expect(pendingKeys()).toEqual([]);
  });
});

describe('hoàn tác ghi sổ V2 qua ngày', () => {
  beforeEach(() => { Object.assign(voucher(), { approval_status: 'APPROVED', posting_status: 'POSTED', approval_version: 2, posting_version: 2 }); });
  const reverse = () => fn<{ voucherId: string; cashbookId: string; reason?: string }>(() => useReversePostingV2());
  it('lệnh tới nhưng mất phản hồi, bấm lại hôm sau: nội dung đã đổi (ngày ghi) ⇒ đọc trạng thái, đã hoàn tác ⇒ báo, không gửi', async () => {
    io.server.failNext('reverse_posted_income_expense_v2', 'rpc', 'drop-after');
    await expect(reverse()({ voucherId: 'v1', cashbookId: 'a1', reason: 'Chi nhầm sổ' })).rejects.toBeTruthy();
    vi.setSystemTime(T0 + 26 * 60 * 60_000);
    await expect(reverse()({ voucherId: 'v1', cashbookId: 'a1', reason: 'Chi nhầm sổ' })).rejects.toMatchObject({ outcome: 'failure', message: expect.stringContaining('đã hoàn tác') });
    expect(sent('reverse_posted_income_expense_v2')).toHaveLength(1);
    expect(pendingKeys()).toEqual([]);
  });
  it('lệnh không tới máy chủ, bấm lại hôm sau: phiếu vẫn đã ghi sổ ⇒ gửi lại đúng mã cũ với ngày mới', async () => {
    io.server.failNext('reverse_posted_income_expense_v2', 'rpc', 'drop-before');
    await expect(reverse()({ voucherId: 'v1', cashbookId: 'a1', reason: 'Chi nhầm sổ' })).rejects.toBeTruthy();
    vi.setSystemTime(T0 + 26 * 60 * 60_000);
    await expect(reverse()({ voucherId: 'v1', cashbookId: 'a1', reason: 'Chi nhầm sổ' })).resolves.toMatchObject({ postingStatus: 'REVERSED' });
    const calls = sent('reverse_posted_income_expense_v2');
    expect(calls).toHaveLength(2); expect(keyOf(calls[1].args)).toBe(keyOf(calls[0].args));
    expect(calls[1].args.p_posted_on).not.toBe(calls[0].args.p_posted_on);
    expect(pendingKeys()).toEqual([]);
  });
});
