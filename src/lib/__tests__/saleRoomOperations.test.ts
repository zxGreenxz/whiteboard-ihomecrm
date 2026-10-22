import { describe, expect, it, vi } from 'vitest';
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { storage: { from: () => ({ getPublicUrl: (path: string) => ({ data: { publicUrl: `https://storage.test/${path}` } }) }) } },
}));
import {
  buildSaleRoomPatchArgs, parseSaleRoomInventory, patchSaleRoom,
  SaleRoomOperationError, type SaleRoomRpcInvoker, type PatchSaleRoomInput,
} from '../saleRoomOperations';

const org = '10000000-0000-4000-8000-000000000001';
const roomId = '20000000-0000-4000-8000-000000000001';
const buildingId = '30000000-0000-4000-8000-000000000001';
const requestId = '40000000-0000-4000-8000-000000000001';
const revision = 'a'.repeat(32);
const input = { roomId, requestId, expectedRevision: revision, patch: { rent_price: 3_500_000, sale_note: null } };
const receipt = {
  room_id: roomId, building_id: buildingId, request_id: requestId, revision: 'b'.repeat(32),
  updated_at: '2026-10-21T01:00:00Z', fields: { sale_note: null, rent_price: 3_500_000 },
};

describe('sale room patch receipt and validation', () => {
  it('keeps explicit null and only sends the requested fields', () => {
    expect(buildSaleRoomPatchArgs(org, input)).toEqual({
      p_organization_id: org, p_room_id: roomId, p_request_id: requestId,
      p_expected_revision: revision, p_patch: input.patch,
    });
  });
  it.each([
    { status: 'AVAILABLE' }, { building_id: buildingId }, { organization_id: org },
    { rent_price: null }, { rent_price: -1 }, { rent_price: 1.5 }, { rent_price: Number.MAX_SAFE_INTEGER + 1 },
    { rent_price: 10_000_000_000_000 },
    { area: 1.234 }, { area: -1 }, { images: ['javascript:alert(1)'] },
    { images: ['https://name:secret@images.test/x.png'] }, { images: ['../other-org/image.png'] },
    { images: ['blob:https://app.test/a'] }, {},
  ])('rejects invalid or non-sale patch before dispatch: %j', async patch => {
    const rpc = vi.fn();
    const invalid: unknown = { ...input, patch };
    await expect(patchSaleRoom(rpc, org, invalid as PatchSaleRoomInput)).rejects.toMatchObject({ outcome: 'rejected' });
    expect(rpc).not.toHaveBeenCalled();
  });
  it('accepts nullable area and public storage references', () => {
    expect(buildSaleRoomPatchArgs(org, { ...input, patch: {
      area: null, images: ['organization/room/a.webp', 'https://images.test/room-sale-images/a.webp'],
    } }).p_patch.area).toBeNull();
  });
  it('does not interpret key ordering as a mismatched receipt', async () => {
    const rpc: SaleRoomRpcInvoker = async () => ({ data: receipt, error: null });
    await expect(patchSaleRoom(rpc, org, input)).resolves.toEqual(receipt);
  });
  it.each([
    null,
    { ...receipt, room_id: org },
    { ...receipt, request_id: org },
    { ...receipt, fields: { rent_price: 4_000_000 } },
  ])('does not claim success from an unrelated or malformed receipt', async data => {
    const rpc: SaleRoomRpcInvoker = async () => ({ data, error: null });
    await expect(patchSaleRoom(rpc, org, input)).rejects.toMatchObject({ outcome: 'unknown' });
  });
  it.each([
    ['PT409', 'conflict'], ['42501', 'rejected'], ['22023', 'rejected'], ['22003', 'rejected'], ['23514', 'rejected'],
    ['PGRST301', 'rejected'], ['PGRST202', 'unknown'],
  ])('classifies %s without losing outcome semantics', async (code, outcome) => {
    const rpc: SaleRoomRpcInvoker = async () => ({ data: null, error: { code, message: 'fixture' } });
    await expect(patchSaleRoom(rpc, org, input)).rejects.toMatchObject({ outcome, code });
  });
  it('can reconcile a lost response with the identical request ID and payload', async () => {
    const rpc = vi.fn<SaleRoomRpcInvoker>()
      .mockRejectedValueOnce(new TypeError('Network disconnected'))
      .mockResolvedValueOnce({ data: receipt, error: null });
    await expect(patchSaleRoom(rpc, org, input)).rejects.toBeInstanceOf(SaleRoomOperationError);
    await expect(patchSaleRoom(rpc, org, input)).resolves.toEqual(receipt);
    expect(rpc.mock.calls[0]).toEqual(rpc.mock.calls[1]);
  });
});

function inventoryPayload() {
  return {
    server_now: '2026-10-21T01:00:00Z', areas: [], contact: null,
    buildings: [{ id: buildingId, name: 'Tòa thử', code: 'TEST', district: null, ward: null,
      address: 'Địa chỉ giả', total_floors: 2, images: [] }],
    rooms: [{
      id: roomId, building_id: buildingId, floor: 1, name: '101', code: null,
      area: 20, rent_price: 3_000_000, max_occupants: 2, amenities: [], images: [],
      description: null, sale_note: null, sale_bonus_note: 'Chỉ người có quyền sửa',
      status_public: 'rented', avail_date: null, sale_state: 'RENTED', sale_today: '2026-10-21',
      revision, updated_at: '2026-10-21T01:00:00Z', updated_by_name: null,
      capabilities: { edit: false, images: true, pass: false, lock: false, releaseLock: false, deposit: false },
    }],
  };
}
describe('full scoped management inventory', () => {
  it('keeps a rented room even when the building has no room to advertise', () => {
    const parsed = parseSaleRoomInventory(inventoryPayload());
    expect(parsed.rooms).toHaveLength(1);
    expect(parsed.rooms[0]?.room.status).toBe('rented');
    expect(parsed.rooms[0]?.saleBonusNote).toBeNull();
    expect(parsed.rooms[0]?.room.saleBonus).toBeNull();
  });
  it('requires a version and all action capabilities instead of inventing rights', () => {
    const payload = inventoryPayload();
    const bad = { ...payload, rooms: payload.rooms.map(r => ({ ...r, capabilities: { edit: true } })) };
    expect(() => parseSaleRoomInventory(bad)).toThrow();
  });
  it('rejects duplicate identities and orphan rooms', () => {
    const payload = inventoryPayload();
    expect(() => parseSaleRoomInventory({ ...payload, rooms: [...payload.rooms, ...payload.rooms] })).toThrow();
    expect(() => parseSaleRoomInventory({ ...payload, buildings: [] })).toThrow();
  });
});
