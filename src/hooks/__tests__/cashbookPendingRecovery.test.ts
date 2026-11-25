// @vitest-environment jsdom
// Đợt 6: tạo sổ quỹ (create_cashbook_v1) và mở lại sổ (reopen_cashbook_v1), cách B. Thân hàm production 25/11/2026:
//   - create_cashbook_v1 khoá công ty rồi tra mã; băm tên, số dư đầu, ngày đầu kỳ, người phụ trách, công ty (không băm mô tả,
//     sổ mặc định, toà mặc định); cùng mã cùng phần băm ⇒ trả sổ cũ; khác ⇒ 23505.
//   - reopen_cashbook_v1 khoá sổ FOR UPDATE, khoá công ty, khoá tư vấn theo mã rồi tra mã: trả `idempotent_replay`.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRecordServer, pendingKeys, seedLegacyPending, type FakeRecordServer } from './fakeRecordServer';

const io = vi.hoisted(() => ({ server: undefined as unknown as FakeRecordServer, user: { id: 'actor' } as { id: string } | null }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useRef: (current: unknown) => ({ current }) }));
vi.mock('@tanstack/react-query', () => ({ useMutation: (options: unknown) => options, useQuery: (options: unknown) => options, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => io.user }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (table: string) => io.server.from(table), get rpc() { return io.server.rpc; } } }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/actionFeedback', () => ({ notifyActionError: vi.fn() }));

import { useCreateAccount, type AccountFormValues } from '../useAccounts';
import { useReopenCashbook } from '../useCashbookReopening';

type Row = Record<string, unknown>;
const values = (over: Partial<AccountFormValues> = {}): AccountFormValues => ({ name: 'Sổ mẫu', initial_amount: 0, initial_date: '2026-11-01', description: null, quick_default_building_id: null, ...over });
const createBook = (value: AccountFormValues) => (useCreateAccount({ silent: true }) as unknown as { mutationFn: (v: unknown) => Promise<Row> }).mutationFn(value);
const createKeys = () => io.server.rpcCalls.filter(call => call.name === 'create_cashbook_v1').map(call => call.args.p_idempotency_key);
const books = () => io.server.rows.accounts;
let seq = 0;
function installCreate() {
  const claims = new Map<string, { hash: string; response: unknown }>();
  io.server.rpcHandlers.create_cashbook_v1 = args => {
    const hash = JSON.stringify([args.p_name, args.p_initial_amount, args.p_initial_date, args.p_owner_user_id ?? 'actor']);
    const claim = claims.get(String(args.p_idempotency_key));
    if (claim) return claim.hash === hash ? { data: claim.response, error: null } : { data: null, error: { code: '23505', message: 'idempotency_key đã dùng với nội dung khác' } };
    const id = `book-${++seq}`;
    books().push({ id, name: args.p_name, description: args.p_description ?? null });
    const response = { cashbook_id: id };
    claims.set(String(args.p_idempotency_key), { hash, response });
    return { data: response, error: null };
  };
  return claims;
}
const createScope = { namespace: 'cashbook-create', userId: 'actor', organizationId: 'actor-scope', businessKey: 'new' };

beforeEach(() => {
  localStorage.clear();
  seq = 0;
  io.user = { id: 'actor' };
  io.server = fakeRecordServer();
  io.server.rows.accounts = [];
});

