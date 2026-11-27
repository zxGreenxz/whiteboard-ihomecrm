// @vitest-environment jsdom
// Đợt 5: đề nghị, xác nhận, huỷ chốt sổ. Thân hàm production (25/11/2026): đề nghị khoá sổ rồi chặn đề nghị thứ hai
// (CLOSURE_PENDING); xác nhận khoá đề nghị rồi đòi PENDING; huỷ khoá đề nghị rồi trả {changed:false} khi đã đổi.
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRecordServer, pendingKeys, seedLegacyPending, type FakeRecordServer } from './fakeRecordServer';

const io = vi.hoisted(() => ({ server: undefined as unknown as FakeRecordServer }));
vi.mock('@tanstack/react-query', () => ({ useMutation: (config: unknown) => config, useQuery: (config: unknown) => config, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('react-router-dom', () => ({ useSearchParams: () => [new URLSearchParams(), vi.fn()] }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (table: string) => io.server.from(table), get rpc() { return io.server.rpc; } } }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor' }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() } }));

import { useCancelCashbookClosing, useConfirmCashbookClosing, useProposeCashbookClosing } from '../useCashbookClosing';

type Row = Record<string, unknown>;
const fn = <I>(hook: () => unknown) => {
  const { result } = renderHook(hook);
  return (result.current as { mutationFn: (input: I) => Promise<unknown> }).mutationFn;
};
const requests = () => io.server.rows.closure_requests ?? [];
const closures = () => io.server.rows.closures ?? [];
const calls = (name: string) => io.server.rpcCalls.filter(call => call.name === name).length;
const propose = () => fn<{ cashbookId: string; countedBalance: number; confirmerUserId: string }>(() => useProposeCashbookClosing());
const confirm = () => fn<{ requestId: string; countedBalance: number; cashbookId?: string; closedThrough?: string }>(() => useConfirmCashbookClosing());
const cancel = () => fn<{ requestId: string; reason: string }>(() => useCancelCashbookClosing());

beforeEach(() => {
  localStorage.clear();
  io.server = fakeRecordServer();
  io.server.rows.closure_requests = [];
  io.server.rows.closures = [];
  const h = io.server.rpcHandlers;
  h.list_cashbook_closings_v1 = args => ({ data: {
    pending: requests().filter(row => row.status === 'PENDING' && (!args.p_cashbook || row.cashbook_id === args.p_cashbook))
      .map(row => ({ request_id: row.id, cashbook_id: row.cashbook_id, cashbook_name: 'Quỹ tiền mặt', closed_through: row.closed_through, confirmer_name: 'Kế toán' })),
    closures: closures().filter(row => !args.p_cashbook || row.cashbook_id === args.p_cashbook),
  }, error: null });
  h.propose_cashbook_closing_v1 = args => {
    if (requests().some(row => row.cashbook_id === args.p_cashbook && row.status === 'PENDING')) return { data: null, error: { code: '55000', message: 'Chưa chốt được: Đang có đề nghị chốt chờ xác nhận' } };
    const id = `r${requests().length + 1}`;
    requests().push({ id, cashbook_id: args.p_cashbook, closed_through: '2026-11-25', status: 'PENDING' });
    return { data: { request_id: id, cashbook_id: args.p_cashbook, closed_through: '2026-11-25', status: 'PENDING' }, error: null };
  };
  h.confirm_cashbook_closing_v1 = args => {
    const row = requests().find(item => item.id === args.p_request) as Row;
    if (row.status !== 'PENDING') return { data: null, error: { code: '23505', message: `Đề nghị này đã ${String(row.status).toLowerCase()} rồi` } };
    row.status = 'CONFIRMED';
    closures().push({ closure_id: closures().length + 1, cashbook_id: row.cashbook_id, cashbook_name: 'Quỹ tiền mặt', closed_through: row.closed_through, confirmed_at: new Date().toISOString() });
    return { data: { request_id: row.id, closure_id: closures().length, status: 'CONFIRMED', closed_through: row.closed_through }, error: null };
  };
  h.cancel_cashbook_closing_v1 = args => {
    const row = requests().find(item => item.id === args.p_request) as Row;
    if (row.status !== 'PENDING') return { data: { request_id: row.id, changed: false, status: row.status }, error: null };
    row.status = 'CANCELLED';
    return { data: { request_id: row.id, changed: true, status: 'CANCELLED' }, error: null };
  };
});

describe('đề nghị chốt sổ', () => {
  it('lệnh không tới máy chủ: sổ chưa có đề nghị chờ ⇒ gửi lại ngay, ra đúng một đề nghị', async () => {
    io.server.failNext('propose_cashbook_closing_v1', 'rpc', 'drop-before');
    await expect(propose()({ cashbookId: 'b1', countedBalance: 100, confirmerUserId: 'k' })).rejects.toBeTruthy();
    await expect(propose()({ cashbookId: 'b1', countedBalance: 100, confirmerUserId: 'k' })).resolves.toMatchObject({ status: 'PENDING' });
    expect(requests()).toHaveLength(1);
    expect(pendingKeys()).toEqual([]);
  });
  it('lệnh tới nhưng mất phản hồi: đọc danh sách thấy đề nghị chờ ⇒ báo, không gửi thêm', async () => {
    io.server.failNext('propose_cashbook_closing_v1', 'rpc', 'drop-after');
    await expect(propose()({ cashbookId: 'b1', countedBalance: 100, confirmerUserId: 'k' })).rejects.toBeTruthy();
    await expect(propose()({ cashbookId: 'b1', countedBalance: 100, confirmerUserId: 'k' })).rejects.toMatchObject({ outcome: 'failure', message: expect.stringContaining('đang chờ') });
    expect(calls('propose_cashbook_closing_v1')).toBe(1);
    expect(pendingKeys()).toEqual([]);
  });
  it('dấu cũ gieo sẵn mà đề nghị của lần đó đã được ký: báo đã chốt, không gửi đề nghị mới', async () => {
    closures().push({ closure_id: 9, cashbook_id: 'b1', cashbook_name: 'Quỹ tiền mặt', closed_through: '2026-11-24', confirmed_at: new Date().toISOString() });
    seedLegacyPending({ namespace: 'closing-propose', userId: 'actor', organizationId: 'actor-scope', businessKey: 'b1' }, new Date(Date.now() - 30 * 60_000));
    await expect(propose()({ cashbookId: 'b1', countedBalance: 100, confirmerUserId: 'k' })).rejects.toMatchObject({ outcome: 'failure', message: expect.stringContaining('đã được chốt') });
    expect(calls('propose_cashbook_closing_v1')).toBe(0);
    expect(pendingKeys()).toEqual([]);
  });
});

describe('xác nhận chốt sổ', () => {
  beforeEach(() => { requests().push({ id: 'r1', cashbook_id: 'b1', closed_through: '2026-11-25', status: 'PENDING' }); });
  it('lệnh không tới máy chủ: đề nghị vẫn chờ ⇒ ký lại ngay', async () => {
    io.server.failNext('confirm_cashbook_closing_v1', 'rpc', 'drop-before');
    await expect(confirm()({ requestId: 'r1', countedBalance: 100, cashbookId: 'b1', closedThrough: '2026-11-25' })).rejects.toBeTruthy();
    await expect(confirm()({ requestId: 'r1', countedBalance: 100, cashbookId: 'b1', closedThrough: '2026-11-25' })).resolves.toMatchObject({ closure_id: 1 });
    expect(closures()).toHaveLength(1);
    expect(pendingKeys()).toEqual([]);
  });
  it('lệnh tới nhưng mất phản hồi: thấy biên bản đúng sổ và ngày ⇒ báo đã chốt, không ký lại', async () => {
    io.server.failNext('confirm_cashbook_closing_v1', 'rpc', 'drop-after');
    await expect(confirm()({ requestId: 'r1', countedBalance: 100 })).rejects.toBeTruthy();
    await expect(confirm()({ requestId: 'r1', countedBalance: 100 })).rejects.toMatchObject({ outcome: 'failure', message: expect.stringContaining('đã được chốt') });
    expect(calls('confirm_cashbook_closing_v1')).toBe(1);
    expect(pendingKeys()).toEqual([]);
  });
  it('dấu chung bản trước (xác nhận và huỷ chung một dấu): chặn, không gửi', async () => {
    seedLegacyPending({ namespace: 'closing-request-lifecycle', userId: 'actor', organizationId: 'actor-scope', businessKey: 'r1' }, new Date(Date.now() - 10 * 60_000));
    await expect(confirm()({ requestId: 'r1', countedBalance: 100 })).rejects.toMatchObject({ message: expect.stringContaining('đối chiếu') });
    expect(calls('confirm_cashbook_closing_v1')).toBe(0);
  });
  it('xác nhận kẹt không chặn huỷ đề nghị đó', async () => {
    io.server.failNext('confirm_cashbook_closing_v1', 'rpc', 'drop-before');
    await expect(confirm()({ requestId: 'r1', countedBalance: 100 })).rejects.toBeTruthy();
    await expect(cancel()({ requestId: 'r1', reason: 'Đếm lại' })).resolves.toMatchObject({ changed: true });
  });
});

describe('huỷ đề nghị chốt sổ (cách A)', () => {
  beforeEach(() => { requests().push({ id: 'r1', cashbook_id: 'b1', closed_through: '2026-11-25', status: 'PENDING' }); });
  it('lệnh không tới máy chủ: gửi lại ngay', async () => {
    io.server.failNext('cancel_cashbook_closing_v1', 'rpc', 'drop-before');
    await expect(cancel()({ requestId: 'r1', reason: 'Đếm lại' })).rejects.toBeTruthy();
    await expect(cancel()({ requestId: 'r1', reason: 'Đếm lại' })).resolves.toMatchObject({ changed: true });
    expect(pendingKeys()).toEqual([]);
  });
  it('lệnh tới nhưng mất phản hồi: gửi lại, máy chủ trả «đã đổi trước đó»', async () => {
    io.server.failNext('cancel_cashbook_closing_v1', 'rpc', 'drop-after');
    await expect(cancel()({ requestId: 'r1', reason: 'Đếm lại' })).rejects.toBeTruthy();
    await expect(cancel()({ requestId: 'r1', reason: 'Đếm lại' })).resolves.toMatchObject({ changed: false, status: 'CANCELLED' });
    expect(pendingKeys()).toEqual([]);
  });
  it('dấu chung bản trước: chặn, không gửi', async () => {
    seedLegacyPending({ namespace: 'closing-request-lifecycle', userId: 'actor', organizationId: 'actor-scope', businessKey: 'r1' }, new Date(Date.now() - 10 * 60_000));
    await expect(cancel()({ requestId: 'r1', reason: 'Đếm lại' })).rejects.toMatchObject({ message: expect.stringContaining('đối chiếu') });
    expect(calls('cancel_cashbook_closing_v1')).toBe(0);
  });
});
