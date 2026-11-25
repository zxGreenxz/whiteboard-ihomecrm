// @vitest-environment jsdom
// Đợt 6 (plan sửa khoá vĩnh viễn sau rớt mạng): chi lương, chốt / mở khoá tháng lương, thưởng/trừ lương.
// Máy chủ giả dựng theo thân hàm production đọc ngày 25/11/2026:
//   - salary_payout_v1 / lock_salary_month_v2 / unlock_salary_month_v2 khoá công ty rồi mới tra mã yêu cầu trong
//     canonical_write_operations: cùng mã cùng phần băm ⇒ trả kết quả cũ; khác phần băm ⇒ 23505. Chi lương KHÔNG băm sổ quỹ,
//     ngày chi, ghi chú.
//   - unlock chỉ mở dòng đang LOCKED.
//   - thưởng/trừ ghi thẳng bảng salary_adjustments (mã khoản nhận giá trị do trình duyệt sinh).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRecordServer, pendingKeys, seedLegacyPending, type FakeRecordServer } from './fakeRecordServer';

const io = vi.hoisted(() => ({ server: undefined as unknown as FakeRecordServer, user: { id: 'actor' } as { id: string } | null }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useRef: (current: unknown) => ({ current }) }));
vi.mock('@tanstack/react-query', () => ({ useMutation: (options: unknown) => options, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => io.user }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (table: string) => io.server.from(table), get rpc() { return io.server.rpc; } } }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/rentSupportSalary', async original => ({ ...await original<typeof import('@/lib/rentSupportSalary')>(), salaryBridgeRequired: async () => false }));

import { useLockSalaryMonth, useSalaryPayout, useSaveSalaryAdjustment, useUnlockSalaryMonth, type SalaryPayoutInput, type SaveAdjustmentInput } from '../useManagerSalary';

type Row = Record<string, unknown>;
const STAFF = '11111111-1111-4111-8111-111111111111';
const PERIOD = '2026-10-01';
const run = <T,>(options: unknown) => (options as { mutationFn: (input: T) => Promise<unknown> }).mutationFn;
const calls = (name: string) => io.server.rpcCalls.filter(call => call.name === name);
const keysOf = (name: string) => calls(name).map(call => call.args.p_idempotency_key);
const vouchers = () => (io.server.rows.income_expenses ?? []);

/** Bảng mã yêu cầu kiểu canonical_write_operations: khoá công ty rồi tra mã (máy chủ giả chạy tuần tự là đúng nghĩa đó). */
function keyed(name: string, hashOf: (args: Row) => string, write: (args: Row) => { data: unknown; error: unknown }) {
  const claims = new Map<string, { hash: string; response: unknown }>();
  io.server.rpcHandlers[name] = args => {
    const key = String(args.p_idempotency_key);
    const claim = claims.get(key);
    if (claim) return claim.hash === hashOf(args) ? { data: claim.response, error: null } : { data: null, error: { code: '23505', message: 'idempotency_key đã dùng với nội dung khác' } };
    const result = write(args);
    if (!result.error) claims.set(key, { hash: hashOf(args), response: result.data });
    return result;
  };
  return claims;
}

const payout = (over: Partial<SalaryPayoutInput> = {}): SalaryPayoutInput => ({
  ownerId: 'owner', staffId: STAFF, staffName: 'Nhân viên mẫu', periodMonth: PERIOD, amount: 4_000_000,
  account_id: 'account-a', voucher_date: '2026-11-05', note: null, rentInvoice: null, profitQuote: null, ...over,
});
const payoutScope = { namespace: 'salary-payout', userId: 'actor', organizationId: 'actor-scope', businessKey: `${STAFF}-${PERIOD}` };
let voucherSeq = 0;
function installPayout() {
  return keyed('salary_payout_v1', args => JSON.stringify([args.p_staff_id, args.p_period_month, args.p_take_home, args.p_rent_invoice_id ?? null, args.p_rent_amount ?? null]), args => {
    const id = `v-${++voucherSeq}`;
    vouchers().push({ id, code: `PC${voucherSeq}`, approval_status: 'UNAPPROVED', posting_status: 'UNPOSTED', account_id: args.p_account_id, voucher_date: args.p_voucher_date });
    return { data: { salary_voucher_id: id, state: 'PENDING_APPROVAL' }, error: null };
  });
}

