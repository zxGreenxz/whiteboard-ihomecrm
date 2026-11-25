// @vitest-environment jsdom
// Đợt 5: xác nhận, xin huỷ, đồng ý huỷ, từ chối huỷ một phiên bàn giao (cách C). Bốn hàm production (25/11/2026) khoá
// phiên FOR UPDATE rồi mới xét trạng thái và báo P0001 khi phiên đã đổi, nên gửi lại không ghi hai lần. Mỗi thao tác một
// dấu riêng; dấu chung `handover-lifecycle` của bản trước chặn đúng phiên đó qua hộp cảnh báo.
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRecordServer, pendingKeys, seedLegacyPending, type FakeRecordServer } from './fakeRecordServer';

const io = vi.hoisted(() => ({ server: undefined as unknown as FakeRecordServer }));
vi.mock('@tanstack/react-query', () => ({ useMutation: (config: unknown) => config, useQuery: (config: unknown) => config, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (table: string) => io.server.from(table), get rpc() { return io.server.rpc; } } }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor' }) }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: { id: 'actor' } }) }));
vi.mock('@/hooks/useReceivingCashbooks', () => ({ useReceivingCashbooks: () => ({ data: null }) }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org-a' }) }));

import { useConfirmCancelHandover, useConfirmHandover, useRejectCancelHandover, useRequestCancelHandover } from '../useCashHandovers';

type Row = Record<string, unknown>;
const fn = <I>(hook: () => unknown) => {
  const { result } = renderHook(hook);
  return (result.current as { mutationFn: (input: I) => Promise<unknown> }).mutationFn;
};
const session = () => io.server.rows.cash_handovers[0] as Row;
const calls = (name: string) => io.server.rpcCalls.filter(call => call.name === name).length;

beforeEach(() => {
  localStorage.clear();
  io.server = fakeRecordServer();
  io.server.rows.cash_handovers = [{ id: 'h1', code: 'BG2511004', status: 'PENDING', cancel_requested_by: null, cancel_requested_at: null }];
  const locked = (check: (row: Row) => string | null, apply: (row: Row) => void) => (args: Row) => {
    const row = io.server.rows.cash_handovers.find(item => item.id === args.p_handover_id) as Row;
    const refused = check(row);
    if (refused) return { data: null, error: { code: 'P0001', message: refused } };
    apply(row);
    return { data: { id: row.id, code: row.code }, error: null };
  };
  const h = io.server.rpcHandlers;
  h.confirm_cash_handover = locked(row => row.status !== 'PENDING' ? `Phiên ${row.code} không ở trạng thái chờ nhận` : row.cancel_requested_by ? 'đang có yêu cầu hủy' : null, row => { row.status = 'CONFIRMED'; });
  h.request_cancel_handover = locked(row => row.status === 'CANCELLED' ? 'đã hủy rồi' : row.cancel_requested_by ? 'đã có yêu cầu hủy đang chờ xác nhận' : null, row => { row.cancel_requested_by = 'actor'; row.cancel_requested_at = '2026-11-25T02:00:00Z'; });
  h.confirm_cancel_handover = locked(row => !row.cancel_requested_by ? 'chưa có yêu cầu hủy' : row.status === 'CANCELLED' ? 'đã hủy rồi' : null, row => { row.status = 'CANCELLED'; });
  h.reject_cancel_handover = locked(row => !row.cancel_requested_by ? 'không có yêu cầu hủy' : null, row => { row.cancel_requested_by = null; row.cancel_requested_at = null; });
});

describe('xác nhận nhận bàn giao', () => {
  const confirm = () => fn<{ handoverId: string; toAccountId: string }>(() => useConfirmHandover());
  it('lệnh không tới máy chủ: phiên vẫn chờ nhận ⇒ gửi lại ngay (máy chủ khoá phiên rồi mới xét)', async () => {
    io.server.failNext('confirm_cash_handover', 'rpc', 'drop-before');
    await expect(confirm()({ handoverId: 'h1', toAccountId: 'a1' })).rejects.toMatchObject({ outcome: 'unknown' });
    await expect(confirm()({ handoverId: 'h1', toAccountId: 'a1' })).resolves.toMatchObject({ code: 'BG2511004' });
    expect(session().status).toBe('CONFIRMED');
    expect(pendingKeys()).toEqual([]);
  });
  it('lệnh tới nhưng mất phản hồi: đọc thấy đã nhận ⇒ báo mã phiên, không gửi lần hai', async () => {
    io.server.failNext('confirm_cash_handover', 'rpc', 'drop-after');
    await expect(confirm()({ handoverId: 'h1', toAccountId: 'a1' })).rejects.toMatchObject({ outcome: 'unknown' });
    await expect(confirm()({ handoverId: 'h1', toAccountId: 'a1' })).rejects.toMatchObject({ outcome: 'failure', message: expect.stringContaining('BG2511004') });
    expect(calls('confirm_cash_handover')).toBe(1);
    expect(pendingKeys()).toEqual([]);
  });
  it('dấu chung bản trước của đúng phiên: chặn, không gửi', async () => {
    seedLegacyPending({ namespace: 'handover-lifecycle', userId: 'actor', organizationId: 'actor-scope', businessKey: 'h1' }, new Date(Date.now() - 10 * 60_000));
    await expect(confirm()({ handoverId: 'h1', toAccountId: 'a1' })).rejects.toMatchObject({ message: expect.stringContaining('đối chiếu') });
    expect(calls('confirm_cash_handover')).toBe(0);
  });
  it('xác nhận kẹt không chặn xin huỷ chính phiên đó', async () => {
    io.server.failNext('confirm_cash_handover', 'rpc', 'drop-before');
    await expect(confirm()({ handoverId: 'h1', toAccountId: 'a1' })).rejects.toMatchObject({ outcome: 'unknown' });
    await expect(fn<{ handoverId: string; reason: string }>(() => useRequestCancelHandover())({ handoverId: 'h1', reason: 'Đếm thiếu tiền' })).resolves.toMatchObject({ id: 'h1' });
  });
});

describe.each([
  ['xin huỷ', 'request_cancel_handover', () => useRequestCancelHandover(), (row: Row) => { row.status = 'CONFIRMED'; }],
  ['đồng ý huỷ', 'confirm_cancel_handover', () => useConfirmCancelHandover(), (row: Row) => { row.cancel_requested_by = 'other'; row.cancel_requested_at = '2026-11-25T01:00:00Z'; }],
  ['từ chối huỷ', 'reject_cancel_handover', () => useRejectCancelHandover(), (row: Row) => { row.cancel_requested_by = 'other'; row.cancel_requested_at = '2026-11-25T01:00:00Z'; }],
] as const)('%s phiên', (_label, rpcName, hook, setup) => {
  beforeEach(() => setup(session()));
  const run = () => fn<{ handoverId: string; reason: string }>(hook);
  it('lệnh không tới máy chủ: gửi lại ngay, thao tác chạy đúng một lần', async () => {
    io.server.failNext(rpcName, 'rpc', 'drop-before');
    await expect(run()({ handoverId: 'h1', reason: 'Đếm thiếu tiền' })).rejects.toMatchObject({ outcome: 'unknown' });
    await expect(run()({ handoverId: 'h1', reason: 'Đếm thiếu tiền' })).resolves.toMatchObject({ id: 'h1' });
    expect(pendingKeys()).toEqual([]);
  });
  it('lệnh tới nhưng mất phản hồi: đọc thấy phiên đã đổi đúng như thao tác ⇒ báo, không gửi lần hai', async () => {
    io.server.failNext(rpcName, 'rpc', 'drop-after');
    await expect(run()({ handoverId: 'h1', reason: 'Đếm thiếu tiền' })).rejects.toMatchObject({ outcome: 'unknown' });
    await expect(run()({ handoverId: 'h1', reason: 'Đếm thiếu tiền' })).rejects.toMatchObject({ outcome: 'failure', message: expect.stringContaining('BG2511004') });
    expect(calls(rpcName)).toBe(1);
    expect(pendingKeys()).toEqual([]);
  });
  it('dấu chung bản trước: chặn, không gửi', async () => {
    seedLegacyPending({ namespace: 'handover-lifecycle', userId: 'actor', organizationId: 'actor-scope', businessKey: 'h1' }, new Date(Date.now() - 10 * 60_000));
    await expect(run()({ handoverId: 'h1', reason: 'Đếm thiếu tiền' })).rejects.toMatchObject({ message: expect.stringContaining('đối chiếu') });
    expect(calls(rpcName)).toBe(0);
  });
});
