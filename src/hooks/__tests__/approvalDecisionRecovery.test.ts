// @vitest-environment jsdom
// Đợt 5: quyết định một yêu cầu duyệt (cách C). decide_financial_request_v1 (production 25/11/2026) khoá yêu cầu rồi đòi
// đúng phiên bản và trạng thái chờ duyệt, nhưng bước cần nhiều người chưa đủ người thì không đổi phiên bản: gửi lại sớm
// có thể ghi thêm một dòng quyết định. Trình duyệt đọc trạng thái + phiên bản + bước trước khi ghi dấu và so lại.
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRecordServer, pendingKeys, seedLegacyPending, type FakeRecordServer } from './fakeRecordServer';

const io = vi.hoisted(() => ({ server: undefined as unknown as FakeRecordServer }));
vi.mock('@tanstack/react-query', () => ({ useMutation: (config: unknown) => config, useQuery: (config: unknown) => config, useQueryClient: () => ({ invalidateQueries: vi.fn() }), keepPreviousData: undefined }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (table: string) => io.server.from(table), get rpc() { return io.server.rpc; } } }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor' }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() } }));

import { useDecideApproval } from '../useApprovals';

type Decide = (input: { requestId: string; decision: 'APPROVE' | 'REJECT'; organizationId?: string | null }) => Promise<unknown>;
const decide = (): Decide => {
  const { result } = renderHook(() => useDecideApproval());
  return (result.current as unknown as { mutationFn: Decide }).mutationFn;
};
const request = { id: 'r1', state: 'PENDING_APPROVAL', version: 3, step: 'PENDING', decisions: 0 };
const decisions = () => io.server.rpcCalls.filter(call => call.name === 'decide_financial_request_v2').length;
const T0 = Date.parse('2026-11-25T02:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  localStorage.clear();
  io.server = fakeRecordServer();
  Object.assign(request, { state: 'PENDING_APPROVAL', version: 3, step: 'PENDING', decisions: 0 });
  io.server.rpcHandlers.get_approval_request_detail_compat_v2 = () => ({ data: {
    id: request.id, state: request.state, version: request.version, can_decide: request.state === 'PENDING_APPROVAL',
    steps: [{ step_no: 1, status: request.step, mode: 'ANY', current_generation: 1 }],
  }, error: null });
  io.server.rpcHandlers.decide_financial_request_v2 = args => {
    if (request.state !== 'PENDING_APPROVAL') return { data: null, error: { code: '42501', message: 'Bạn không nằm trong danh sách người duyệt của yêu cầu này' } };
    request.decisions += 1;
    Object.assign(request, args.p_decision === 'APPROVE' ? { state: 'POSTED', step: 'APPROVED' } : { state: 'REJECTED', step: 'REJECTED' }, { version: request.version + 1 });
    return { data: { request_id: request.id, state: request.state }, error: null };
  };
});
afterEach(() => { vi.useRealTimers(); });

describe('quyết định yêu cầu duyệt', () => {
  it('lệnh không tới máy chủ: dưới 2 phút chờ; quá 2 phút yêu cầu vẫn như lúc bấm ⇒ gửi lại, quyết định đúng một lần', async () => {
    io.server.failNext('decide_financial_request_v2', 'rpc', 'drop-before');
    await expect(decide()({ requestId: 'r1', decision: 'APPROVE' })).rejects.toMatchObject({ outcome: 'unknown' });
    await expect(decide()({ requestId: 'r1', decision: 'APPROVE' })).rejects.toMatchObject({ message: expect.stringContaining('đang chờ kết quả') });
    expect(decisions()).toBe(1);
    vi.setSystemTime(T0 + 130_000);
    await expect(decide()({ requestId: 'r1', decision: 'APPROVE' })).resolves.toMatchObject({ state: 'POSTED' });
    expect(request.decisions).toBe(1);
    expect(pendingKeys()).toEqual([]);
  });
  it('lệnh tới nhưng mất phản hồi: yêu cầu đã rời trạng thái chờ ⇒ báo trạng thái, không gửi lần hai', async () => {
    io.server.failNext('decide_financial_request_v2', 'rpc', 'drop-after');
    await expect(decide()({ requestId: 'r1', decision: 'REJECT' })).rejects.toMatchObject({ outcome: 'unknown' });
    await expect(decide()({ requestId: 'r1', decision: 'REJECT' })).rejects.toMatchObject({ outcome: 'failure', message: expect.stringContaining('Đã từ chối') });
    expect(decisions()).toBe(1);
    expect(pendingKeys()).toEqual([]);
  });
  it('dấu cũ gieo sẵn (không có ảnh trạng thái) mà yêu cầu đã được duyệt: báo, gỡ dấu, không gửi', async () => {
    Object.assign(request, { state: 'POSTED', step: 'APPROVED', version: 4 });
    seedLegacyPending({ namespace: 'approval-request', userId: 'actor', organizationId: 'actor-scope', businessKey: 'r1' }, new Date(T0 - 10 * 60_000));
    await expect(decide()({ requestId: 'r1', decision: 'APPROVE' })).rejects.toMatchObject({ outcome: 'failure', message: expect.stringContaining('Đã duyệt') });
    expect(decisions()).toBe(0);
    expect(pendingKeys()).toEqual([]);
  });
  it('dấu cũ gieo sẵn mà yêu cầu còn chờ: không biết bước có đổi hay chưa ⇒ giữ dấu cho hộp cảnh báo, không gửi', async () => {
    seedLegacyPending({ namespace: 'approval-request', userId: 'actor', organizationId: 'actor-scope', businessKey: 'r1' }, new Date(T0 - 10 * 60_000));
    await expect(decide()({ requestId: 'r1', decision: 'APPROVE' })).rejects.toMatchObject({ message: expect.stringContaining('đối chiếu') });
    expect(decisions()).toBe(0);
    expect(pendingKeys()).toHaveLength(1);
  });
  it('bước đã đổi kể từ lần bấm (người duyệt khác đã chuyển bước): không gửi lại', async () => {
    io.server.failNext('decide_financial_request_v2', 'rpc', 'drop-before');
    await expect(decide()({ requestId: 'r1', decision: 'APPROVE' })).rejects.toMatchObject({ outcome: 'unknown' });
    request.version = 5;
    vi.setSystemTime(T0 + 130_000);
    await expect(decide()({ requestId: 'r1', decision: 'APPROVE' })).rejects.toMatchObject({ outcome: 'failure', message: expect.stringContaining('chuyển bước') });
    expect(decisions()).toBe(1);
  });
  it('đọc trạng thái hỏng trước khi bấm: không ghi dấu, không gửi', async () => {
    io.server.failNext('get_approval_request_detail_compat_v2', 'rpc', 'drop-before');
    await expect(decide()({ requestId: 'r1', decision: 'APPROVE' })).rejects.toBeTruthy();
    expect(decisions()).toBe(0);
    expect(pendingKeys()).toEqual([]);
  });
});
