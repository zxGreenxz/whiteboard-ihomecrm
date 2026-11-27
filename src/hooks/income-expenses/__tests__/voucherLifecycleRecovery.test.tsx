// @vitest-environment jsdom
// Đợt 5: bảy thao tác trên một phiếu thu chi không còn chung một dấu `voucher-lifecycle`. Duyệt, huỷ linh hoạt, huỷ phiếu
// thu chạy lại (cách A: máy chủ khoá phiếu rồi trả «đã làm»); bỏ duyệt, khôi phục, huỷ đường cũ, «đã kiểm» đọc trạng thái
// phiếu rồi so với lúc bấm (cách C). Máy chủ giả dựng theo thân hàm production đọc ngày 25/11/2026.
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRecordServer, pendingKeys, seedLegacyPending, type FakeRecordServer } from '../../__tests__/fakeRecordServer';

const io = vi.hoisted(() => ({ server: undefined as unknown as FakeRecordServer, serverBeforeMigration: false, verifyWrites: 0 }));
vi.mock('@tanstack/react-query', () => ({ useMutation: (config: unknown) => config, useQuery: (config: unknown) => config, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (table: string) => io.server.from(table), get rpc() { return io.server.rpc; } } }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor' }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() } }));

import { useApproveVoucher, useCancelIncomeExpense, useRestoreIncomeExpense, useUnapproveVoucher, useVerifyIncomeExpense } from '../statusMutations';
import { useCancelVoucherFlex } from '../flexMutations';
import { useCancelIncomeVoucher } from '../incomeVoucherCancel';

type Row = Record<string, unknown>;
const fn = <I, O = unknown>(hook: () => unknown) => {
  const { result } = renderHook(hook);
  return (result.current as { mutationFn: (input: I) => Promise<O> }).mutationFn;
};
const voucher = () => io.server.rows.income_expenses.find(row => row.id === 'v1') as Row;
const calls = (name: string) => io.server.rpcCalls.filter(call => call.name === name).length;
const legacyScope = (id = 'v1') => ({ namespace: 'voucher-lifecycle', userId: 'actor', organizationId: 'actor-scope', businessKey: id });
const T0 = Date.parse('2026-11-25T02:00:00.000Z');
const later = (ms: number) => vi.setSystemTime(Date.now() + ms);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  localStorage.clear();
  io.server = fakeRecordServer();
  io.serverBeforeMigration = false;
  io.verifyWrites = 0;
  io.server.rows.income_expenses = ['v1', 'v2'].map(id => ({
    id, code: id === 'v1' ? 'PC2511001' : 'PC2511002', type: 'EXPENSE', payment_id: null, account_id: 'a1',
    approval_status: 'UNAPPROVED', posting_status: 'UNPOSTED', approval_version: 1, posting_version: 1, verified_at: null,
  }));
  const find = (id: unknown) => io.server.rows.income_expenses.find(row => row.id === id) as Row;
  const h = io.server.rpcHandlers;
  // set_termination_forfeit_status_v1: phiếu thường không phải cặp bỏ cọc.
  h.set_termination_forfeit_status_v1 = () => ({ data: null, error: { code: '55000', message: 'Voucher is not a termination forfeit pair' } });
  // approve_pending_income_expense_checked_v1: khoá phiếu, đã duyệt ⇒ already.
  h.approve_pending_income_expense_checked_v1 = args => {
    const row = find(args.p_voucher);
    if (row.approval_status === 'APPROVED') return { data: { id: row.id, approved: true, already: true }, error: null };
    if (row.approval_version !== args.p_expected_approval_version) return { data: null, error: { code: 'PT409', message: 'Phiếu vừa được sửa' } };
    Object.assign(row, { approval_status: 'APPROVED', approval_version: Number(row.approval_version) + 1 });
    return { data: { id: row.id, approved: true, already: false, mode: 'VOUCHER' }, error: null };
  };
  // unapprove_voucher: khoá phiếu nhưng KHÔNG xét trạng thái hiện tại (mỗi lần chạy lên phiên bản).
  h.unapprove_voucher = args => {
    const row = find(args.voucher_id);
    Object.assign(row, { approval_status: 'UNAPPROVED', approval_version: Number(row.approval_version) + 1 });
    return { data: null, error: null };
  };
  // restore_income_expense: không khoá dòng; phiếu không ở Đã huỷ ⇒ P0001.
  h.restore_income_expense = args => {
    const row = find(args.p_id);
    if (row.approval_status !== 'CANCELLED') return { data: null, error: { code: 'P0001', message: 'Phiếu không ở trạng thái Đã huỷ' } };
    Object.assign(row, { approval_status: 'APPROVED' });
    return { data: { id: row.id, restored_payment_id: null }, error: null };
  };
  // verify_income_expense_v1 sau migration đợt 10c (md5 prosrc 5c6cc367…): không p_verified ⇒ bật/tắt như cũ, trả NULL;
  // có p_verified ⇒ khoá phiếu, so, đúng giá trị rồi thì {changed:false} không ghi; khác thì đặt đúng giá trị.
  h.verify_income_expense_v1 = args => {
    if (io.serverBeforeMigration && 'p_verified' in args) return { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.verify_income_expense_v1(p_id, p_note, p_verified) in the schema cache' } };
    const row = find(args.p_id);
    if (typeof args.p_verified !== 'boolean') { row.verified_at = row.verified_at ? null : new Date().toISOString(); return { data: null, error: null }; }
    const changed = (row.verified_at !== null) !== args.p_verified;
    if (changed) { row.verified_at = args.p_verified ? new Date().toISOString() : null; io.verifyWrites += 1; }
    return { data: { id: row.id, changed, verified: args.p_verified, verified_at: row.verified_at, verified_by_name: row.verified_at ? 'Nhân viên A' : null }, error: null };
  };
  const cancelLocked = (args: Row) => {
    const row = find(args.p_voucher);
    if (row.approval_status === 'CANCELLED') return { data: { id: row.id, changed: false, reason: 'đã huỷ trước đó' }, error: null };
    Object.assign(row, { approval_status: 'CANCELLED', approval_version: Number(row.approval_version) + 1 });
    return { data: { id: row.id, changed: true, cancellation_kind: 'CANCELLED_UNPOSTED', mode: 'MANUAL' }, error: null };
  };
  h.cancel_income_expense_flex_v1 = cancelLocked;
  h.cancel_income_voucher_v1 = cancelLocked;
  // reverse_posted_income_expense_v2: khoá phiếu rồi tra mã yêu cầu; mã đã xong ⇒ trả kết quả cũ.
  const reverseOps = new Map<string, Row>();
  h.reverse_posted_income_expense_v2 = args => {
    const done = reverseOps.get(String(args.p_idempotency_key));
    if (done) return { data: done, error: null };
    const row = find(args.p_voucher);
    if (row.posting_status !== 'POSTED') return { data: null, error: { code: '55000', message: 'only an APPROVED+POSTED voucher can be reversed' } };
    Object.assign(row, { posting_status: 'REVERSED', posting_version: Number(row.posting_version) + 1 });
    const receipt = { voucherId: row.id, postingStatus: 'REVERSED', postingVersion: row.posting_version };
    reverseOps.set(String(args.p_idempotency_key), receipt);
    return { data: receipt, error: null };
  };
  h.cancel_income_expense_v1 = args => {
    const row = find(args.p_voucher_id);
    if (row.approval_status !== 'CANCELLED') Object.assign(row, { approval_status: 'CANCELLED', approval_version: Number(row.approval_version) + 1 });
    return { data: null, error: null };
  };
});
afterEach(() => { vi.useRealTimers(); });

