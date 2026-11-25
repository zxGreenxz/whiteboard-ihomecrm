// @vitest-environment jsdom
// Đợt 6: tạo hợp đồng (create_contract_v2) và gia hạn (renew_contract_with_notice_v1), cách B. Thân hàm production
// 25/11/2026: create_contract_v2 khoá phòng FOR UPDATE + khoá công ty rồi mới tra mã (subject phòng|ngày bắt đầu), băm cả
// payload; cùng mã cùng nội dung ⇒ trả hợp đồng cũ; khác ⇒ 23505 «idempotency_key đã dùng với nội dung khác»; phòng đã có hợp
// đồng hiệu lực ⇒ 23505. Gia hạn: apply_contract_notice_transition_v1 khoá công ty + hợp đồng rồi tra sự kiện theo mã.
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRecordServer, pendingKeys, seedLegacyPending, type FakeRecordServer } from './fakeRecordServer';

const io = vi.hoisted(() => ({ server: undefined as unknown as FakeRecordServer, org: '00000000-0000-4000-8000-000000000001' }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useRef: (current: unknown) => ({ current }) }));
vi.mock('@tanstack/react-query', () => ({ useMutation: (options: unknown) => options, useQuery: vi.fn(), useQueryClient: () => ({ invalidateQueries: vi.fn() }), keepPreviousData: undefined }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor' }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (table: string) => io.server.from(table), get rpc() { return io.server.rpc; } } }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: io.org }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('@/hooks/useRealtimeDataSync', () => ({ markLocalWrite: vi.fn() }));

import { useCreateContract } from '../useContracts';
import { useRenewContract } from '../useContractOperations';
import type { ContractCreateRequest } from '@/lib/contractCreateRpc';

type Row = Record<string, unknown>;
const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const ROOM = id(10);
const request = (over: Partial<ContractCreateRequest['payload']['contract']> = {}): ContractCreateRequest => ({
  payload: {
    contract: { room_id: ROOM, signed_date: '2026-11-01', start_date: '2026-11-01', end_date: '2027-10-31', rent_price: 5_000_000, total_deposit: 5_000_000, payment_cycle: 'MONTHLY', ...over },
    customers: [{ customer_id: id(11), is_representative: true }], services: [],
  },
  idempotencyKey: 'contract-create-placeholder',
});
const create = (value: ContractCreateRequest) => (renderHook(() => useCreateContract()).result.current as unknown as { mutationFn: (v: unknown) => Promise<Row> }).mutationFn(value);
const createKeys = () => io.server.rpcCalls.filter(call => call.name === 'create_contract_v2').map(call => call.args.p_idempotency_key);
const contracts = () => io.server.rows.contracts;
let seq = 0;
function installCreate(receipt: (payload: Row, contractId: string) => Row = (payload, contractId) => ({ id: contractId, contract_number: `HĐ-${seq}`, room_id: (payload.contract as Row).room_id, status: 'ACTIVE', rent_price: (payload.contract as Row).rent_price, total_deposit: (payload.contract as Row).total_deposit })) {
  const claims = new Map<string, { hash: string; response: unknown }>();
  io.server.rpcHandlers.create_contract_v2 = args => {
    const payload = args.p_payload as Row;
    const hash = JSON.stringify(payload);
    // Mã được tra trong phạm vi (phòng, ngày bắt đầu) như production: đổi ngày bắt đầu là phạm vi khác, không thấy mã cũ.
    const scopeKey = [args.p_idempotency_key, (payload.contract as Row).room_id, (payload.contract as Row).start_date].join('|');
    const claim = claims.get(scopeKey);
    if (claim) return claim.hash === hash ? { data: claim.response, error: null } : { data: null, error: { code: '23505', message: 'idempotency_key đã dùng với nội dung khác' } };
    // Thứ tự như production: phòng không còn trống (55000) xét trước «phòng đã có hợp đồng hiệu lực» (23505).
    if (contracts().some(row => row.room_id === (payload.contract as Row).room_id && row.status === 'ACTIVE')) return { data: null, error: { code: '55000', message: 'Trạng thái phòng không cho phép tạo hợp đồng: OCCUPIED' } };
    const contractId = id(100 + ++seq);
    contracts().push({ id: contractId, contract_number: `HĐ-${seq}`, room_id: (payload.contract as Row).room_id, status: 'ACTIVE', deleted_at: null });
    const response = { contract: receipt(payload, contractId), invoice: null, deposit_paid: 0, deposit_shortfall: 0 };
    claims.set(scopeKey, { hash, response });
    return { data: response, error: null };
  };
  return claims;
}
const createScope = { namespace: 'contract-create', userId: 'actor', organizationId: 'actor-scope', businessKey: ROOM };

beforeEach(() => {
  localStorage.clear();
  seq = 0;
  io.org = id(1);
  io.server = fakeRecordServer();
  io.server.rows.contracts = [];
});

describe('tạo hợp đồng (cách B)', () => {
  it('lệnh không tới máy chủ: gửi lại ngay đúng mã cũ, một hợp đồng', async () => {
    installCreate();
    io.server.failNext('create_contract_v2', 'rpc', 'drop-before');
    await expect(create(request())).rejects.toBeTruthy();
    await expect(create(request())).resolves.toMatchObject({ id: id(101), room_id: ROOM });
    expect(createKeys()).toHaveLength(2);
    expect(new Set(createKeys()).size).toBe(1);
    expect(contracts()).toHaveLength(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('tới nhưng mất phản hồi: gửi lại cùng mã nhận hợp đồng cũ', async () => {
    installCreate();
    io.server.failNext('create_contract_v2', 'rpc', 'drop-after');
    await expect(create(request())).rejects.toBeTruthy();
    await expect(create(request())).resolves.toMatchObject({ id: id(101) });
    expect(contracts()).toHaveLength(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('mất phản hồi rồi bấm lại với nội dung form đã đổi: máy chủ báo trùng mã ⇒ đọc hợp đồng hiệu lực của phòng, báo mã, không tạo lần hai', async () => {
    installCreate();
    io.server.failNext('create_contract_v2', 'rpc', 'drop-after');
    await expect(create(request())).rejects.toBeTruthy();
    await expect(create(request({ rent_price: 6_000_000 }))).rejects.toMatchObject({ alreadyRecorded: true, recordIds: [id(101)], message: expect.stringContaining('HĐ-1') });
    expect(contracts()).toHaveLength(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('mất phản hồi rồi bấm lại đổi ngày bắt đầu (khoá máy chủ khác phạm vi): phòng đã có hợp đồng ⇒ báo mã, không tạo lần hai', async () => {
    installCreate();
    io.server.failNext('create_contract_v2', 'rpc', 'drop-after');
    await expect(create(request())).rejects.toBeTruthy();
    await expect(create(request({ start_date: '2026-11-02', signed_date: '2026-11-02' }))).rejects.toMatchObject({ alreadyRecorded: true, recordIds: [id(101)] });
    expect(contracts()).toHaveLength(1);
  });

  it('dấu cũ gieo sẵn: gửi lại đúng mã của dấu', async () => {
    installCreate();
    seedLegacyPending(createScope, new Date(Date.now() - 10 * 60_000));
    await expect(create(request())).resolves.toMatchObject({ id: id(101) });
    expect(createKeys()).toEqual(['legacy-attempt']);
  });

  it('dấu cũ đã nhận mã hợp đồng (biên nhận lệch ở bản trước): báo đã tạo, không gửi', async () => {
    installCreate();
    seedLegacyPending(createScope, new Date(Date.now() - 10 * 60_000), [id(99)]);
    await expect(create(request())).rejects.toMatchObject({ alreadyRecorded: true, recordIds: [id(99)] });
    expect(createKeys()).toEqual([]);
    expect(pendingKeys()).toEqual([]);
  });

  it('biên nhận lệch sau khi tạo: hàng rào giữ mã hợp đồng trong dấu; lần bấm sau báo đã tạo kèm mã, gỡ dấu, không gửi lần hai', async () => {
    installCreate((payload, contractId) => ({ id: contractId, contract_number: 'HĐ-L', room_id: (payload.contract as Row).room_id, status: 'ACTIVE', rent_price: 1, total_deposit: (payload.contract as Row).total_deposit }));
    await expect(create(request())).rejects.toMatchObject({ outcome: 'partial', completed: [expect.objectContaining({ id: id(101) })] });
    expect(pendingKeys()).toHaveLength(1);
    await expect(create(request())).rejects.toMatchObject({ outcome: 'failure', alreadyRecorded: true, recordIds: [id(101)] });
    expect(createKeys()).toHaveLength(1);
    expect(contracts()).toHaveLength(1);
    expect(pendingKeys()).toEqual([]);
  });
});

const renewInput = { contractId: id(2), expectedUpdatedAt: '2026-09-28T00:00:00Z', requestId: id(3), newEndDate: '2027-12-31', newRentPrice: 100, newDeposit: 200, noticeChoice: 'KEEP' as const };
const renew = (value: typeof renewInput) => (renderHook(() => useRenewContract()).result.current as unknown as { mutationFn: (v: unknown) => Promise<Row> }).mutationFn(value);
const renewKeys = () => io.server.rpcCalls.filter(call => call.name === 'renew_contract_with_notice_v1').map(call => call.args.p_request_id);
function installRenew() {
  io.server.rows.contracts = [{ id: id(2), organization_id: id(1), contract_number: 'HĐ26-009', status: 'ACTIVE', end_date: '2027-06-30', rent_price: 100, total_deposit: 200, room_id: id(4), room: { id: id(4), name: 'P203' }, expected_move_out_date: '2026-11-01' }];
  io.server.rows.contract_notice_transition_events = [];
  let writes = 0;
  io.server.rpcHandlers.renew_contract_with_notice_v1 = args => {
    const events = io.server.rows.contract_notice_transition_events;
    const prior = events.find(row => row.request_id === args.p_request_id);
    const hash = JSON.stringify([args.p_new_end_date, args.p_new_rent_price, args.p_new_deposit, args.p_expected_updated_at, args.p_notice_choice]);
    if (prior) return prior.hash === hash ? { data: id(2), error: null } : { data: null, error: { code: '23505', message: 'Mã yêu cầu đã dùng cho dữ kiện khác' } };
    writes += 1;
    io.server.rows.contracts[0]!.end_date = args.p_new_end_date;
    events.push({ id: id(5), organization_id: id(1), contract_id: id(2), result_contract_id: id(2), request_id: args.p_request_id, operation: 'RENEW', notice_choice: 'KEEP', previous_notice_date: '2026-11-01', expected_updated_at: args.p_expected_updated_at, hash });
    return { data: id(2), error: null };
  };
  return () => writes;
}

describe('gia hạn hợp đồng (cách B)', () => {
  it('lệnh không tới máy chủ: chưa có sự kiện theo mã ⇒ gửi lại ngay đúng mã cũ', async () => {
    const writes = installRenew();
    io.server.failNext('renew_contract_with_notice_v1', 'rpc', 'drop-before');
    await expect(renew(renewInput)).rejects.toBeTruthy();
    await expect(renew(renewInput)).resolves.toMatchObject({ contractId: id(2), endDate: '2027-12-31' });
    expect(new Set(renewKeys()).size).toBe(1);
    expect(renewKeys()[0]).not.toBe(id(3));
    expect(writes()).toBe(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('tới nhưng mất phản hồi: đọc thấy sự kiện theo mã ⇒ trả biên nhận, không gửi lần hai', async () => {
    const writes = installRenew();
    io.server.failNext('renew_contract_with_notice_v1', 'rpc', 'drop-after');
    await expect(renew(renewInput)).rejects.toBeTruthy();
    await expect(renew(renewInput)).resolves.toMatchObject({ contractId: id(2), endDate: '2027-12-31' });
    expect(renewKeys()).toHaveLength(1);
    expect(writes()).toBe(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('tới nhưng mất phản hồi, bấm lại với ngày khác: báo đã gia hạn ở lần trước, không gửi', async () => {
    installRenew();
    io.server.failNext('renew_contract_with_notice_v1', 'rpc', 'drop-after');
    await expect(renew(renewInput)).rejects.toBeTruthy();
    await expect(renew({ ...renewInput, newEndDate: '2028-01-31' })).rejects.toMatchObject({ alreadyRecorded: true, message: expect.stringContaining('đã được gia hạn') });
    expect(renewKeys()).toHaveLength(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('dấu chung bản trước `contract-notice-transition` của đúng hợp đồng: chặn gia hạn qua hộp cảnh báo, không gửi', async () => {
    installRenew();
    seedLegacyPending({ namespace: 'contract-notice-transition', userId: 'actor', organizationId: 'actor-scope', businessKey: id(2) }, new Date(Date.now() - 10 * 60_000));
    await expect(renew(renewInput)).rejects.toMatchObject({ message: expect.stringContaining('đối chiếu') });
    expect(renewKeys()).toEqual([]);
  });

  it('dấu gieo sẵn ở namespace mới (không tên thao tác): gửi lại đúng mã của dấu', async () => {
    const writes = installRenew();
    const key = 'ihome:financial-pending:v1:' + ['contract-renew', 'actor', 'actor-scope', id(2)].map(encodeURIComponent).join(':');
    localStorage.setItem(key, JSON.stringify({ namespace: 'contract-renew', userId: 'actor', organizationId: 'actor-scope', businessKey: id(2), attemptId: id(77), requestKey: id(77), completedIds: [], startedAt: new Date(Date.now() - 10 * 60_000).toISOString() }));
    await expect(renew(renewInput)).resolves.toMatchObject({ contractId: id(2) });
    expect(renewKeys()).toEqual([id(77)]);
    expect(writes()).toBe(1);
    expect(pendingKeys()).toEqual([]);
  });
});
