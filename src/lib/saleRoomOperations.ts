import { z } from 'zod';
import type { Json } from '@/integrations/supabase/types';
import { mapPayloadToBuildings, parseRoomSalePayload } from '@/pages/phong-trong/supabaseData';
import type { Building, Room } from '@/pages/phong-trong/sampleData';
import { salePolicyIsActive, saleRoomPolicySchema, type SaleRoomPolicy } from '@/lib/saleRoomPolicyTypes';

const uuid = z.string().uuid();
const revision = z.string().regex(/^[a-f0-9]{32}$/);
const imageRef = z.string().min(1).max(2048).refine(value => {
  const hasControl = Array.from(value).some(character => {
    const code = character.codePointAt(0)!;
    return code < 32 || code === 127;
  });
  if (hasControl || /(^|\/)\.\.(\/|$)/.test(value) || value.startsWith('//')) return false;
  if (!value.includes(':')) return value.trim().length > 0;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !!url.hostname;
  } catch {
    return false;
  }
}, 'Ảnh phải là đường dẫn kho hoặc HTTPS hợp lệ');

export const saleRoomPatchSchema = z.object({
  // rooms.rent_price is numeric(15,2); whole VND must fit the 13 integer digits.
  rent_price: z.number().int().nonnegative().max(9_999_999_999_999).optional(),
  area: z.number().min(0).max(1_000_000)
    .refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 0.000001, 'Diện tích tối đa hai số thập phân')
    .nullable().optional(),
  room_type: z.string().max(200).nullable().optional(),
  amenities: z.array(z.string().min(1).max(200).refine(value => !!value.trim())).max(50).optional(),
  sale_note: z.string().max(2000).nullable().optional(),
  sale_bonus_note: z.string().max(2000).nullable().optional(),
  images: z.array(imageRef).max(50).optional(),
  description: z.string().max(2000).nullable().optional(),
  sale_status_note: z.string().max(120).nullable().optional(),
  sale_status_note_key: revision.nullable().optional(),
}).strict().refine(value => Object.values(value).some(v => v !== undefined), 'Chưa có thay đổi để lưu')
  .refine(value => (value.sale_status_note !== undefined) === (value.sale_status_note_key !== undefined),
    'Chú thích tình trạng cần phiên bản tình trạng tương ứng.');
export type SaleRoomPatch = z.infer<typeof saleRoomPatchSchema>;

export const saleRoomCapabilitiesSchema = z.object({
  edit: z.boolean(), images: z.boolean(), pass: z.boolean(),
  lock: z.boolean(), releaseLock: z.boolean(), deposit: z.boolean(),
});
export type SaleRoomCapabilities = z.infer<typeof saleRoomCapabilitiesSchema>;
export interface SaleRoomInventoryRow {
  room: Room;
  buildingId: string;
  buildingName: string;
  name: string;
  code: string | null;
  revision: string;
  updatedAt: string;
  updatedByName: string | null;
  rentPrice: number | null;
  area: number | null;
  roomType: string | null;
  amenities: string[];
  saleNote: string | null;
  saleBonusNote: string | null;
  description: string | null;
  images: string[];
  capabilities: SaleRoomCapabilities;
  policy?: SaleRoomPolicy | null;
  policies?: SaleRoomPolicy[];
  activePolicyText?: string | null;
}
export interface SaleRoomInventory {
  rooms: SaleRoomInventoryRow[];
  buildings: Building[];
  serverNow: string;
  nextPolicyBoundaryAt: string | null;
  settingsOwnerId: string | null;
  canManageAccountSettings: boolean;
  readTiming?: { receivedMonotonicMs: number; requestDurationMs: number };
}
export interface PatchSaleRoomInput {
  roomId: string;
  expectedRevision: string;
  requestId: string;
  patch: SaleRoomPatch;
}
export const saleRoomPatchReceiptSchema = z.object({
  room_id: uuid, building_id: uuid, revision, updated_at: z.string(),
  request_id: uuid, fields: saleRoomPatchSchema,
});
export type SaleRoomPatchReceipt = z.infer<typeof saleRoomPatchReceiptSchema>;
export type SaleRoomRpcName = 'get_sale_room_inventory_v1' | 'update_room_sale_info_v1';
export type SaleRoomRpcInvoker = (name: SaleRoomRpcName, args: Record<string, Json>) =>
  PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;

export class SaleRoomOperationError extends Error {
  constructor(
    message: string,
    public readonly outcome: 'rejected' | 'conflict' | 'unknown',
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'SaleRoomOperationError';
  }
}
export function saleRoomOperationErrorMessage(error: unknown): string {
  if (error instanceof SaleRoomOperationError) return error.message;
  return 'Chưa xác nhận được lần lưu. Giữ nguyên yêu cầu và đối chiếu trước khi thực hiện lại.';
}