beforeEach(() => {
  localStorage.clear();
  vi.useRealTimers();
  voucherSeq = 0;
  io.user = { id: 'actor' };
  io.server = fakeRecordServer();
  io.server.rows.income_expenses = [];
});

describe('chi lương (salary_payout_v1, cách B)', () => {
  it('lệnh không tới máy chủ: lần bấm sau gửi lại ngay đúng mã cũ, một phiếu, dấu được gỡ', async () => {
    installPayout();
    io.server.failNext('salary_payout_v1', 'rpc', 'drop-before');
    await expect(run<SalaryPayoutInput>(useSalaryPayout())(payout())).rejects.toBeTruthy();
    await expect(run<SalaryPayoutInput>(useSalaryPayout())(payout())).resolves.toMatchObject({ id: 'v-1', approval_status: 'UNAPPROVED' });
    expect(keysOf('salary_payout_v1')).toHaveLength(2);
    expect(new Set(keysOf('salary_payout_v1')).size).toBe(1);
    expect(vouchers()).toHaveLength(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('tới nhưng mất phản hồi: gửi lại cùng mã nhận lại đúng phiếu cũ, không lập phiếu thứ hai', async () => {
    installPayout();
    io.server.failNext('salary_payout_v1', 'rpc', 'drop-after');
    await expect(run<SalaryPayoutInput>(useSalaryPayout())(payout())).rejects.toBeTruthy();
    expect(vouchers()).toHaveLength(1);
    await expect(run<SalaryPayoutInput>(useSalaryPayout())(payout())).resolves.toMatchObject({ id: 'v-1' });
    expect(new Set(keysOf('salary_payout_v1')).size).toBe(1);
    expect(vouchers()).toHaveLength(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('dấu cũ gieo sẵn (bản trước, không tên thao tác): gửi lại đúng mã của dấu; máy chủ đã có phiếu ⇒ trả phiếu cũ', async () => {
    const claims = installPayout();
    vouchers().push({ id: 'v-old', code: 'PC-OLD', approval_status: 'UNAPPROVED', posting_status: 'UNPOSTED', account_id: 'account-a', voucher_date: '2026-11-05' });
    claims.set('legacy-attempt', { hash: JSON.stringify([STAFF, PERIOD, 4_000_000, null, null]), response: { salary_voucher_id: 'v-old' } });
    seedLegacyPending(payoutScope, new Date(Date.now() - 10 * 60_000));
    await expect(run<SalaryPayoutInput>(useSalaryPayout())(payout())).resolves.toMatchObject({ id: 'v-old', code: 'PC-OLD' });
    expect(keysOf('salary_payout_v1')).toEqual(['legacy-attempt']);
    expect(vouchers()).toHaveLength(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('dấu cũ gieo sẵn mà máy chủ chưa có: gửi lại đúng mã của dấu, lập đúng một phiếu', async () => {
    installPayout();
    seedLegacyPending(payoutScope, new Date(Date.now() - 10 * 60_000));
    await expect(run<SalaryPayoutInput>(useSalaryPayout())(payout())).resolves.toMatchObject({ id: 'v-1' });
    expect(keysOf('salary_payout_v1')).toEqual(['legacy-attempt']);
    expect(vouchers()).toHaveLength(1);
  });

  it('khi đối chiếu không cho đổi sổ quỹ hoặc ngày (máy chủ không băm hai trường này): chặn kèm câu hướng dẫn, không gửi', async () => {
    installPayout();
    io.server.failNext('salary_payout_v1', 'rpc', 'drop-after');
    await expect(run<SalaryPayoutInput>(useSalaryPayout())(payout())).rejects.toBeTruthy();
    await expect(run<SalaryPayoutInput>(useSalaryPayout())(payout({ account_id: 'account-b' }))).rejects.toMatchObject({ message: expect.stringContaining('sổ quỹ, ngày chi') });
    await expect(run<SalaryPayoutInput>(useSalaryPayout())(payout({ voucher_date: '2026-11-06' }))).rejects.toMatchObject({ message: expect.stringContaining('sổ quỹ, ngày chi') });
    expect(calls('salary_payout_v1')).toHaveLength(1);
    expect(pendingKeys()).toHaveLength(1);
    await expect(run<SalaryPayoutInput>(useSalaryPayout())(payout())).resolves.toMatchObject({ id: 'v-1' });
    expect(vouchers()).toHaveLength(1);
  });

  it('dấu cũ không mang dấu vân tay mà máy chủ trả phiếu cũ với sổ quỹ khác: báo đã lập kèm mã, không báo như vừa lập', async () => {
    const claims = installPayout();
    vouchers().push({ id: 'v-old', code: 'PC-OLD', approval_status: 'UNAPPROVED', posting_status: 'UNPOSTED', account_id: 'account-a', voucher_date: '2026-11-05' });
    claims.set('legacy-attempt', { hash: JSON.stringify([STAFF, PERIOD, 4_000_000, null, null]), response: { salary_voucher_id: 'v-old' } });
    seedLegacyPending(payoutScope, new Date(Date.now() - 10 * 60_000));
    await expect(run<SalaryPayoutInput>(useSalaryPayout())(payout({ account_id: 'account-b' }))).rejects.toMatchObject({ outcome: 'failure', alreadyRecorded: true, recordIds: ['v-old'] });
    expect(vouchers()).toHaveLength(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('gửi lại khác số tiền ⇒ máy chủ báo trùng mã: lần trước đã lập, báo đã lập, không lập phiếu thứ hai', async () => {
    installPayout();
    io.server.failNext('salary_payout_v1', 'rpc', 'drop-after');
    await expect(run<SalaryPayoutInput>(useSalaryPayout())(payout())).rejects.toBeTruthy();
    await expect(run<SalaryPayoutInput>(useSalaryPayout())(payout({ amount: 3_000_000 }))).rejects.toMatchObject({ outcome: 'failure', alreadyRecorded: true, message: expect.stringContaining('lần gửi trước') });
    expect(vouchers()).toHaveLength(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('gửi lại không bao giờ rơi sang nhánh ghi cũ (không có mã) dù máy chủ báo «chưa bật»', async () => {
    installPayout();
    io.server.failNext('salary_payout_v1', 'rpc', 'drop-before');
    await expect(run<SalaryPayoutInput>(useSalaryPayout())(payout())).rejects.toBeTruthy();
    io.server.rpcHandlers.salary_payout_v1 = () => ({ data: null, error: { code: '55000', message: 'Writer chi lương chưa bật' } });
    await expect(run<SalaryPayoutInput>(useSalaryPayout())(payout())).rejects.toMatchObject({ code: '55000' });
    expect(calls('salary_payout_v1')).toHaveLength(2);
    expect(io.server.inserts.filter(item => item.table === 'income_expenses' || item.table === 'income_expense_items')).toEqual([]);
  });

  it('đọc lại phiếu hỏng sau khi máy chủ đã trả mã phiếu: không khoá; lần bấm sau gửi lại đúng mã, nhận đúng phiếu đó', async () => {
    installPayout();
    io.server.failNext('income_expenses', 'read', 'drop-before');
    await expect(run<SalaryPayoutInput>(useSalaryPayout())(payout())).rejects.toMatchObject({ outcome: 'unknown', message: expect.stringContaining('Đã lập phiếu chi lương') });
    const pending = localStorage.getItem(pendingKeys()[0]!) ?? '';
    expect(JSON.parse(pending).completedIds).toEqual([]);
    await expect(run<SalaryPayoutInput>(useSalaryPayout())(payout())).resolves.toMatchObject({ id: 'v-1', approval_status: 'UNAPPROVED' });
    expect(new Set(keysOf('salary_payout_v1')).size).toBe(1);
    expect(vouchers()).toHaveLength(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('hàng rào biên nhận: trạng thái phiếu đọc được mà sai ⇒ giữ mã phiếu trong dấu, lần bấm sau không gửi, không lập phiếu khác', async () => {
    installPayout();
    io.server.rpcHandlers.salary_payout_v1 = (inner => (args: Row) => { const result = inner(args); vouchers().forEach(row => { row.approval_status = 'not-a-state'; }); return result; })(io.server.rpcHandlers.salary_payout_v1!);
    await expect(run<SalaryPayoutInput>(useSalaryPayout())(payout())).rejects.toMatchObject({ outcome: 'partial', completed: [expect.objectContaining({ id: 'v-1' })] });
    await expect(run<SalaryPayoutInput>(useSalaryPayout())(payout())).rejects.toMatchObject({ outcome: 'partial' });
    expect(calls('salary_payout_v1')).toHaveLength(1);
    expect(vouchers()).toHaveLength(1);
  });

  it('hết phiên: không ghi dấu, không gửi', async () => {
    installPayout();
    io.user = null;
    await expect(run<SalaryPayoutInput>(useSalaryPayout())(payout())).rejects.toMatchObject({ code: 'PGRST301' });
    expect(calls('salary_payout_v1')).toHaveLength(0);
    expect(pendingKeys()).toEqual([]);
  });

  it('tên thao tác lưu vào dấu không chứa tên nhân viên', async () => {
    installPayout();
    io.server.failNext('salary_payout_v1', 'rpc', 'drop-before');
    await expect(run<SalaryPayoutInput>(useSalaryPayout())(payout())).rejects.toBeTruthy();
    const raw = localStorage.getItem(pendingKeys()[0]!) ?? '';
    expect(raw).not.toContain('Nhân viên mẫu');
  });
});

const lockArgs = { ownerId: 'owner', periodMonth: PERIOD, managers: [] };
function installLock() {
  let writes = 0;
  keyed('lock_salary_month_v2', args => JSON.stringify([args.p_period_month, args.p_managers]), args => {
    writes += 1;
    return { data: { state: 'LOCKED', period_month: args.p_period_month, locked_count: 0 }, error: null };
  });
  return () => writes;
}

describe('chốt tháng lương (lock_salary_month_v2, cách B)', () => {
  it('lệnh không tới máy chủ: gửi lại ngay đúng mã cũ', async () => {
    const writes = installLock();
    io.server.failNext('lock_salary_month_v2', 'rpc', 'drop-before');
    await expect(run(useLockSalaryMonth())(lockArgs)).rejects.toBeTruthy();
    await expect(run(useLockSalaryMonth())(lockArgs)).resolves.toEqual({ count: 0 });
    expect(new Set(keysOf('lock_salary_month_v2')).size).toBe(1);
    expect(writes()).toBe(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('tới nhưng mất phản hồi: gửi lại cùng mã nhận kết quả cũ, chỉ một lần chốt', async () => {
    const writes = installLock();
    io.server.failNext('lock_salary_month_v2', 'rpc', 'drop-after');
    await expect(run(useLockSalaryMonth())(lockArgs)).rejects.toBeTruthy();
    await expect(run(useLockSalaryMonth())(lockArgs)).resolves.toEqual({ count: 0 });
    expect(keysOf('lock_salary_month_v2')).toHaveLength(2);
    expect(new Set(keysOf('lock_salary_month_v2')).size).toBe(1);
    expect(writes()).toBe(1);
  });

  it('dấu cũ gieo sẵn: gửi lại đúng mã của dấu', async () => {
    installLock();
    seedLegacyPending({ namespace: 'salary-lock', userId: 'actor', organizationId: 'actor-scope', businessKey: `lock-owner-${PERIOD}` }, new Date(Date.now() - 10 * 60_000));
    await expect(run(useLockSalaryMonth())(lockArgs)).resolves.toEqual({ count: 0 });
    expect(keysOf('lock_salary_month_v2')).toEqual(['legacy-attempt']);
    expect(pendingKeys()).toEqual([]);
  });

  it('gửi lại mà số liệu đã đổi ⇒ máy chủ báo trùng mã: báo đã chốt ở lần trước', async () => {
    installLock();
    io.server.failNext('lock_salary_month_v2', 'rpc', 'drop-after');
    await expect(run(useLockSalaryMonth())(lockArgs)).rejects.toBeTruthy();
    const changed = { ...lockArgs, managers: [] as never[] };
    io.server.rpcHandlers.lock_salary_month_v2 = () => ({ data: null, error: { code: '23505', message: 'idempotency_key đã dùng với nội dung khác' } });
    await expect(run(useLockSalaryMonth())(changed)).rejects.toMatchObject({ alreadyRecorded: true, message: expect.stringContaining('đã được chốt ở lần gửi trước') });
    expect(pendingKeys()).toEqual([]);
  });
});

const unlockArgs = { periodMonth: PERIOD, staffIds: [STAFF] };
function installUnlock() {
  io.server.rows.salary_monthly = [{ id: 'sm1', staff_id: STAFF, period_month: PERIOD, status: 'LOCKED' }];
  let writes = 0;
  keyed('unlock_salary_month_v2', args => JSON.stringify([args.p_period_month, args.p_staff_ids]), args => {
    writes += 1;
    const rows = io.server.rows.salary_monthly.filter(row => row.status === 'LOCKED' && (args.p_staff_ids as string[]).includes(String(row.staff_id)));
    rows.forEach(row => { row.status = 'DRAFT'; });
    return { data: { state: 'DRAFT', period_month: args.p_period_month, unlocked_count: rows.length }, error: null };
  });
  return () => writes;
}

describe('mở khoá tháng lương (cách C: đọc trạng thái tháng)', () => {
  it('lệnh không tới máy chủ: tháng còn khoá ⇒ gửi lại ngay đúng mã cũ', async () => {
    const writes = installUnlock();
    io.server.failNext('unlock_salary_month_v2', 'rpc', 'drop-before');
    await expect(run(useUnlockSalaryMonth())(unlockArgs)).rejects.toBeTruthy();
    await expect(run(useUnlockSalaryMonth())(unlockArgs)).resolves.toEqual({ count: 1 });
    expect(new Set(keysOf('unlock_salary_month_v2')).size).toBe(1);
    expect(writes()).toBe(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('tới nhưng mất phản hồi: đọc thấy tháng đã mở ⇒ báo đã mở, không gửi lần hai', async () => {
    const writes = installUnlock();
    io.server.failNext('unlock_salary_month_v2', 'rpc', 'drop-after');
    await expect(run(useUnlockSalaryMonth())(unlockArgs)).rejects.toBeTruthy();
    await expect(run(useUnlockSalaryMonth())(unlockArgs)).resolves.toMatchObject({ count: 0, alreadyUnlocked: true });
    expect(calls('unlock_salary_month_v2')).toHaveLength(1);
    expect(writes()).toBe(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('dấu cũ gieo sẵn mà tháng còn khoá: gửi lại đúng mã của dấu', async () => {
    installUnlock();
    seedLegacyPending({ namespace: 'salary-unlock', userId: 'actor', organizationId: 'actor-scope', businessKey: `unlock-${PERIOD}` }, new Date(Date.now() - 10 * 60_000));
    await expect(run(useUnlockSalaryMonth())(unlockArgs)).resolves.toEqual({ count: 1 });
    expect(keysOf('unlock_salary_month_v2')).toEqual(['legacy-attempt']);
  });

  it('đọc trạng thái hỏng: giữ dấu, không gửi', async () => {
    installUnlock();
    io.server.failNext('unlock_salary_month_v2', 'rpc', 'drop-before');
    await expect(run(useUnlockSalaryMonth())(unlockArgs)).rejects.toBeTruthy();
    io.server.failNext('salary_monthly', 'read', 'drop-before');
    await expect(run(useUnlockSalaryMonth())(unlockArgs)).rejects.toMatchObject({ message: expect.stringContaining('đối chiếu') });
    expect(calls('unlock_salary_month_v2')).toHaveLength(1);
    expect(pendingKeys()).toHaveLength(1);
  });
});

const adjustment = (over: Partial<SaveAdjustmentInput> = {}): SaveAdjustmentInput => ({
  ownerId: 'owner', staffId: STAFF, periodMonth: PERIOD, kind: 'BONUS', label: 'Thưởng mẫu', amount: 500_000, note: null, ...over,
});
const adjustmentScope = (id = 'new') => ({ namespace: 'salary-adjustment', userId: 'actor', organizationId: 'actor-scope', businessKey: `owner-${STAFF}-${PERIOD}-${id}` });
function installAdjustments() {
  io.server.rows.salary_monthly = [{ id: 'sm1', staff_id: STAFF, period_month: PERIOD, status: 'DRAFT' }];
  io.server.rows.manager_salary_config = [{ staff_id: STAFF, organization_id: 'org-1', is_active: true, created_at: '2026-01-01' }];
  io.server.rows.salary_adjustments = [];
}
const adjustments = () => io.server.rows.salary_adjustments;

describe('thưởng/trừ lương (sửa: A; thêm: D theo mã khoản do trình duyệt sinh)', () => {
  it('thêm, lệnh không tới máy chủ: gửi lại ngay đúng mã khoản cũ, một khoản', async () => {
    installAdjustments();
    io.server.failNext('salary_adjustments', 'insert', 'drop-before');
    await expect(run<SaveAdjustmentInput>(useSaveSalaryAdjustment())(adjustment())).rejects.toBeTruthy();
    await expect(run<SaveAdjustmentInput>(useSaveSalaryAdjustment())(adjustment())).resolves.toMatchObject({ id: expect.any(String) });
    expect(adjustments()).toHaveLength(1);
    const ids = io.server.inserts.filter(item => item.table === 'salary_adjustments').map(item => (item.payload as Row).id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('thêm, tới nhưng mất phản hồi: tra đúng khoản theo mã, không thêm lần hai', async () => {
    installAdjustments();
    io.server.failNext('salary_adjustments', 'insert', 'drop-after');
    await expect(run<SaveAdjustmentInput>(useSaveSalaryAdjustment())(adjustment())).rejects.toBeTruthy();
    await expect(run<SaveAdjustmentInput>(useSaveSalaryAdjustment())(adjustment())).resolves.toMatchObject({ id: adjustments()[0]!.id });
    expect(adjustments()).toHaveLength(1);
    expect(io.server.inserts.filter(item => item.table === 'salary_adjustments')).toHaveLength(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('thêm, mất phản hồi rồi bấm lại với nội dung khác: báo đã lưu ở lần trước kèm mã, không thêm', async () => {
    installAdjustments();
    io.server.failNext('salary_adjustments', 'insert', 'drop-after');
    await expect(run<SaveAdjustmentInput>(useSaveSalaryAdjustment())(adjustment())).rejects.toBeTruthy();
    await expect(run<SaveAdjustmentInput>(useSaveSalaryAdjustment())(adjustment({ amount: 700_000 }))).rejects.toMatchObject({ alreadyRecorded: true, recordIds: [adjustments()[0]!.id] });
    expect(adjustments()).toHaveLength(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('dấu cũ gieo sẵn có khoản thêm tay sau giờ kẹt: báo «có thể đã lưu» kèm mã, không thêm', async () => {
    installAdjustments();
    const stuck = new Date(Date.now() - 10 * 60_000);
    adjustments().push({ id: 'adj-old', salary_monthly_id: 'sm1', source: 'MANUAL', label: 'Thưởng mẫu', created_at: new Date(stuck.getTime() + 1000).toISOString() });
    seedLegacyPending(adjustmentScope(), stuck);
    await expect(run<SaveAdjustmentInput>(useSaveSalaryAdjustment())(adjustment())).rejects.toMatchObject({ alreadyRecorded: true, recordIds: ['adj-old'] });
    expect(io.server.inserts.filter(item => item.table === 'salary_adjustments')).toHaveLength(0);
    expect(pendingKeys()).toEqual([]);
  });

  it('dấu cũ gieo sẵn (quá 2 phút) không thấy khoản nào: thêm đúng một khoản', async () => {
    installAdjustments();
    seedLegacyPending(adjustmentScope(), new Date(Date.now() - 10 * 60_000));
    await expect(run<SaveAdjustmentInput>(useSaveSalaryAdjustment())(adjustment())).resolves.toMatchObject({ id: expect.any(String) });
    expect(adjustments()).toHaveLength(1);
  });

  it('sửa, tới nhưng mất phản hồi: chạy lại ngay, cùng giá trị', async () => {
    installAdjustments();
    adjustments().push({ id: 'adj-1', salary_monthly_id: 'sm1', kind: 'BONUS', label: 'Cũ', amount: 100, note: null, source: 'MANUAL' });
    io.server.failNext('salary_adjustments', 'update', 'drop-after');
    await expect(run<SaveAdjustmentInput>(useSaveSalaryAdjustment())(adjustment({ id: 'adj-1' }))).rejects.toBeTruthy();
    await expect(run<SaveAdjustmentInput>(useSaveSalaryAdjustment())(adjustment({ id: 'adj-1' }))).resolves.toMatchObject({ id: 'adj-1' });
    expect(adjustments()[0]).toMatchObject({ label: 'Thưởng mẫu', amount: 500_000 });
    expect(pendingKeys()).toEqual([]);
  });

  it('sửa, dấu cũ gieo sẵn: chạy lại ngay', async () => {
    installAdjustments();
    adjustments().push({ id: 'adj-1', salary_monthly_id: 'sm1', kind: 'BONUS', label: 'Cũ', amount: 100, note: null, source: 'MANUAL' });
    seedLegacyPending(adjustmentScope('adj-1'), new Date(Date.now() - 30_000));
    await expect(run<SaveAdjustmentInput>(useSaveSalaryAdjustment())(adjustment({ id: 'adj-1' }))).resolves.toMatchObject({ id: 'adj-1' });
    expect(pendingKeys()).toEqual([]);
  });

  it('sửa khớp 0 dòng (đã xoá hoặc không có quyền): từ chối rõ, không giữ dấu', async () => {
    installAdjustments();
    await expect(run<SaveAdjustmentInput>(useSaveSalaryAdjustment())(adjustment({ id: 'missing' }))).rejects.toMatchObject({ outcome: 'failure' });
    expect(pendingKeys()).toEqual([]);
  });

  it('hết phiên: không ghi dấu', async () => {
    installAdjustments();
    io.user = null;
    await expect(run<SaveAdjustmentInput>(useSaveSalaryAdjustment())(adjustment())).rejects.toMatchObject({ code: 'PGRST301' });
    expect(pendingKeys()).toEqual([]);
    expect(io.server.inserts).toEqual([]);
  });
});
