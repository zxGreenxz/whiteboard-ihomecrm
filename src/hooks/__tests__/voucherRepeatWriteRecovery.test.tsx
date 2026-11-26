// @vitest-environment jsdom
// Đợt 8, nhóm thu chi: ba thao tác trên phiếu chạy lại được ở máy chủ.
//   - Ngừng lặp phiếu (không phải tiền): ie_stop_recurring_v1 khoá phiếu FOR UPDATE rồi đặt repeat_cycle='NONE'; đã NONE thì trả
//     {changed:false}. Ghi lặp lại được (luật 5) ⇒ không giữ dấu nào.
//   - Sinh phiếu định kỳ (TIỀN): generate_recurring_vouchers chỉ sinh kỳ chưa có phiếu con (kể cả đã xoá mềm), chỉ mục duy nhất
//     (phiếu cha, ngày kỳ) chặn phiếu con thứ hai. Giữ dấu, cách A: lần bấm sau gửi lại NGAY, máy chủ chỉ sinh phần còn thiếu.
//   - Cờ KQKD phiếu bỏ cọc (TIỀN): set_forfeit_voucher_kqkd_v1 khoá phiếu rồi so cờ; đã đúng thì trả {changed:false}, không ghi
//     nhật ký. Giữ dấu, cách A.
// Mỗi thao tác chịu ba sự cố: lệnh không tới máy chủ, tới mà mất phản hồi, dấu bản trước còn nằm trong trình duyệt.
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRecordServer, seedLegacyPending, pendingKeys, type FakeRecordServer } from './fakeRecordServer';
import { FinancialWorkflowError, RepeatableWriteUnknownError } from '@/lib/financialWorkflowError';