export function parseSaleRoomInventory(value: unknown): SaleRoomInventory {
  const payload = parseRoomSalePayload(value);
  const extras = z.object({
    server_now: z.string(),
    next_policy_boundary_at: z.string().nullable().optional(),
    settings_owner_id: uuid.nullable().optional(),
    can_manage_account_settings: z.boolean().optional(),
    rooms: z.array(z.object({
      id: uuid, revision, updated_at: z.string(), updated_by_name: z.string().nullable().optional(),
      capabilities: saleRoomCapabilitiesSchema,
      policy: saleRoomPolicySchema.nullable().optional(),
      policies: z.array(saleRoomPolicySchema).optional(),
      active_policy_text: z.string().nullable().optional(),
      effective_sale_note: z.string().nullable().optional(),
    })),
  }).parse(value);
  const extraById = new Map(extras.rooms.map(row => [row.id, row]));
  if (extraById.size !== payload.rooms.length) throw new Error('Danh sách phòng bị trùng hoặc thiếu phiên bản.');
  const buildings = mapPayloadToBuildings(payload, { includeInternal: true });
  const mappedById = new Map(buildings.flatMap(b => b.rooms).map(r => [r.id, r]));
  const rows = payload.rooms.map(raw => {
    const mapped = mappedById.get(raw.id);
    const extra = extraById.get(raw.id);
    if (!mapped || !extra) throw new Error('Phòng không có tòa hoặc phiên bản tương ứng.');
    const room = { ...mapped, saleBonus: extra.capabilities.edit ? mapped.saleBonus : null,
      saleNote: extra.effective_sale_note === undefined ? mapped.saleNote : extra.effective_sale_note };
    return {
      room, buildingId: raw.building_id, buildingName: room.buildingName, name: raw.name, code: raw.code,
      revision: extra.revision, updatedAt: extra.updated_at, updatedByName: extra.updated_by_name ?? null,
      rentPrice: raw.rent_price, area: raw.area, roomType: raw.room_type ?? null,
      amenities: room.amenities, saleNote: raw.sale_note ?? null,
      saleBonusNote: extra.capabilities.edit ? raw.sale_bonus_note ?? null : null,
      description: raw.description, images: room.images ?? [], capabilities: extra.capabilities,
      policy: extra.policy ?? null, policies: extra.policies, activePolicyText: extra.active_policy_text ?? null,
    };
  });
  const byId = new Map(rows.map(row => [row.room.id, row.room]));
  return { rooms: rows, serverNow: extras.server_now,
    buildings: buildings.map(building => ({ ...building,
      rooms: building.rooms.map(room => byId.get(room.id) ?? room),
      floors: building.floors.map(floor => ({ ...floor, rooms: floor.rooms.map(room => byId.get(room.id) ?? room) })),
    })),
    nextPolicyBoundaryAt: extras.next_policy_boundary_at ?? null,
    settingsOwnerId: extras.settings_owner_id ?? null,
    canManageAccountSettings: extras.can_manage_account_settings === true,
  };
}

export async function fetchSaleRoomInventory(rpc: SaleRoomRpcInvoker, organizationId: string): Promise<SaleRoomInventory> {
  const result = await rpc('get_sale_room_inventory_v1', { p_organization_id: uuid.parse(organizationId) });
  if (result.error) throw result.error;
  return parseSaleRoomInventory(result.data);
}

/** Drop expired campaign text locally even if the boundary refresh is offline. */
export function saleInventoryAtTime(data: SaleRoomInventory, serverNowMs: number, expiryNowMs = serverNowMs): SaleRoomInventory {
  let nextBoundary = Number.POSITIVE_INFINITY;
  const rooms = data.rooms.map(row => {
    const pool = row.policies ?? (row.policy ? [row.policy] : []);
    const projected = pool.map(policy => ({ ...policy, status: (policy.status === 'CANCELLED' ? 'CANCELLED'
      : expiryNowMs >= Date.parse(policy.ends_at) ? 'EXPIRED'
        : serverNowMs < Date.parse(policy.starts_at) ? 'SCHEDULED' : 'ACTIVE') as SaleRoomPolicy['status'] }));
    const policy = projected.find(item => item.status === 'ACTIVE')
      ?? projected.filter(item => item.status === 'SCHEDULED').sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))[0]
      ?? row.policy;
    if (!policy) return row;
    const starts = Date.parse(policy.starts_at); const ends = Date.parse(policy.ends_at);
    const cancelled = policy.status === 'CANCELLED';
    for (const candidate of pool) if (candidate.status !== 'CANCELLED') {
      const start = Date.parse(candidate.starts_at), end = Date.parse(candidate.ends_at);
      if (start > serverNowMs) nextBoundary = Math.min(nextBoundary, start);
      if (end > expiryNowMs) nextBoundary = Math.min(nextBoundary, end);
    }
    const activePolicyText = salePolicyIsActive(policy, serverNowMs) && expiryNowMs < ends ? policy.content : null;
    const status: SaleRoomPolicy['status'] = cancelled ? 'CANCELLED' : expiryNowMs >= ends ? 'EXPIRED' : serverNowMs < starts ? 'SCHEDULED' : 'ACTIVE';
    return { ...row, policy: { ...policy, status },
      policies: row.policies === undefined ? undefined : projected.filter(item => item.status === 'ACTIVE' || item.status === 'SCHEDULED'), activePolicyText,
      room: { ...row.room, saleNote: [row.saleNote?.trim(), activePolicyText].filter(Boolean).join('\n') || null } };
  });
  const byId = new Map(rooms.map(row => [row.room.id, row.room]));
  return { ...data, rooms, nextPolicyBoundaryAt: Number.isFinite(nextBoundary) ? new Date(nextBoundary).toISOString() : null,
    buildings: data.buildings.map(building => ({ ...building,
      rooms: building.rooms.map(room => byId.get(room.id) ?? room),
      floors: building.floors.map(floor => ({ ...floor, rooms: floor.rooms.map(room => byId.get(room.id) ?? room) })),
    })),
  };
}

