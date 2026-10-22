// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Building, Room } from '@/pages/phong-trong/sampleData';
import type { SaleRoomRpcInvoker } from '@/lib/saleRoomOperations';
interface SheetInventoryFixture {
  isError: boolean;
  data: {
    buildings: Array<Pick<Building, 'id' | 'contactPhone'>>;
    rooms: Array<{ room: Pick<Room, 'id'>; capabilities: { edit: boolean } }>;
  };
}
interface PhoneReply {
  data: { id: string; public_contact_phone: string | null } | null;
  error: { code?: string; message?: string } | null;
}
interface PhoneQuery {
  update(patch: { public_contact_phone: string | null }): PhoneQuery;
  eq(key: string, value: unknown): PhoneQuery;
  is(key: string, value: unknown): PhoneQuery;
  select(columns: string): PhoneQuery;
  maybeSingle(): Promise<PhoneReply>;
}
const org = '10000000-0000-4000-8000-000000000001';
const actor = '20000000-0000-4000-8000-000000000001';
const r1 = '30000000-0000-4000-8000-000000000001';
const r2 = '30000000-0000-4000-8000-000000000002';
const b1 = '40000000-0000-4000-8000-000000000001';
const m = vi.hoisted(() => ({
  org: '', actor: '', inventory: { isError: false, data: { buildings: [], rooms: [] } } as SheetInventoryFixture,
  perms: {} as { __superadmin?: boolean }, rpc: vi.fn<SaleRoomRpcInvoker>(), from: vi.fn<() => PhoneQuery>(),
  filters: [] as unknown[], phoneReply: { data: null, error: null } as PhoneReply, rawPhone: '0900000000' as string | null,
}));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: m.org }) }));
vi.mock('@/hooks/useAuth', () => ({ useSession: () => ({ data: { user: { id: m.actor } } }) }));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: m.perms, isError: false }) }));
vi.mock('@/hooks/useSaleRoomInventory', () => ({ useSaleRoomInventory: () => m.inventory }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: m.rpc, from: m.from } }));
import { RoomListSheetSaveError, useSaveRoomListSheet, type SheetSaveRequest } from '../useSaveRoomListSheet';
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>{children}</QueryClientProvider>;
const rowRequest = (id = r1, value = 4800000) => ({ input: { roomId: id, requestId: crypto.randomUUID(), expectedRevision: 'a'.repeat(32), patch: { rent_price: value } }, keys: [`price:${id}`] });
const request = (): SheetSaveRequest => ({ organizationId: org, actorId: actor, buildings: [], rooms: [rowRequest(), rowRequest(r2)] });
beforeEach(() => {
  vi.clearAllMocks(); m.org = org; m.actor = actor; m.perms = { __superadmin: true }; m.filters = []; m.rawPhone = '0900000000';
  m.inventory = { isError: false, data: { buildings: [{ id: b1, contactPhone: '0900000000' }], rooms: [r1, r2].map(id => ({ room: { id }, capabilities: { edit: true } })) } };
  m.rpc.mockImplementation(async (_name, args) => ({ data: { room_id: args.p_room_id, building_id: b1, request_id: args.p_request_id, revision: 'b'.repeat(32), updated_at: '2026-10-21T01:00:00Z', fields: args.p_patch }, error: null }));
  m.phoneReply = { data: { id: b1, public_contact_phone: '0900000001' }, error: null };
  m.from.mockImplementation(() => {
    let writing = false;
    const chain: PhoneQuery = { update: patch => { writing = true; m.filters.push(['update', patch]); return chain; }, eq: (key, value) => { m.filters.push(['eq', key, value]); return chain; }, is: (key, value) => { m.filters.push(['is', key, value]); return chain; }, select: () => chain, maybeSingle: async () => writing ? m.phoneReply : { data: { id: b1, public_contact_phone: m.rawPhone }, error: null } };
    return chain;
  });
});
describe('Excel canonical room writer', () => {
  it('E21 · Sale Admin: lưu từng phòng qua writer chung với revision và mã đối chiếu riêng', async () => {
    const h = renderHook(useSaveRoomListSheet, { wrapper }); const input = request();
    await act(async () => { expect(await h.result.current.mutateAsync(input)).toEqual([`price:${r1}`, `price:${r2}`]); });
    expect(m.from).not.toHaveBeenCalled();
    expect(m.rpc).toHaveBeenNthCalledWith(1, 'update_room_sale_info_v1', { p_organization_id: org, p_room_id: r1, p_expected_revision: 'a'.repeat(32), p_request_id: input.rooms[0]!.input.requestId, p_patch: { rent_price: 4800000 } });
  });
  it('E22 · Quản lý: phòng đầu thành công, phòng sau bị từ chối thì báo đúng phần đã lưu', async () => {
    m.rpc.mockImplementation(async (_name, args) => args.p_room_id === r2 ? { data: null, error: { code: '42501' } } : { data: { room_id: r1, building_id: b1, request_id: args.p_request_id, revision: 'b'.repeat(32), updated_at: '', fields: args.p_patch }, error: null });
    const h = renderHook(useSaveRoomListSheet, { wrapper });
    await act(async () => { await expect(h.result.current.mutateAsync(request())).rejects.toMatchObject({ savedKeys: [`price:${r1}`], total: 2, failedRoomId: r2, failure: { outcome: 'rejected' } }); });
  });
  it('E23 · Chủ trọ: biên nhận khác giá gửi không được tính thành công hoặc ghi tiếp', async () => {
    m.rpc.mockImplementation(async (_name, args) => ({ data: { room_id: r1, building_id: b1, request_id: args.p_request_id, revision: 'b'.repeat(32), updated_at: '', fields: { rent_price: 1 } }, error: null }));
    const h = renderHook(useSaveRoomListSheet, { wrapper });
    await act(async () => { await expect(h.result.current.mutateAsync(request())).rejects.toMatchObject({ savedKeys: [], failedRoomId: r1, failure: { outcome: 'unknown' } }); });
    expect(m.rpc).toHaveBeenCalledTimes(1);
  });
  it('E24 · Chủ công ty: lưu tối đa 50 phòng mỗi lần, không gửi lô 51 phòng', async () => {
    const h = renderHook(useSaveRoomListSheet, { wrapper }); const input = request(); input.rooms = Array.from({ length: 51 }, () => rowRequest());
    await act(async () => { await expect(h.result.current.mutateAsync(input)).rejects.toBeInstanceOf(RoomListSheetSaveError); });
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it('E25 · Sale: mất quyền ở phòng thứ hai thì giữ thành công phòng đầu và dừng', async () => {
    const original = m.rpc.getMockImplementation()!;
    m.rpc.mockImplementation(async (...args) => { const result = await original(...args); m.inventory.data.rooms[1]!.capabilities.edit = false; return result; });
    const h = renderHook(useSaveRoomListSheet, { wrapper });
    await act(async () => { await expect(h.result.current.mutateAsync(request())).rejects.toMatchObject({ savedKeys: [`price:${r1}`], failedRoomId: r2, failure: { code: '42501' } }); });
    expect(m.rpc).toHaveBeenCalledTimes(1);
  });
  it('E26 · Sale Admin: lỗi đọc inventory khóa ghi cả khi còn dữ liệu cũ', async () => {
    m.inventory.isError = true; const h = renderHook(useSaveRoomListSheet, { wrapper });
    await act(async () => { await expect(h.result.current.mutateAsync(request())).rejects.toMatchObject({ savedKeys: [], failure: { outcome: 'rejected' } }); });
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it('E27 · Quản lý: SĐT tòa dùng tổ chức và giá trị gốc để tránh đè thay đổi khác', async () => {
    const h = renderHook(useSaveRoomListSheet, { wrapper }); const input = request(); input.rooms = []; input.buildings = [{ id: b1, phone: '0900000001', originalPhone: '0900000000' }];
    await act(async () => { expect(await h.result.current.mutateAsync(input)).toEqual([`phone:${b1}`]); });
    expect(m.filters).toContainEqual(['eq', 'organization_id', org]); expect(m.filters).toContainEqual(['eq', 'public_contact_phone', '0900000000']);
  });
  it('E28 · Sale: quyền sửa phòng không tự cấp quyền sửa hotline tòa', async () => {
    m.perms = {}; const h = renderHook(useSaveRoomListSheet, { wrapper }); const input = request(); input.buildings = [{ id: b1, phone: '0900000001', originalPhone: '0900000000' }];
    await act(async () => { await expect(h.result.current.mutateAsync(input)).rejects.toMatchObject({ failedBuildingId: b1, failure: { code: '42501' } }); });
    expect(m.from).not.toHaveBeenCalled(); expect(m.rpc).not.toHaveBeenCalled();
  });
  it('E29 · Chủ trọ: lỗi phiên bản trả conflict, không đánh dấu ô đã lưu', async () => {
    m.rpc.mockResolvedValue({ data: null, error: { code: 'PT409' } }); const h = renderHook(useSaveRoomListSheet, { wrapper });
    await act(async () => { await expect(h.result.current.mutateAsync(request())).rejects.toMatchObject({ savedKeys: [], failure: { outcome: 'conflict' } }); });
  });
  it('E30 · Chủ công ty: yêu cầu từ tổ chức cũ không được ghi sau chuyển công ty', async () => {
    m.org = '10000000-0000-4000-8000-000000000002'; const h = renderHook(useSaveRoomListSheet, { wrapper });
    await act(async () => { await expect(h.result.current.mutateAsync(request())).rejects.toMatchObject({ failure: { code: '42501' } }); });
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it('E31 · Chủ trọ: SĐT legacy rỗng hoặc có khoảng trắng vẫn CAS theo giá trị thật', async () => {
    m.rawPhone = ' 0900000000 '; const h = renderHook(useSaveRoomListSheet, { wrapper }); const input = request(); input.rooms = []; input.buildings = [{ id: b1, phone: '0900000001', originalPhone: '0900000000' }];
    await act(async () => { await h.result.current.mutateAsync(input); });
    expect(m.filters).toContainEqual(['eq', 'public_contact_phone', ' 0900000000 ']);
    m.filters = []; m.rawPhone = ''; input.buildings[0]!.originalPhone = null;
    await act(async () => { await h.result.current.mutateAsync(input); });
    expect(m.filters).toContainEqual(['eq', 'public_contact_phone', '']);
  });
});