const io = vi.hoisted(() => ({ server: undefined as unknown as FakeRecordServer, info: vi.fn(), success: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({ useMutation: (config: unknown) => config, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (table: string) => io.server.from(table), get rpc() { return io.server.rpc; } } }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor' }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: io.success, info: io.info, warning: vi.fn() } }));

import { useGenerateRecurringVouchers, useStopRecurring } from '../income-expenses/recurring';
import { useSetForfeitVoucherKqkd } from '../income-expenses/forfeitKqkd';

type Mutation<I, O> = { mutationFn: (input: I) => Promise<O>; onSuccess: (data: O, input: I) => void };
const mutationOf = <I, O>(hook: { current: unknown }) => hook.current as Mutation<I, O>;
const TEN_MINUTES_AGO = () => new Date(Date.now() - 10 * 60_000);
const marker = (namespace: string, businessKey: string) => seedLegacyPending({ namespace, userId: 'actor', organizationId: 'actor-scope', businessKey }, TEN_MINUTES_AGO());

beforeEach(() => {
  io.server = fakeRecordServer();
  io.info.mockReset();
  io.success.mockReset();
  localStorage.clear();
  localStorage.setItem('ihomecrm.selectedOrganizationId', 'org-a');
});

describe('ngừng lặp phiếu (voucher-recurring-stop)', () => {
  let stopped: Record<string, boolean>;
  beforeEach(() => {
    stopped = { v1: false };
    io.server.rpcHandlers.ie_stop_recurring_v1 = ({ p_id }) => {
      const id = String(p_id);
      const changed = !stopped[id];
      stopped[id] = true;
      return { data: { id, changed }, error: null };
    };
  });
  const stop = () => mutationOf<string, { id: string; changed: boolean }>(renderHook(() => useStopRecurring()).result);

  it('lệnh không tới máy chủ: báo rõ, không dấu, bấm lại ngừng được', async () => {
    const mutation = stop();
    io.server.failNext('ie_stop_recurring_v1', 'rpc', 'drop-before');
    await expect(mutation.mutationFn('v1')).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(pendingKeys()).toEqual([]);
    expect(stopped.v1).toBe(false);
    await expect(mutation.mutationFn('v1')).resolves.toEqual({ id: 'v1', changed: true });
  });

  it('tới nhưng mất phản hồi: bấm lại máy chủ trả «không đổi», không ghi gì thêm', async () => {
    const mutation = stop();
    io.server.failNext('ie_stop_recurring_v1', 'rpc', 'drop-after');
    await expect(mutation.mutationFn('v1')).rejects.toMatchObject({ outcome: 'unknown', message: expect.stringContaining('Bấm lại') });
    expect(stopped.v1).toBe(true);
    expect(pendingKeys()).toEqual([]);
    await expect(mutation.mutationFn('v1')).resolves.toEqual({ id: 'v1', changed: false });
    expect(io.server.rpcCalls).toHaveLength(2);
  });

  it('dấu bản trước của đúng phiếu (≥ 10 phút, không tên thao tác) không chặn; ngừng xong dấu được gỡ', async () => {
    marker('voucher-recurring-stop', 'v1');
    await expect(stop().mutationFn('v1')).resolves.toEqual({ id: 'v1', changed: true });
    expect(pendingKeys()).toEqual([]);
  });

  it('máy chủ từ chối rõ (không có quyền): lời từ chối đi nguyên, không dấu', async () => {
    io.server.rpcHandlers.ie_stop_recurring_v1 = () => ({ data: null, error: { code: '42501', message: 'Không có quyền dừng lặp lại phiếu trên toà nhà này' } });
    const error = await stop().mutationFn('v1').catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: '42501' });
    expect(error).not.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(pendingKeys()).toEqual([]);
  });

  it.each([
    ['sai mã phiếu', { id: 'v2', changed: true }],
    ['thiếu cờ changed', { id: 'v1' }],
    ['không có biên nhận', null],
  ])('biên nhận %s: không báo đã ngừng, cho bấm lại, không dấu', async (_label, receipt) => {
    io.server.rpcHandlers.ie_stop_recurring_v1 = () => ({ data: receipt, error: null });
    await expect(stop().mutationFn('v1')).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(pendingKeys()).toEqual([]);
  });
});

describe('sinh phiếu định kỳ (voucher-recurring-generate, tiền, cách A)', () => {
  type Child = { parent_id: string; child_id: string; voucher_date: string };
  type Generated = Child[] & { resent?: boolean };
  let children: Child[];
  const due = [{ parent: 'p1', date: '2026-11-01' }, { parent: 'p1', date: '2026-11-08' }];
  beforeEach(() => {
    children = [];
    // Như generate_recurring_vouchers: chỉ sinh kỳ (phiếu cha, ngày) chưa có phiếu con; trả đúng các phiếu vừa sinh.
    io.server.rpcHandlers.generate_recurring_vouchers_v2 = () => {
      const created = due.filter(slot => !children.some(child => child.parent_id === slot.parent && child.voucher_date === slot.date))
        .map(slot => ({ parent_id: slot.parent, child_id: `c-${slot.date}`, voucher_date: slot.date }));
      children.push(...created);
      return { data: created, error: null };
    };
  });
  const generate = () => mutationOf<undefined, Generated>(renderHook(() => useGenerateRecurringVouchers()).result);

  it('lệnh không tới máy chủ: báo chưa rõ, bấm lại gửi lại NGAY (không chặn) và sinh đủ phiếu', async () => {
    const mutation = generate();
    io.server.failNext('generate_recurring_vouchers_v2', 'rpc', 'drop-before');
    await expect(mutation.mutationFn(undefined)).rejects.toMatchObject({ outcome: 'unknown' });
    expect(children).toHaveLength(0);
    // Dấu ở lại (tiền) nhưng không chặn: lần bấm sau gửi lại ngay, không chờ 2 phút.
    expect(pendingKeys()).toHaveLength(1);
    const rows = await mutation.mutationFn(undefined);
    expect(rows.map(row => row.child_id)).toEqual(['c-2026-11-01', 'c-2026-11-08']);
    expect(pendingKeys()).toEqual([]);
  });

  it('tới nhưng mất phản hồi: bấm lại không sinh phiếu thứ hai cho cùng kỳ, báo lần trước có thể đã tạo', async () => {
    const mutation = generate();
    io.server.failNext('generate_recurring_vouchers_v2', 'rpc', 'drop-after');
    await expect(mutation.mutationFn(undefined)).rejects.toMatchObject({ outcome: 'unknown' });
    expect(children).toHaveLength(2);
    const rows = await mutation.mutationFn(undefined);
    expect(rows).toHaveLength(0);
    expect(rows.resent).toBe(true);
    expect(children).toHaveLength(2);
    expect(io.server.rpcCalls).toHaveLength(2);
    expect(pendingKeys()).toEqual([]);
    mutation.onSuccess(rows, undefined);
    expect(io.info).toHaveBeenCalledWith(expect.stringContaining('lần bấm trước'));
  });

  it('dấu bản trước (≥ 10 phút, không tên thao tác) không chặn; sinh xong dấu được gỡ', async () => {
    marker('voucher-recurring-generate', 'generate');
    const rows = await generate().mutationFn(undefined);
    expect(rows).toHaveLength(2);
    expect(pendingKeys()).toEqual([]);
  });

  it('bấm đúp khi lần đầu chưa xong: lần hai bị chặn ngay, máy chủ chỉ nhận một lệnh', async () => {
    const mutation = generate();
    const [first, second] = await Promise.allSettled([mutation.mutationFn(undefined), mutation.mutationFn(undefined)]);
    expect(first).toMatchObject({ status: 'fulfilled' });
    expect(second).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: expect.stringContaining('đang được xử lý') }) });
    expect(io.server.rpcCalls).toHaveLength(1);
    expect(children).toHaveLength(2);
  });

  it('máy chủ từ chối rõ: lời từ chối đi nguyên, không giữ dấu', async () => {
    io.server.rpcHandlers.generate_recurring_vouchers_v2 = () => ({ data: null, error: { code: '42501', message: 'permission denied' } });
    await expect(generate().mutationFn(undefined)).rejects.toMatchObject({ code: '42501' });
    expect(pendingKeys()).toEqual([]);
  });

  it('biên nhận hỏng dạng: không báo đã sinh, giữ dấu; lần bấm sau gửi lại và máy chủ chỉ sinh phần còn thiếu', async () => {
    const mutation = generate();
    const real = io.server.rpcHandlers.generate_recurring_vouchers_v2;
    io.server.rpcHandlers.generate_recurring_vouchers_v2 = args => { real(args); return { data: [{ parent_id: 'p1' }], error: null }; };
    await expect(mutation.mutationFn(undefined)).rejects.toThrow(/Chưa xác nhận/);
    expect(pendingKeys()).toHaveLength(1);
    io.server.rpcHandlers.generate_recurring_vouchers_v2 = real;
    await expect(mutation.mutationFn(undefined)).resolves.toHaveLength(0);
    expect(children).toHaveLength(2);
    expect(pendingKeys()).toEqual([]);
  });
});

