// @vitest-environment jsdom
// Đợt 4: lập phiên bàn giao tiền (cách A). Máy chủ `create_cash_handover` khoá các phiếu FOR UPDATE rồi đòi
// `handover_id IS NULL`, nên một phiếu không vào được hai phiên: gửi lại luôn an toàn. Trước khi gửi, trình duyệt đọc
// phiên của các phiếu đang chọn; phiếu đã nằm trong phiên thì báo mã phiên, không gửi.
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

import { useCreateHandover } from '../useCashHandovers';

type CreateFn = (input: { receiverId: string; voucherIds: string[] }) => Promise<{ id: string; code: string; voucher_count: number }>;
const create = (): CreateFn => {
  const { result } = renderHook(() => useCreateHandover());
  return (result.current as unknown as { mutationFn: CreateFn }).mutationFn;
};
const handovers = () => io.server.rows.cash_handovers ?? [];
const rpcCount = () => io.server.rpcCalls.filter(call => call.name === 'create_cash_handover').length;
const legacyScope = { namespace: 'handover-create', userId: 'actor', organizationId: 'actor-scope', businessKey: 'new' };

beforeEach(() => {
  io.server = fakeRecordServer();
  localStorage.clear();
  io.server.rows.income_expenses = ['v1', 'v2', 'v3', 'v4'].map(id => ({ id, handover_id: null, total_amount: 100 }));
  // Thân hàm production: phiếu đã có phiên ⇒ P0001, không tạo phiên thứ hai.
  io.server.rpcHandlers.create_cash_handover = args => {
    const ids = [...new Set(args.p_voucher_ids as string[])];
    const vouchers = io.server.rows.income_expenses.filter(row => ids.includes(row.id as string));
    if (vouchers.length !== ids.length || vouchers.some(row => row.handover_id)) {
      return { data: null, error: { code: 'P0001', message: 'Có phiếu không hợp lệ (đã xoá / đã nằm trong phiên bàn giao khác / chưa duyệt)' } };
    }
    const id = `h${handovers().length + 1}`;
    const code = `BG2511${String(handovers().length + 1).padStart(3, '0')}`;
    (io.server.rows.cash_handovers ??= []).push({ id, code, status: 'PENDING', giver_id: 'actor' });
    for (const row of vouchers) row.handover_id = id;
    return { data: { id, code, total_amount: 100 * ids.length, voucher_count: ids.length }, error: null };
  };
});

