// @vitest-environment jsdom
// Đợt 5: huỷ cả đợt phiếu (cách A). Chạy lại = đọc lại phiếu còn hiệu lực của đợt rồi chỉ huỷ phần còn; phiếu đã huỷ không
// tính là lỗi. ie_compat_cancel_v2 (production 25/11/2026) không xét phiếu đã huỷ nên phần còn chỉ chạy khi lần trước
// chắc chắn đã kết thúc (2 phút).
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRecordServer, pendingKeys, seedLegacyPending, type FakeRecordServer } from '../../__tests__/fakeRecordServer';

const io = vi.hoisted(() => ({ server: undefined as unknown as FakeRecordServer }));
vi.mock('@tanstack/react-query', () => ({ useMutation: (config: unknown) => config, useQuery: (config: unknown) => config, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (table: string) => io.server.from(table), get rpc() { return io.server.rpc; } } }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor' }) }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org-a' }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() } }));

import { useCancelIncomeExpenseBatch } from '../batch';

type Result = { count: number; failures: { id: string; outcomeUnknown: boolean }[]; completedIds: string[] };
const cancel = () => {
  const { result } = renderHook(() => useCancelIncomeExpenseBatch());
  return (result.current as unknown as { mutationFn: (input: { batchId: string; reason: string }) => Promise<Result> }).mutationFn({ batchId: 'b1', reason: 'Lập nhầm cả đợt phiếu' });
};
const compatCalls = () => io.server.rpcCalls.filter(call => call.name === 'ie_compat_cancel_v2');
const status = () => io.server.rows.income_expenses.map(row => row.approval_status);
const T0 = Date.parse('2026-11-25T02:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  localStorage.clear();
  localStorage.setItem('ihomecrm.selectedOrganizationId', 'org-a');
  io.server = fakeRecordServer();
  io.server.rows.income_expense_batch_items = [{ batch_id: 'b1', income_expense_id: 'c1' }, { batch_id: 'b1', income_expense_id: 'c2' }];
  io.server.rows.income_expenses = ['c1', 'c2'].map(id => ({ id, type: 'EXPENSE', payment_id: null, approval_status: 'UNAPPROVED' }));
  // Thân hàm production: khoá từng phiếu rồi đặt CANCELLED, KHÔNG xét phiếu đã huỷ (đếm cả phiếu huỷ lại).
  io.server.rpcHandlers.ie_compat_cancel_v2 = args => {
    const ids = args.p_ids as string[];
    for (const row of io.server.rows.income_expenses) if (ids.includes(row.id as string)) row.approval_status = 'CANCELLED';
    return { data: { cancelled: ids.length }, error: null };
  };
});
afterEach(() => { vi.useRealTimers(); });

describe('huỷ đợt phiếu', () => {
  it('lệnh không tới máy chủ: dưới 2 phút chờ; quá 2 phút huỷ phần còn lại một lần', async () => {
    io.server.failNext('ie_compat_cancel_v2', 'rpc', 'drop-before');
    await expect(cancel()).resolves.toMatchObject({ count: 0, failures: [{ id: 'c1', outcomeUnknown: true }, { id: 'c2', outcomeUnknown: true }] });
    await expect(cancel()).rejects.toMatchObject({ message: expect.stringContaining('đang chờ kết quả') });
    expect(compatCalls()).toHaveLength(1);
    vi.setSystemTime(T0 + 130_000);
    await expect(cancel()).resolves.toMatchObject({ count: 2, failures: [] });
    expect(status()).toEqual(['CANCELLED', 'CANCELLED']);
    expect(pendingKeys()).toEqual([]);
  });
  it('lệnh tới nhưng mất phản hồi: đọc lại thấy cả đợt đã huỷ ⇒ không gửi lần hai, gỡ dấu', async () => {
    io.server.failNext('ie_compat_cancel_v2', 'rpc', 'drop-after');
    await expect(cancel()).resolves.toMatchObject({ failures: [{ outcomeUnknown: true }, { outcomeUnknown: true }] });
    await expect(cancel()).resolves.toMatchObject({ count: 0, failures: [] });
    expect(compatCalls()).toHaveLength(1);
    expect(pendingKeys()).toEqual([]);
  });
  it('lần trước đã huỷ hết phiếu nhưng chưa gỡ khoản thanh toán của phiếu chi: chỉ chạy bước gỡ (sau 2 phút), không huỷ lại', async () => {
    for (const row of io.server.rows.income_expenses) row.approval_status = 'CANCELLED';
    io.server.rows.income_expenses[0].payment_id = 'p1';
    io.server.rows.payments = [{ id: 'p1' }];
    seedLegacyPending({ namespace: 'voucher-batch-cancel', userId: 'actor', organizationId: 'org-a', businessKey: 'b1' }, new Date(T0 - 60_000), ['c1', 'c2']);
    await expect(cancel()).rejects.toMatchObject({ message: expect.stringContaining('đang chờ kết quả') });
    vi.setSystemTime(T0 + 130_000);
    await expect(cancel()).resolves.toMatchObject({ count: 0, failures: [] });
    expect(io.server.rows.payments).toEqual([]);
    expect(compatCalls()).toHaveLength(0);
    expect(pendingKeys()).toEqual([]);
  });
  it('dấu cũ gieo sẵn của đợt (đã quá 2 phút): đọc lại, chỉ huỷ phiếu còn hiệu lực', async () => {
    io.server.rows.income_expenses[0].approval_status = 'CANCELLED';
    seedLegacyPending({ namespace: 'voucher-batch-cancel', userId: 'actor', organizationId: 'org-a', businessKey: 'b1' }, new Date(T0 - 10 * 60_000), ['c1']);
    await expect(cancel()).resolves.toMatchObject({ count: 1, failures: [] });
    expect(compatCalls()[0].args.p_ids).toEqual(['c2']);
    expect(pendingKeys()).toEqual([]);
  });
});