describe('duyệt phiếu (cách A)', () => {
  const approve = () => fn<{ id: string; expectedApprovalVersion: number }, { already?: boolean; resent?: boolean }>(() => useApproveVoucher());
  it('lệnh không tới máy chủ: bấm lại gửi lại ngay, duyệt đúng một lần, dấu được gỡ', async () => {
    io.server.failNext('approve_pending_income_expense_checked_v1', 'rpc', 'drop-before');
    await expect(approve()({ id: 'v1', expectedApprovalVersion: 1 })).rejects.toMatchObject({ outcome: 'unknown' });
    await expect(approve()({ id: 'v1', expectedApprovalVersion: 1 })).resolves.toMatchObject({ already: false });
    expect(voucher()).toMatchObject({ approval_status: 'APPROVED', approval_version: 2 });
    expect(pendingKeys()).toEqual([]);
  });
  it('lệnh tới nhưng mất phản hồi: gửi lại, máy chủ trả «đã duyệt», không duyệt lần hai', async () => {
    io.server.failNext('approve_pending_income_expense_checked_v1', 'rpc', 'drop-after');
    await expect(approve()({ id: 'v1', expectedApprovalVersion: 1 })).rejects.toMatchObject({ outcome: 'unknown' });
    await expect(approve()({ id: 'v1', expectedApprovalVersion: 1 })).resolves.toMatchObject({ already: true });
    expect(voucher()).toMatchObject({ approval_status: 'APPROVED', approval_version: 2 });
    expect(pendingKeys()).toEqual([]);
  });
  it('dấu khoá chung bản trước của đúng phiếu: chặn, không gửi; phiếu khác duyệt được', async () => {
    seedLegacyPending(legacyScope('v1'), new Date(T0 - 10 * 60_000));
    await expect(approve()({ id: 'v1', expectedApprovalVersion: 1 })).rejects.toMatchObject({ message: expect.stringContaining('đối chiếu') });
    expect(calls('approve_pending_income_expense_checked_v1')).toBe(0);
    await expect(approve()({ id: 'v2', expectedApprovalVersion: 1 })).resolves.toMatchObject({ already: false });
  });
  it('duyệt kẹt không chặn huỷ chính phiếu đó', async () => {
    io.server.failNext('approve_pending_income_expense_checked_v1', 'rpc', 'drop-before');
    await expect(approve()({ id: 'v1', expectedApprovalVersion: 1 })).rejects.toMatchObject({ outcome: 'unknown' });
    await expect(fn<{ voucherId: string; reason: string }>(() => useCancelVoucherFlex())({ voucherId: 'v1', reason: 'Ghi phiếu bị trùng' })).resolves.toMatchObject({ changed: true });
  });
});

