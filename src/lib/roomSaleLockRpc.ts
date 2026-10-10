import { z } from 'zod';
import type { Json } from '@/integrations/supabase/types';
import { friendlyError } from './friendlyError';

/**
 * Lock tạm phòng khỏi danh sách sale (chủ chốt 10/10/2026): không khách, không tiền,
 * không phiếu; 6/12/24 giờ rồi tự nhả. Migration 20261010114500_giu_cho_ten_goi_nho_va_lock_tam_phong.
 */
export const SALE_LOCK_HOURS = [6, 12, 24] as const;
export type SaleLockHours = (typeof SALE_LOCK_HOURS)[number];
export const SALE_LOCK_NOTE_MAX = 300;

const uuid = z.string().uuid();
export const roomSaleLockSchema = z.object({
  id: uuid, organization_id: uuid, building_id: uuid, building_name: z.string(),
  room_id: uuid, room_name: z.string(), room_code: z.string().nullable(),
  hours: z.union([z.literal(6), z.literal(12), z.literal(24)]), note: z.string().nullable(),
  locked_by: uuid, locked_by_name: z.string(), locked_at: z.string(), expires_at: z.string(),
  released_at: z.string().nullable(), release_reason: z.enum(['MANUAL', 'RESERVED', 'EXPIRED']).nullable(),
  reservation_id: uuid.nullable(), active: z.boolean(),
});
export type RoomSaleLock = z.infer<typeof roomSaleLockSchema>;
export const roomSaleLockListSchema = z.object({ server_now: z.string(), locks: z.array(roomSaleLockSchema) });
export type RoomSaleLockList = z.infer<typeof roomSaleLockListSchema>;

export type SaleLockRpcName = 'lock_room_for_sale_v1' | 'release_room_sale_lock_v1' | 'list_room_sale_locks_v1';
export type SaleLockRpcInvoker = (name: SaleLockRpcName, args: Record<string, Json>) =>
  PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;

export interface LockRoomInput { roomId: string; hours: SaleLockHours; note?: string | null }

export function buildLockRoomArgs(organizationId: string, input: LockRoomInput) {
  const v = z.object({
    roomId: uuid,
    hours: z.union([z.literal(6), z.literal(12), z.literal(24)]),
    note: z.string().trim().max(SALE_LOCK_NOTE_MAX, `Ghi chú tối đa ${SALE_LOCK_NOTE_MAX} ký tự`).nullable().optional(),
  }).strict().parse(input);
  return { p_organization_id: uuid.parse(organizationId), p_room_id: v.roomId, p_hours: v.hours, p_note: v.note || null };
}

async function call(rpc: SaleLockRpcInvoker, name: SaleLockRpcName, args: Record<string, Json>) {
  const r = await rpc(name, args);
  if (r.error) throw r.error;
  return r.data;
}
export async function lockRoomForSale(rpc: SaleLockRpcInvoker, organizationId: string, input: LockRoomInput): Promise<RoomSaleLock> {
  const parsed = roomSaleLockSchema.safeParse(await call(rpc, 'lock_room_for_sale_v1', buildLockRoomArgs(organizationId, input)));
  if (!parsed.success) throw new TypeError('Chưa xác nhận được lock tạm đã lưu');
  return parsed.data;
}
export async function releaseRoomSaleLock(rpc: SaleLockRpcInvoker, organizationId: string, lockId: string): Promise<RoomSaleLock> {
  const parsed = roomSaleLockSchema.safeParse(await call(rpc, 'release_room_sale_lock_v1',
    { p_organization_id: uuid.parse(organizationId), p_lock_id: uuid.parse(lockId) }));
  if (!parsed.success) throw new TypeError('Chưa xác nhận được việc gỡ lock');
  return parsed.data;
}
export async function listRoomSaleLocks(rpc: SaleLockRpcInvoker, organizationId: string): Promise<RoomSaleLockList> {
  return roomSaleLockListSchema.parse(await call(rpc, 'list_room_sale_locks_v1', { p_organization_id: uuid.parse(organizationId) }));
}

// Lý do đã kiểm trong migration 20261010114500.
const lockReasons = [
  'Chỉ lock tạm 6, 12 hoặc 24 giờ', `Ghi chú lock tạm tối đa ${SALE_LOCK_NOTE_MAX} ký tự`, 'Không tìm thấy phòng trong tổ chức',
  'Không có quyền lock tạm phòng ở tòa này', 'Phòng đang được lock tạm. Tải lại danh sách.',
  'Phòng không còn trên danh sách bán (đã cọc, đang giữ chỗ hoặc đang có khách ở)', 'Không tìm thấy lock tạm trong tổ chức',
  'Chỉ người đã lock hoặc người được tạo cọc ở tòa này mới gỡ được lock',
];
export function saleLockErrorMessage(error: unknown): string {
  return friendlyError(error, 'Chưa lưu được lock tạm', {
    operation: 'lock tạm phòng',
    rules: lockReasons.map((message) => ({ message, description: message })),
  }).description;
}

/** Thời gian còn lại, làm tròn lên: "còn 18 giờ", "còn 40 phút", "hết hạn". */
export function saleLockRemaining(expiresAt: string, now: number = Date.now()): string {
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return 'hết hạn';
  const minutes = Math.ceil(ms / 60_000);
  return minutes < 60 ? `còn ${minutes} phút` : `còn ${Math.ceil(minutes / 60)} giờ`;
}