describe('lập phiên bàn giao tiền', () => {
  it('lệnh không tới máy chủ: bấm lại gửi lại ngay (máy chủ chặn trùng), ra đúng một phiên, dấu được gỡ', async () => {
    const mutate = create();
    io.server.failNext('create_cash_handover', 'rpc', 'drop-before');
    await expect(mutate({ receiverId: 'boss', voucherIds: ['v1', 'v2'] })).rejects.toMatchObject({ outcome: 'unknown' });
    const result = await mutate({ receiverId: 'boss', voucherIds: ['v1', 'v2'] });
    expect(result.code).toBe('BG2511001');
    expect(handovers()).toHaveLength(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('lệnh tới nhưng mất phản hồi: lần bấm sau đọc thấy phiếu đã nằm trong phiên, báo mã phiên, không gửi lần hai', async () => {
    const mutate = create();
    io.server.failNext('create_cash_handover', 'rpc', 'drop-after');
    await expect(mutate({ receiverId: 'boss', voucherIds: ['v1', 'v2'] })).rejects.toMatchObject({ outcome: 'unknown' });
    expect(handovers()).toHaveLength(1);
    await expect(mutate({ receiverId: 'boss', voucherIds: ['v1', 'v2'] })).rejects.toMatchObject({ outcome: 'failure', message: expect.stringContaining('BG2511001') });
    expect(rpcCount()).toBe(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('dấu khoá chung của bản trước (không tên thao tác): không chặn; phiếu còn trống thì lập phiên, dấu được gỡ', async () => {
    const key = seedLegacyPending(legacyScope, new Date(Date.now() - 10 * 60_000));
    const result = await create()({ receiverId: 'boss', voucherIds: ['v3'] });
    expect(result.voucher_count).toBe(1);
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('dấu cũ mang mã phiên đã nhận: báo phiên đó, gỡ dấu, lần bấm sau lập bình thường', async () => {
    io.server.rows.cash_handovers = [{ id: 'h-old', code: 'BG2510009', status: 'PENDING', giver_id: 'actor' }];
    seedLegacyPending(legacyScope, new Date(Date.now() - 10 * 60_000), ['h-old']);
    const mutate = create();
    await expect(mutate({ receiverId: 'boss', voucherIds: ['v3'] })).rejects.toMatchObject({ outcome: 'failure', message: expect.stringContaining('BG2510009') });
    expect(rpcCount()).toBe(0);
    await mutate({ receiverId: 'boss', voucherIds: ['v3'] });
    expect(rpcCount()).toBe(1);
  });

  it('một phiên kẹt không chặn phiên khác: tập phiếu khác lập được ngay, không phải chờ 2 phút', async () => {
    const mutate = create();
    io.server.failNext('create_cash_handover', 'rpc', 'drop-before');
    await expect(mutate({ receiverId: 'boss', voucherIds: ['v1'] })).rejects.toMatchObject({ outcome: 'unknown' });
    const other = await mutate({ receiverId: 'boss', voucherIds: ['v3', 'v4'] });
    expect(other.voucher_count).toBe(2);
    expect(pendingKeys()).toEqual([]);
  });

  it('đọc phiên của phiếu hỏng: không ghi dấu, không gửi lệnh', async () => {
    io.server.failNext('income_expenses', 'read', 'drop-before');
    await expect(create()({ receiverId: 'boss', voucherIds: ['v1'] })).rejects.toBeTruthy();
    expect(rpcCount()).toBe(0);
    expect(pendingKeys()).toEqual([]);
  });

  it('lệnh cũ chạy xong ngay trước lần gửi lại (máy chủ trả P0001): đọc lại, báo đúng mã phiên thay cho câu chung', async () => {
    const mutate = create();
    io.server.failNext('create_cash_handover', 'rpc', 'drop-before');
    await expect(mutate({ receiverId: 'boss', voucherIds: ['v1', 'v2'] })).rejects.toMatchObject({ outcome: 'unknown' });
    io.server.rpcHandlers.create_cash_handover = () => {
      (io.server.rows.cash_handovers ??= []).push({ id: 'h-race', code: 'BG2511077', status: 'PENDING', giver_id: 'actor' });
      for (const row of io.server.rows.income_expenses) if (['v1', 'v2'].includes(row.id as string)) row.handover_id = 'h-race';
      return { data: null, error: { code: 'P0001', message: 'Có phiếu không hợp lệ (đã xoá / đã nằm trong phiên bàn giao khác / chưa duyệt)' } };
    };
    await expect(mutate({ receiverId: 'boss', voucherIds: ['v1', 'v2'] })).rejects.toMatchObject({ outcome: 'failure', message: expect.stringContaining('BG2511077') });
    expect(pendingKeys()).toEqual([]);
  });

  it('đọc phiếu thiếu một phiếu đã chọn (không thấy vì quyền/đã xoá): không kết luận, không dấu, không gửi', async () => {
    io.server.visible.income_expenses = row => row.id !== 'v2';
    await expect(create()({ receiverId: 'boss', voucherIds: ['v1', 'v2'] })).rejects.toMatchObject({ outcome: 'failure' });
    expect(rpcCount()).toBe(0);
    expect(pendingKeys()).toEqual([]);
  });

  it('phiếu đã nằm trong phiên khác ngay từ đầu (danh sách cũ): báo mã phiên, không gửi', async () => {
    io.server.rows.cash_handovers = [{ id: 'h9', code: 'BG2511099', status: 'PENDING', giver_id: 'actor' }];
    io.server.rows.income_expenses[0].handover_id = 'h9';
    await expect(create()({ receiverId: 'boss', voucherIds: ['v1', 'v2'] })).rejects.toMatchObject({ message: expect.stringContaining('BG2511099') });
    expect(rpcCount()).toBe(0);
    expect(pendingKeys()).toEqual([]);
  });
});