describe.each([
  ['huỷ linh hoạt', 'cancel_income_expense_flex_v1', () => useCancelVoucherFlex()],
  ['huỷ phiếu thu', 'cancel_income_voucher_v1', () => useCancelIncomeVoucher()],
] as const)('%s (cách A)', (_label, rpcName, hook) => {
  const cancel = () => fn<{ voucherId: string; reason: string }, { changed: boolean }>(hook);
  it('lệnh không tới máy chủ: bấm lại huỷ ngay', async () => {
    io.server.failNext(rpcName, 'rpc', 'drop-before');
    await expect(cancel()({ voucherId: 'v1', reason: 'Ghi phiếu bị trùng' })).rejects.toMatchObject({ outcome: 'unknown' });
    await expect(cancel()({ voucherId: 'v1', reason: 'Ghi phiếu bị trùng' })).resolves.toMatchObject({ changed: true });
    expect(pendingKeys()).toEqual([]);
  });
  it('lệnh tới nhưng mất phản hồi: gửi lại, máy chủ trả «đã huỷ trước đó», huỷ đúng một lần', async () => {
    io.server.failNext(rpcName, 'rpc', 'drop-after');
    await expect(cancel()({ voucherId: 'v1', reason: 'Ghi phiếu bị trùng' })).rejects.toMatchObject({ outcome: 'unknown' });
    await expect(cancel()({ voucherId: 'v1', reason: 'Ghi phiếu bị trùng' })).resolves.toMatchObject({ changed: false });
    expect(voucher()).toMatchObject({ approval_status: 'CANCELLED', approval_version: 2 });
    expect(pendingKeys()).toEqual([]);
  });
  it('dấu khoá chung bản trước: chặn đúng phiếu đó, không gửi', async () => {
    seedLegacyPending(legacyScope('v1'), new Date(T0 - 10 * 60_000));
    await expect(cancel()({ voucherId: 'v1', reason: 'Ghi phiếu bị trùng' })).rejects.toMatchObject({ message: expect.stringContaining('đối chiếu') });
    expect(calls(rpcName)).toBe(0);
  });
});

