// @vitest-environment jsdom
// Đợt 7: chuyển phòng (cách B). Máy chủ giả dựng theo thân hàm production 26/11/2026: transfer_room_with_notice_v2 →
// apply_contract_notice_transition_v1 khoá công ty + hai phòng + hợp đồng FOR UPDATE, rồi tra contract_notice_transition_events
// theo request_id (duy nhất): cùng mã cùng nội dung ⇒ trả hợp đồng cũ; khác nội dung ⇒ 23505. Phiên bản hợp đồng
// (expected_updated_at) chỉ được so SAU khi tra mã ⇒ PT409.
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRecordServer, pendingKeys, seedLegacyPending, type FakeRecordServer } from './fakeRecordServer';

const io = vi.hoisted(() => ({ server: undefined as unknown as FakeRecordServer, org: '00000000-0000-4000-8000-000000000001', hideEventReads: 0 }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useRef: (current: unknown) => ({ current }) }));
vi.mock('@tanstack/react-query', () => ({ useMutation: (options: unknown) => options, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor' }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (table: string) => io.server.from(table), get rpc() { return io.server.rpc; } } }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: io.org }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { useTransferRoom } from '../useContractOperations';

type Row = Record<string, unknown>;
const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const CONTRACT = id(2), OLD_ROOM = id(3), NEW_ROOM = id(4);
const input = { contractId: CONTRACT, expectedUpdatedAt: '2026-09-28T00:00:00Z', requestId: id(9), newRoomId: NEW_ROOM, transferDate: '2026-10-01', newRentPrice: 100, newDeposit: 200, quoteKey: 'b'.repeat(32) };
const transfer = (value: typeof input) => (renderHook(() => useTransferRoom()).result.current as unknown as { mutationFn: (v: unknown) => Promise<Row> }).mutationFn(value);
const transferKeys = () => io.server.rpcCalls.filter(call => call.name === 'transfer_room_with_notice_v2').map(call => call.args.p_request_id);
const scope = { namespace: 'contract-notice-transition', userId: 'actor', organizationId: 'actor-scope', businessKey: CONTRACT };

function install() {
  io.server.rows.contracts = [{ id: CONTRACT, organization_id: id(1), contract_number: 'HĐ26-009', status: 'ACTIVE', end_date: '2027-12-31', rent_price: 90, total_deposit: 150, room_id: OLD_ROOM, room: { id: OLD_ROOM, name: 'P101' }, expected_move_out_date: null, updated_at: '2026-09-28T00:00:00Z' }];
  io.server.rows.contract_notice_transition_events = [];
  // Ẩn sự kiện ở vài lần đọc đầu (giả lệnh cũ ghi xong ngay SAU lần đọc đối chiếu).
  const events = io.server.rows.contract_notice_transition_events;
  io.server.visible.contract_notice_transition_events = () => (io.hideEventReads > 0 ? (io.hideEventReads -= 1, false) : true);
  let moves = 0;
  io.server.rpcHandlers.transfer_room_with_notice_v2 = args => {
    const hash = JSON.stringify([args.p_contract_id, args.p_expected_updated_at, args.p_new_room_id, args.p_new_rent_price, args.p_transfer_date, args.p_new_deposit, args.p_quote_key, args.p_notice_reason ?? null]);
    const prior = events.find(row => row.request_id === args.p_request_id);
    if (prior) return prior.hash === hash ? { data: CONTRACT, error: null } : { data: null, error: { code: '23505', message: 'Mã yêu cầu đã dùng cho dữ kiện khác' } };
    const contract = io.server.rows.contracts[0]!;
    if (contract.updated_at !== args.p_expected_updated_at) return { data: null, error: { code: 'PT409', message: 'Hợp đồng đã thay đổi; vui lòng tải lại trước khi tiếp tục' } };
    moves += 1;
    Object.assign(contract, { room_id: args.p_new_room_id, room: { id: args.p_new_room_id, name: 'P203' }, rent_price: args.p_new_rent_price, total_deposit: args.p_new_deposit, updated_at: `2026-10-0${moves}T00:00:00Z` });
    events.push({ id: id(50 + moves), organization_id: id(1), contract_id: CONTRACT, result_contract_id: CONTRACT, request_id: args.p_request_id, operation: 'TRANSFER_ROOM', notice_choice: 'CANCEL', previous_notice_date: null, expected_updated_at: args.p_expected_updated_at, hash });
    return { data: CONTRACT, error: null };
  };
  return () => moves;
}

beforeEach(() => {
  localStorage.clear();
  io.org = id(1);
  io.hideEventReads = 0;
  io.server = fakeRecordServer();
});

describe('chuyển phòng (cách B)', () => {
  it('lệnh không tới máy chủ: chưa có sự kiện theo mã ⇒ lần bấm sau gửi lại ngay ĐÚNG mã cũ, chuyển một lần', async () => {
    const moves = install();
    io.server.failNext('transfer_room_with_notice_v2', 'rpc', 'drop-before');
    await expect(transfer(input)).rejects.toBeTruthy();
    await expect(transfer(input)).resolves.toMatchObject({ contractId: CONTRACT, roomId: NEW_ROOM });
    expect(transferKeys()).toHaveLength(2);
    expect(new Set(transferKeys()).size).toBe(1);
    expect(transferKeys()[0]).not.toBe(input.requestId);
    expect(moves()).toBe(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('tới nhưng mất phản hồi: đọc thấy sự kiện theo mã ⇒ trả biên nhận, không gửi lần hai', async () => {
    const moves = install();
    io.server.failNext('transfer_room_with_notice_v2', 'rpc', 'drop-after');
    await expect(transfer(input)).rejects.toBeTruthy();
    await expect(transfer(input)).resolves.toMatchObject({ contractId: CONTRACT, roomName: 'P203' });
    expect(transferKeys()).toHaveLength(1);
    expect(moves()).toBe(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('mất phản hồi rồi bấm lại với nội dung khác: báo đã chuyển ở lần trước, không gửi lần hai', async () => {
    install();
    io.server.failNext('transfer_room_with_notice_v2', 'rpc', 'drop-after');
    await expect(transfer(input)).rejects.toBeTruthy();
    await expect(transfer({ ...input, newRentPrice: 120 })).rejects.toMatchObject({ alreadyRecorded: true, message: expect.stringContaining('đã được chuyển phòng ở lần gửi trước'), recordIds: [CONTRACT] });
    expect(transferKeys()).toHaveLength(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('lệnh cũ ghi xong ngay sau lần đọc đối chiếu: gửi lại cùng mã bị 23505 ⇒ đọc lại sự kiện, báo đã chuyển, không chuyển hai lần', async () => {
    const moves = install();
    io.server.failNext('transfer_room_with_notice_v2', 'rpc', 'drop-after');
    await expect(transfer(input)).rejects.toBeTruthy();
    io.hideEventReads = 1;
    await expect(transfer({ ...input, newRentPrice: 120 })).rejects.toMatchObject({ alreadyRecorded: true, message: expect.stringContaining('đã được chuyển phòng') });
    expect(new Set(transferKeys()).size).toBe(1);
    expect(moves()).toBe(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('dấu cũ gieo sẵn (bản trước, không tên thao tác), chưa có sự kiện: gửi lại đúng mã của dấu', async () => {
    const moves = install();
    // Dấu bản trước mang mã yêu cầu dạng uuid như lõi luôn sinh.
    const key = 'ihome:financial-pending:v1:' + [scope.namespace, scope.userId, scope.organizationId, scope.businessKey].map(encodeURIComponent).join(':');
    localStorage.setItem(key, JSON.stringify({ ...scope, attemptId: id(77), requestKey: id(77), completedIds: [], startedAt: new Date(Date.now() - 10 * 60_000).toISOString() }));
    await expect(transfer(input)).resolves.toMatchObject({ contractId: CONTRACT });
    expect(transferKeys()).toEqual([id(77)]);
    expect(moves()).toBe(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('dấu chung bản trước là của một lần GIA HẠN đã ghi: báo đã gia hạn, không chuyển phòng ở lần bấm này', async () => {
    install();
    seedLegacyPending(scope, new Date(Date.now() - 10 * 60_000));
    io.server.rows.contract_notice_transition_events.push({ id: id(60), organization_id: id(1), contract_id: CONTRACT, result_contract_id: CONTRACT, request_id: 'legacy-attempt', operation: 'RENEW' });
    await expect(transfer(input)).rejects.toMatchObject({ alreadyRecorded: true, message: expect.stringContaining('gia hạn') });
    expect(transferKeys()).toEqual([]);
    expect(pendingKeys()).toEqual([]);
  });

  it('hàng rào biên nhận: dấu đã nhận mã hợp đồng mà không đọc thấy sự kiện ⇒ giữ dấu, không gửi lại', async () => {
    install();
    seedLegacyPending(scope, new Date(Date.now() - 10 * 60_000), [CONTRACT]);
    await expect(transfer(input)).rejects.toMatchObject({ message: expect.stringContaining('đối chiếu') });
    expect(transferKeys()).toEqual([]);
    expect(pendingKeys()).toHaveLength(1);
  });

  it('hàng rào biên nhận: lần đầu đã nhận mã hợp đồng mà biên nhận lệch, lần sau vẫn lệch ⇒ giữ dấu và mã, không gỡ lặng lẽ, không gửi lại', async () => {
    install();
    const handler = io.server.rpcHandlers.transfer_room_with_notice_v2!;
    io.server.rpcHandlers.transfer_room_with_notice_v2 = args => { const result = handler(args); io.server.rows.contracts[0]!.rent_price = 999; return result; };
    await expect(transfer(input)).rejects.toMatchObject({ outcome: 'partial' });
    await expect(transfer(input)).rejects.toMatchObject({ message: expect.stringContaining('đối chiếu') });
    expect(transferKeys()).toHaveLength(1);
    expect(pendingKeys()).toHaveLength(1);
  });
  it('đọc sự kiện hỏng: chưa kết luận được ⇒ giữ dấu, không gửi lại', async () => {
    install();
    io.server.failNext('transfer_room_with_notice_v2', 'rpc', 'drop-before');
    await expect(transfer(input)).rejects.toBeTruthy();
    io.server.failNext('contract_notice_transition_events', 'read', 'drop-before');
    await expect(transfer(input)).rejects.toMatchObject({ message: expect.stringContaining('đối chiếu') });
    expect(transferKeys()).toHaveLength(1);
    expect(pendingKeys()).toHaveLength(1);
  });

  it('hợp đồng đã đổi bởi người khác (PT409 khi gửi lại): từ chối rõ, gỡ dấu, không chuyển', async () => {
    const moves = install();
    io.server.failNext('transfer_room_with_notice_v2', 'rpc', 'drop-before');
    await expect(transfer(input)).rejects.toBeTruthy();
    io.server.rows.contracts[0]!.updated_at = '2026-09-29T00:00:00Z';
    await expect(transfer(input)).rejects.toMatchObject({ code: 'PT409' });
    expect(moves()).toBe(0);
    expect(pendingKeys()).toEqual([]);
  });
});