describe('cờ KQKD phiếu bỏ cọc (voucher-kqkd, tiền, cách A)', () => {
  let flag: boolean | null;
  let events: number;
  beforeEach(() => {
    flag = null;
    events = 0;
    io.server.rpcHandlers.set_forfeit_voucher_kqkd_v1 = ({ p_voucher, p_kqkd }) => {
      if (flag === p_kqkd) return { data: { id: p_voucher, changed: false, business_result_accounting: flag, kqkd_amount: flag ? 100 : 0 }, error: null };
      flag = p_kqkd as boolean;
      events += 1;
      return { data: { id: p_voucher, changed: true, business_result_accounting: flag, kqkd_amount: flag ? 100 : 0, total_amount: 100 }, error: null };
    };
  });
  type Input = { voucherId: string; kqkd: boolean; reason: string };
  type Result = { id: string; changed: boolean; business_result_accounting: boolean | null; resent?: boolean };
  const setKqkd = () => mutationOf<Input, Result>(renderHook(() => useSetForfeitVoucherKqkd()).result);
  const input: Input = { voucherId: 'v1', kqkd: true, reason: 'Bổ sung báo cáo' };

  it('lệnh không tới máy chủ: báo chưa rõ, bấm lại gửi lại NGAY và đổi cờ một lần', async () => {
    const mutation = setKqkd();
    io.server.failNext('set_forfeit_voucher_kqkd_v1', 'rpc', 'drop-before');
    await expect(mutation.mutationFn(input)).rejects.toMatchObject({ outcome: 'unknown' });
    expect(flag).toBeNull();
    expect(pendingKeys()).toHaveLength(1);
    await expect(mutation.mutationFn(input)).resolves.toMatchObject({ id: 'v1', changed: true, business_result_accounting: true });
    expect(events).toBe(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('tới nhưng mất phản hồi: bấm lại máy chủ trả «không đổi», không ghi nhật ký lần hai, không đảo cờ', async () => {
    const mutation = setKqkd();
    io.server.failNext('set_forfeit_voucher_kqkd_v1', 'rpc', 'drop-after');
    await expect(mutation.mutationFn(input)).rejects.toMatchObject({ outcome: 'unknown' });
    expect(flag).toBe(true);
    const result = await mutation.mutationFn(input);
    expect(result).toMatchObject({ id: 'v1', changed: false, business_result_accounting: true, resent: true });
    expect(flag).toBe(true);
    expect(events).toBe(1);
    expect(pendingKeys()).toEqual([]);
    mutation.onSuccess(result, input);
    expect(io.info).toHaveBeenCalledWith(expect.stringContaining('lần bấm trước'));
  });

  it('dấu bản trước của đúng phiếu (≥ 10 phút, không tên thao tác) không chặn; đổi xong dấu được gỡ', async () => {
    marker('voucher-kqkd', 'v1');
    await expect(setKqkd().mutationFn(input)).resolves.toMatchObject({ changed: true });
    expect(pendingKeys()).toEqual([]);
  });

  it('máy chủ từ chối rõ (lợi nhuận tháng đã chốt): lời từ chối đi nguyên, không giữ dấu', async () => {
    io.server.rpcHandlers.set_forfeit_voucher_kqkd_v1 = () => ({ data: null, error: { code: 'P0001', message: '[PROFIT_LOCKED] Lợi nhuận tháng 10/2026 của toà này đã chốt' } });
    const error = await setKqkd().mutationFn(input).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'P0001' });
    expect(error).not.toBeInstanceOf(FinancialWorkflowError);
    expect(pendingKeys()).toEqual([]);
  });
});