describe('bỏ duyệt phiếu (cách C)', () => {
  beforeEach(() => { Object.assign(io.server.rows.income_expenses[0], { approval_status: 'APPROVED', approval_version: 2 }); });
  const unapprove = () => fn<string, unknown>(() => useUnapproveVoucher());
  it('lệnh không tới máy chủ: dưới 2 phút chờ, quá 2 phút gửi lại, bỏ duyệt đúng một lần', async () => {
    io.server.failNext('unapprove_voucher', 'rpc', 'drop-before');
    await expect(unapprove()('v1')).rejects.toMatchObject({ outcome: 'unknown' });
    await expect(unapprove()('v1')).rejects.toMatchObject({ message: expect.stringContaining('đang chờ kết quả') });
    expect(calls('unapprove_voucher')).toBe(1);
    later(130_000);
    await expect(unapprove()('v1')).resolves.toBe(false);
    expect(voucher()).toMatchObject({ approval_status: 'UNAPPROVED', approval_version: 3 });
    expect(pendingKeys()).toEqual([]);
  });
  it('lệnh tới nhưng mất phản hồi: đọc thấy đã Chờ duyệt, báo kèm mã phiếu, không gửi lần hai', async () => {
    io.server.failNext('unapprove_voucher', 'rpc', 'drop-after');
    await expect(unapprove()('v1')).rejects.toMatchObject({ outcome: 'unknown' });
    await expect(unapprove()('v1')).rejects.toMatchObject({ outcome: 'failure', message: expect.stringContaining('PC2511001') });
    expect(calls('unapprove_voucher')).toBe(1);
    expect(voucher()).toMatchObject({ approval_version: 3 });
    expect(pendingKeys()).toEqual([]);
  });
  it('dấu khoá chung bản trước: chặn, không gửi', async () => {
    seedLegacyPending(legacyScope('v1'), new Date(T0 - 10 * 60_000));
    await expect(unapprove()('v1')).rejects.toMatchObject({ message: expect.stringContaining('đối chiếu') });
    expect(calls('unapprove_voucher')).toBe(0);
  });
  it('phiếu bị người khác sửa giữa chừng (phiên bản đổi, vẫn Đã duyệt): báo trạng thái hiện tại, không gửi', async () => {
    io.server.failNext('unapprove_voucher', 'rpc', 'drop-before');
    await expect(unapprove()('v1')).rejects.toMatchObject({ outcome: 'unknown' });
    voucher().approval_version = 7;
    later(130_000);
    await expect(unapprove()('v1')).rejects.toMatchObject({ outcome: 'failure', message: expect.stringContaining('đã đổi kể từ lần gửi trước') });
    expect(calls('unapprove_voucher')).toBe(1);
    expect(pendingKeys()).toEqual([]);
  });
});