describe('tạo sổ quỹ (cách B)', () => {
  it('lệnh không tới máy chủ: gửi lại ngay đúng mã cũ, một sổ', async () => {
    installCreate();
    io.server.failNext('create_cashbook_v1', 'rpc', 'drop-before');
    await expect(createBook(values())).rejects.toBeTruthy();
    await expect(createBook(values())).resolves.toEqual({ id: 'book-1' });
    expect(createKeys()).toHaveLength(2);
    expect(new Set(createKeys()).size).toBe(1);
    expect(books()).toHaveLength(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('tới nhưng mất phản hồi: gửi lại cùng mã nhận sổ cũ', async () => {
    installCreate();
    io.server.failNext('create_cashbook_v1', 'rpc', 'drop-after');
    await expect(createBook(values())).rejects.toBeTruthy();
    await expect(createBook(values())).resolves.toEqual({ id: 'book-1' });
    expect(books()).toHaveLength(1);
  });

  it('mất phản hồi rồi bấm lại với tên khác ⇒ máy chủ báo trùng mã: báo sổ đã tạo ở lần trước, không tạo thêm', async () => {
    installCreate();
    io.server.failNext('create_cashbook_v1', 'rpc', 'drop-after');
    await expect(createBook(values())).rejects.toBeTruthy();
    await expect(createBook(values({ name: 'Sổ khác' }))).rejects.toMatchObject({ alreadyRecorded: true, message: expect.stringContaining('lần gửi trước') });
    expect(books()).toHaveLength(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('khi đối chiếu không cho đổi mô tả (máy chủ không băm): chặn kèm câu hướng dẫn, không gửi', async () => {
    installCreate();
    io.server.failNext('create_cashbook_v1', 'rpc', 'drop-after');
    await expect(createBook(values())).rejects.toBeTruthy();
    await expect(createBook(values({ description: 'Mô tả mới' }))).rejects.toMatchObject({ message: expect.stringContaining('mô tả') });
    expect(createKeys()).toHaveLength(1);
    expect(pendingKeys()).toHaveLength(1);
  });

  it('dấu cũ gieo sẵn: gửi lại đúng mã của dấu', async () => {
    installCreate();
    seedLegacyPending(createScope, new Date(Date.now() - 10 * 60_000));
    await expect(createBook(values())).resolves.toEqual({ id: 'book-1' });
    expect(createKeys()).toEqual(['legacy-attempt']);
  });

  it('hết phiên: không ghi dấu, không gửi', async () => {
    installCreate();
    io.user = null;
    await expect(createBook(values())).rejects.toMatchObject({ code: 'PGRST301' });
    expect(createKeys()).toEqual([]);
    expect(pendingKeys()).toEqual([]);
  });
});

const BOOK = 'a0000000-0000-4000-8000-000000000001';
const KEY = 'b0000000-0000-4000-8000-000000000009';
const reopenInput = { cashbookId: BOOK, cashbookName: 'Sổ mẫu', reason: 'Đối chiếu lại chứng từ', expectedLockDate: '2026-10-30', expectedRevision: 'a'.repeat(32) };
const reopen = (value: typeof reopenInput) => (useReopenCashbook() as unknown as { mutationFn: (v: unknown) => Promise<Row> }).mutationFn(value);
const reopenKeys = () => io.server.rpcCalls.filter(call => call.name === 'reopen_cashbook_v1').map(call => call.args.p_idempotency_key);
function installReopen() {
  const history: Row[] = [];
  let writes = 0;
  io.server.rpcHandlers.cashbook_reopening_state_v1 = () => ({ data: { cashbook_id: BOOK, can_reopen: history.length === 0, blocked_reason: null, lock_date: history.length ? null : '2026-10-30', revision: 'a'.repeat(32), history }, error: null });
  io.server.rpcHandlers.reopen_cashbook_v1 = args => {
    const prior = history.find(row => row.idempotency_key === args.p_idempotency_key);
    if (prior) return { data: { cashbook_id: BOOK, reopening_id: prior.id, status: 'REOPENED', lock_date: null, idempotency_key: args.p_idempotency_key, previous_revision: prior.previous_revision, idempotent_replay: true }, error: null };
    writes += 1;
    const row = { id: 'c0000000-0000-4000-8000-00000000000' + writes, reopened_at: '2026-11-25T09:00:00+00:00', reopened_by_name: null, reason: args.p_reason, previous_lock_date: '2026-10-30', idempotency_key: args.p_idempotency_key, previous_revision: args.p_expected_revision };
    history.push(row);
    return { data: { cashbook_id: BOOK, reopening_id: row.id, status: 'REOPENED', lock_date: null, idempotency_key: args.p_idempotency_key, previous_revision: args.p_expected_revision, idempotent_replay: false }, error: null };
  };
  return () => writes;
}
const reopenScope = { namespace: 'cashbook-reopening', userId: 'actor', organizationId: 'actor-scope', businessKey: BOOK };

describe('mở lại sổ quỹ (cách B)', () => {
  it('lệnh không tới máy chủ: lịch sử chưa có mã ⇒ gửi lại ngay đúng mã cũ', async () => {
    const writes = installReopen();
    io.server.failNext('reopen_cashbook_v1', 'rpc', 'drop-before');
    await expect(reopen(reopenInput)).rejects.toBeTruthy();
    await expect(reopen(reopenInput)).resolves.toMatchObject({ status: 'REOPENED' });
    expect(new Set(reopenKeys()).size).toBe(1);
    expect(writes()).toBe(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('tới nhưng mất phản hồi: lịch sử có đúng mã ⇒ trả biên nhận, không gửi lần hai', async () => {
    const writes = installReopen();
    io.server.failNext('reopen_cashbook_v1', 'rpc', 'drop-after');
    await expect(reopen(reopenInput)).rejects.toBeTruthy();
    await expect(reopen(reopenInput)).resolves.toMatchObject({ status: 'REOPENED' });
    expect(reopenKeys()).toHaveLength(1);
    expect(writes()).toBe(1);
  });

  it('dấu cũ gieo sẵn mà lịch sử chưa có mã: gửi lại đúng mã của dấu', async () => {
    const writes = installReopen();
    const key = 'ihome:financial-pending:v1:' + [reopenScope.namespace, reopenScope.userId, reopenScope.organizationId, reopenScope.businessKey].map(encodeURIComponent).join(':');
    localStorage.setItem(key, JSON.stringify({ ...reopenScope, attemptId: KEY, requestKey: KEY, completedIds: [], startedAt: new Date(Date.now() - 10 * 60_000).toISOString() }));
    await expect(reopen(reopenInput)).resolves.toMatchObject({ status: 'REOPENED', idempotency_key: KEY });
    expect(reopenKeys()).toEqual([KEY]);
    expect(writes()).toBe(1);
  });
});