/** Lower bound avoids showing a scheduled offer early; upper bound prevents a
 * slow read from prolonging it. The server still decides every write. */
export function saleInventoryClock(data: SaleRoomInventory, monotonicNowMs = performance.now()) {
  const elapsed = data.readTiming ? Math.max(0, monotonicNowMs - data.readTiming.receivedMonotonicMs) : 0;
  const lowerBoundMs = Date.parse(data.serverNow) + elapsed;
  return { lowerBoundMs, upperBoundMs: lowerBoundMs + (data.readTiming?.requestDurationMs ?? 0) };
}

export function saleInventoryBoundaryDelay(data: SaleRoomInventory, lowerBoundMs: number, upperBoundMs: number): number | null {
  const delays = data.rooms.flatMap(row => (row.policies ?? (row.policy ? [row.policy] : []))
    .flatMap(policy => policy.status !== 'CANCELLED'
      ? [Date.parse(policy.starts_at) - lowerBoundMs, Date.parse(policy.ends_at) - upperBoundMs] : [])).filter(delay => delay > 0);
  return delays.length ? Math.min(...delays) : null;
}

export function buildSaleRoomPatchArgs(organizationId: string, input: PatchSaleRoomInput) {
  const parsed = z.object({
    roomId: uuid, requestId: uuid, expectedRevision: revision, patch: saleRoomPatchSchema,
  }).strict().parse(input);
  return {
    p_organization_id: uuid.parse(organizationId), p_room_id: parsed.roomId,
    p_expected_revision: parsed.expectedRevision, p_request_id: parsed.requestId,
    p_patch: parsed.patch,
  };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b))
      .map(([key,v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}
export function saleRoomWriteError(error: unknown): SaleRoomOperationError {
  if (error instanceof SaleRoomOperationError) return error;
  const code = z.object({ code: z.string().optional() }).safeParse(error);
  const tag = code.success ? code.data.code : undefined;
  if (tag === 'PT409' || tag === '40001') {
    return new SaleRoomOperationError('Thông tin phòng đã thay đổi. Tải lại để đối chiếu; bản nháp vẫn được giữ.', 'conflict', tag);
  }
  if (tag === '42501' || tag === 'PGRST301' || tag === 'PGRST302') {
    return new SaleRoomOperationError('Bạn không còn quyền thực hiện thay đổi này ở tòa đã chọn.', 'rejected', tag);
  }
  if (tag === '22023' || tag === '22003' || tag === '23514' || tag === '23502' || tag === '22P02') {
    return new SaleRoomOperationError('Nội dung cập nhật không hợp lệ. Kiểm tra giá, diện tích, ảnh và các trường đã nhập.', 'rejected', tag);
  }
  return new SaleRoomOperationError(
    'Chưa xác nhận được lần lưu. Giữ nguyên yêu cầu và đối chiếu trước khi thực hiện lại.', 'unknown', tag,
  );
}
export async function patchSaleRoom(rpc: SaleRoomRpcInvoker, organizationId: string, input: PatchSaleRoomInput): Promise<SaleRoomPatchReceipt> {
  let args: ReturnType<typeof buildSaleRoomPatchArgs>;
  try {
    args = buildSaleRoomPatchArgs(organizationId, input);
  } catch {
    throw new SaleRoomOperationError('Nội dung cập nhật không hợp lệ. Kiểm tra các trường đã nhập.', 'rejected', '22023');
  }
  try {
    const result = await rpc('update_room_sale_info_v1', args);
    if (result.error) throw result.error;
    const receipt = saleRoomPatchReceiptSchema.safeParse(result.data);
    if (!receipt.success || receipt.data.room_id !== input.roomId || receipt.data.request_id !== input.requestId
      || canonical(receipt.data.fields) !== canonical(args.p_patch)) {
      throw new SaleRoomOperationError('Phản hồi lưu chưa xác nhận đúng phòng và nội dung. Đối chiếu lại lần lưu này.', 'unknown');
    }
    return receipt.data;
  } catch (error) {
    throw saleRoomWriteError(error);
  }
}