describe('khôi phục phiếu (cách C)', () => {
  beforeEach(() => { Object.assign(io.server.rows.income_expenses[0], { approval_status: 'CANCELLED', approval_version: 3 }); });
  const restore = () => fn<string, unknown>(() => useRestoreIncomeExpense());
  it('lệnh không tới máy chủ: quá 2 phút gửi lại, khôi phục được', async () => {
    io.server.failNext('restore_income_expense', 'rpc', 'drop-before');
    await expect(restore()('v1')).rejects.toMatchObject({ outcome: 'unknown' });
    later(130_000);
    await expect(restore()('v1')).resolves.toMatchObject({ approval_status: 'APPROVED' });
    expect(calls('restore_income_expense')).toBe(2);
    expect(pendingKeys()).toEqual([]);
  });
  it('lệnh tới nhưng mất phản hồi: đọc thấy đã khôi phục, báo, không gửi lần hai', async () => {
    io.server.failNext('restore_income_expense', 'rpc', 'drop-after');
    await expect(restore()('v1')).rejects.toMatchObject({ outcome: 'unknown' });
    await expect(restore()('v1')).rejects.toMatchObject({ outcome: 'failure', message: expect.stringContaining('PC2511001') });
    expect(calls('restore_income_expense')).toBe(1);
    expect(pendingKeys()).toEqual([]);
  });
  it('dấu khoá chung bản trước: chặn, không gửi', async () => {
    seedLegacyPending(legacyScope('v1'), new Date(T0 - 10 * 60_000));
    await expect(restore()('v1')).rejects.toMatchObject({ message: expect.stringContaining('đối chiếu') });
    expect(calls('restore_income_expense')).toBe(0);
  });
});

describe('«đã kiểm» (đợt 10c: đặt giá trị, cách A)', () => {
  type VerifyResult = { verified_at: string | null; changed?: boolean; resent?: boolean };
  const verify = () => fn<{ id: string; note: string | null; verified: boolean }, VerifyResult>(() => useVerifyIncomeExpense());
  const verifyCalls = () => io.server.rpcCalls.filter(call => call.name === 'verify_income_expense_v1');
  const verifyScope = { namespace: 'voucher-verify', userId: 'actor', organizationId: 'actor-scope', businessKey: 'v1' };
  /** Dấu «đã kiểm» do bản đợt 5 ghi (nút bật/tắt): chỉ có chữ ký trạng thái lúc bấm, không có giá trị đặt. */
  const seedToggleEraPending = (before: string, startedAt: Date) => localStorage.setItem(
    'ihome:financial-pending:v1:voucher-verify:actor:actor-scope:v1',
    JSON.stringify({ ...verifyScope, attemptId: 'dot5-old', requestKey: 'dot5-old', completedIds: [], startedAt: startedAt.toISOString(), operation: 'cập nhật trạng thái đã kiểm', meta: { before } }));
  afterEach(() => {
    // Mọi lệnh trình duyệt mới gửi đều là ĐẶT giá trị; không bao giờ bật/tắt, không rơi về hàm đường cũ.
    expect(verifyCalls().every(call => typeof call.args.p_verified === 'boolean')).toBe(true);
    expect(calls('verify_income_expense')).toBe(0);
  });

  it('lệnh không tới máy chủ: bấm lại gửi lại NGAY (không chờ 2 phút), đánh dấu đúng một lần, dấu được gỡ', async () => {
    io.server.failNext('verify_income_expense_v1', 'rpc', 'drop-before');
    await expect(verify()({ id: 'v1', note: null, verified: true })).rejects.toMatchObject({ outcome: 'unknown' });
    await expect(verify()({ id: 'v1', note: null, verified: true })).resolves.toMatchObject({ changed: true, resent: true });
    expect(voucher().verified_at).not.toBeNull();
    expect(io.verifyWrites).toBe(1);
    expect(pendingKeys()).toEqual([]);
  });
  it('lệnh tới nhưng mất phản hồi: gửi lại ngay, máy chủ trả «không đổi» — KHÔNG đảo ngược, chỉ một lần đổi', async () => {
    io.server.failNext('verify_income_expense_v1', 'rpc', 'drop-after');
    await expect(verify()({ id: 'v1', note: null, verified: true })).rejects.toMatchObject({ outcome: 'unknown' });
    await expect(verify()({ id: 'v1', note: null, verified: true })).resolves.toMatchObject({ changed: false, resent: true });
    expect(voucher().verified_at).not.toBeNull();
    expect(io.verifyWrites).toBe(1);
    expect(verifyCalls().map(call => call.args.p_verified)).toEqual([true, true]);
    expect(pendingKeys()).toEqual([]);
  });
  it('bỏ kiểm mất phản hồi rồi bấm lại: vẫn «Chưa kiểm», không đánh dấu lại', async () => {
    voucher().verified_at = '2026-11-24T01:00:00.000Z';
    io.server.failNext('verify_income_expense_v1', 'rpc', 'drop-after');
    await expect(verify()({ id: 'v1', note: null, verified: false })).rejects.toMatchObject({ outcome: 'unknown' });
    await expect(verify()({ id: 'v1', note: null, verified: false })).resolves.toMatchObject({ changed: false, verified_at: null });
    expect(voucher().verified_at).toBeNull();
    expect(io.verifyWrites).toBe(1);
  });
  it('dấu đặt giá trị còn treo, người dùng chọn giá trị KHÁC: chờ lệnh cũ xong (2 phút) rồi mới gửi giá trị mới', async () => {
    io.server.failNext('verify_income_expense_v1', 'rpc', 'drop-after');
    await expect(verify()({ id: 'v1', note: null, verified: true })).rejects.toMatchObject({ outcome: 'unknown' });
    await expect(verify()({ id: 'v1', note: null, verified: false })).rejects.toMatchObject({ message: expect.stringContaining('đang chờ kết quả') });
    expect(verifyCalls()).toHaveLength(1);
    later(130_000);
    await expect(verify()({ id: 'v1', note: null, verified: false })).resolves.toMatchObject({ changed: true, verified_at: null });
    expect(voucher().verified_at).toBeNull();
    expect(pendingKeys()).toEqual([]);
  });
  it('biên nhận sai phiếu, sai giá trị, thiếu «changed» hay đọc lại lệch giá trị không phải thành công: giữ dấu, lần sau gửi lại', async () => {
    const real = io.server.rpcHandlers.verify_income_expense_v1;
    // Biên nhận nói giá trị ngược với giá trị đã gửi (dù phép đọc lại thấy đúng): không tin biên nhận.
    io.server.rpcHandlers.verify_income_expense_v1 = args => { voucher().verified_at = args.p_verified ? new Date().toISOString() : null; return { data: { id: 'v1', changed: true, verified: !args.p_verified }, error: null }; };
    await expect(verify()({ id: 'v1', note: null, verified: true })).rejects.toMatchObject({ outcome: 'unknown' });
    expect(pendingKeys()).toHaveLength(1);
    voucher().verified_at = null;
    io.server.rpcHandlers.verify_income_expense_v1 = () => ({ data: { id: 'v2', changed: true, verified: true }, error: null });
    await expect(verify()({ id: 'v1', note: null, verified: true })).rejects.toMatchObject({ outcome: 'unknown' });
    io.server.rpcHandlers.verify_income_expense_v1 = () => ({ data: { id: 'v1', verified: true }, error: null });
    await expect(verify()({ id: 'v1', note: null, verified: true })).rejects.toMatchObject({ outcome: 'unknown' });
    // Máy chủ báo đã đặt nhưng phép đọc lại vẫn thấy «Chưa kiểm».
    io.server.rpcHandlers.verify_income_expense_v1 = () => ({ data: { id: 'v1', changed: true, verified: true }, error: null });
    await expect(verify()({ id: 'v1', note: null, verified: true })).rejects.toMatchObject({ outcome: 'unknown' });
    io.server.rpcHandlers.verify_income_expense_v1 = real;
    await expect(verify()({ id: 'v1', note: null, verified: true })).resolves.toMatchObject({ changed: true });
    expect(pendingKeys()).toEqual([]);
  });
  it.each([
    ['PGRST202', 'Could not find the function public.verify_income_expense_v1(p_id, p_note, p_verified) in the schema cache'],
    ['42883', 'function public.verify_income_expense_v1(p_id => uuid, p_note => text, p_verified => boolean) does not exist'],
  ])('web lên trước migration (%s, hàm chưa có p_verified): từ chối rõ, không dấu, không đổi phiếu, không gọi bản bật/tắt', async (code, message) => {
    io.server.rpcHandlers.verify_income_expense_v1 = () => ({ data: null, error: { code, message } });
    await expect(verify()({ id: 'v1', note: null, verified: true })).rejects.toMatchObject({ outcome: 'failure', message: expect.stringContaining('Máy chủ chưa cập nhật') });
    expect(voucher().verified_at).toBeNull();
    expect(pendingKeys()).toEqual([]);
    expect(verifyCalls()).toHaveLength(1);
  });
  it('máy chủ thật trước migration (bản hai tham số): lời gọi có p_verified nhận PGRST202 ⇒ từ chối rõ', async () => {
    io.serverBeforeMigration = true;
    await expect(verify()({ id: 'v1', note: null, verified: true })).rejects.toMatchObject({ outcome: 'failure', message: expect.stringContaining('Máy chủ chưa cập nhật') });
    expect(voucher().verified_at).toBeNull();
    expect(pendingKeys()).toEqual([]);
  });
  it('thiếu giá trị đặt: từ chối trước khi ghi dấu, không gửi gì', async () => {
    await expect(verify()({ id: 'v1', note: null } as unknown as { id: string; note: string | null; verified: boolean })).rejects.toMatchObject({ outcome: 'failure', message: expect.stringContaining('Thiếu trạng thái') });
    expect(verifyCalls()).toHaveLength(0);
    expect(pendingKeys()).toEqual([]);
  });
  it('dấu bản trước (bật/tắt, đợt 5) mà trạng thái đã đổi so với lúc bấm: báo kèm mã phiếu, KHÔNG gửi', async () => {
    voucher().verified_at = '2026-11-24T01:00:00.000Z';
    seedToggleEraPending('chua-kiem', new Date(T0 - 10 * 60_000));
    await expect(verify()({ id: 'v1', note: null, verified: false })).rejects.toMatchObject({ outcome: 'failure', message: expect.stringContaining('PC2511001') });
    expect(verifyCalls()).toHaveLength(0);
    expect(voucher().verified_at).not.toBeNull();
    expect(pendingKeys()).toEqual([]);
  });
  it('dấu bản trước như lúc bấm: dưới 2 phút chờ, quá 2 phút gửi lại bằng lệnh ĐẶT giá trị (không bật/tắt)', async () => {
    seedToggleEraPending('chua-kiem', new Date(T0 - 60_000));
    await expect(verify()({ id: 'v1', note: null, verified: true })).rejects.toMatchObject({ message: expect.stringContaining('đang chờ kết quả') });
    expect(verifyCalls()).toHaveLength(0);
    later(70_000);
    await expect(verify()({ id: 'v1', note: null, verified: true })).resolves.toMatchObject({ changed: true });
    expect(verifyCalls().map(call => call.args.p_verified)).toEqual([true]);
    expect(pendingKeys()).toEqual([]);
  });
  it('dấu khoá chung bản trước: chặn, không gửi', async () => {
    seedLegacyPending(legacyScope('v1'), new Date(T0 - 10 * 60_000));
    await expect(verify()({ id: 'v1', note: null, verified: true })).rejects.toMatchObject({ message: expect.stringContaining('đối chiếu') });
    expect(calls('verify_income_expense_v1')).toBe(0);
  });
});

describe('huỷ phiếu đường cũ, nhiều bước (cách C)', () => {
  const cancel = () => fn<string | { id: string; reason?: string | null }, boolean | 'unchanged'>(() => useCancelIncomeExpense());
  it('lệnh không tới máy chủ: quá 2 phút gửi lại, huỷ được', async () => {
    io.server.failNext('cancel_income_expense_v1', 'rpc', 'drop-before');
    await expect(cancel()('v1')).rejects.toMatchObject({ outcome: 'unknown' });
    later(130_000);
    await expect(cancel()('v1')).resolves.toBe(false);
    expect(voucher().approval_status).toBe('CANCELLED');
    expect(pendingKeys()).toEqual([]);
  });
  it('lệnh tới nhưng mất phản hồi: đọc thấy đã huỷ, báo «không thay đổi», không gửi lần hai', async () => {
    io.server.failNext('cancel_income_expense_v1', 'rpc', 'drop-after');
    await expect(cancel()('v1')).rejects.toMatchObject({ outcome: 'unknown' });
    await expect(cancel()('v1')).resolves.toBe('unchanged');
    expect(calls('cancel_income_expense_v1')).toBe(1);
    expect(pendingKeys()).toEqual([]);
  });
  it('đã hoàn tác bút toán nhưng lệnh huỷ không tới: lần sau chỉ chạy bước huỷ, không hoàn tác lần hai', async () => {
    Object.assign(voucher(), { approval_status: 'APPROVED', posting_status: 'POSTED', approval_version: 2 });
    io.server.failNext('cancel_income_expense_v1', 'rpc', 'drop-before');
    await expect(cancel()('v1')).rejects.toMatchObject({ completedIds: ['v1'] });
    expect(voucher()).toMatchObject({ posting_status: 'REVERSED', approval_status: 'APPROVED' });
    await expect(cancel()('v1')).rejects.toMatchObject({ message: expect.stringContaining('đang chờ kết quả') });
    later(130_000);
    await expect(cancel()('v1')).resolves.toBe(false);
    expect(calls('reverse_posted_income_expense_v2')).toBe(1);
    expect(voucher()).toMatchObject({ approval_status: 'CANCELLED', posting_status: 'REVERSED' });
    expect(pendingKeys()).toEqual([]);
  });
  it('dấu khoá chung bản trước: chặn, không gửi', async () => {
    seedLegacyPending(legacyScope('v1'), new Date(T0 - 10 * 60_000));
    await expect(cancel()('v1')).rejects.toMatchObject({ message: expect.stringContaining('đối chiếu') });
    expect(calls('cancel_income_expense_v1')).toBe(0);
  });
  it('phiếu thu đường cũ đã huỷ nhưng khoản thanh toán còn sống: chỉ gỡ khoản đó (sau 2 phút), không huỷ lại phiếu', async () => {
    Object.assign(voucher(), { type: 'INCOME', payment_id: 'p1', approval_status: 'CANCELLED' });
    io.server.rows.payments = [{ id: 'p1', reversed_at: null }];
    seedLegacyPending({ namespace: 'voucher-cancel', userId: 'actor', organizationId: 'actor-scope', businessKey: 'v1' }, new Date(T0 - 60_000), ['v1']);
    await expect(cancel()('v1')).rejects.toMatchObject({ message: expect.stringContaining('đang chờ kết quả') });
    later(130_000);
    await expect(cancel()('v1')).resolves.toBe(false);
    expect(io.server.rows.payments).toEqual([]);
    expect(calls('cancel_income_expense_v1')).toBe(0);
    expect(pendingKeys()).toEqual([]);
  });
  it('phiếu thu đã huỷ mà khoản thanh toán đã đánh dấu hoàn tác: không xoá gì, báo «không thay đổi»', async () => {
    Object.assign(voucher(), { type: 'INCOME', payment_id: 'p1', approval_status: 'CANCELLED' });
    io.server.rows.payments = [{ id: 'p1', reversed_at: '2026-11-25T01:00:00Z' }];
    seedLegacyPending({ namespace: 'voucher-cancel', userId: 'actor', organizationId: 'actor-scope', businessKey: 'v1' }, new Date(T0 - 10 * 60_000), ['v1']);
    await expect(cancel()('v1')).resolves.toBe('unchanged');
    expect(io.server.rows.payments).toHaveLength(1);
  });
});
