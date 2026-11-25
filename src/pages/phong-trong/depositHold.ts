// Phòng đang giữ bằng phiếu cọc chờ hợp đồng (Sale phòng đợt 3, lỗi 21 audit 24/11/2026). Máy chủ (migration
// 20261125094121_coc_thu_chi_chan_0d_va_khoi_dang_giu_bang_coc, app_private.room_deposit_hold_json_v1) gắn khoá
// `deposit_hold` vào phòng 'rented' của get_sale_room_inventory_v1 và get_my_available_rooms; link công khai, bot Zalo,
// Hermes không có khoá này (không lộ tên người cọc). Ở đây chỉ kiểm dạng dữ liệu và trình bày cho nhân viên.
import { z } from 'zod';
import { DEPOSIT_HOLD_STALE_DAYS } from '@/lib/roomSaleFacts';
import type { Room, RoomDepositHoldInfo } from './sampleData';

const depositHoldSchema = z.object({
  voucher_id: z.string().guid(),
  code: z.string().nullable().optional(),
  voucher_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  payer_name: z.string().nullable().optional(),
  held_days: z.number().int().nonnegative(),
  voucher_count: z.number().int().positive(),
  room_occupied: z.boolean(),
});

/** Lệch dạng thì coi như không có khối: một khoá phụ sai không được làm vỡ cả danh sách phòng. */
export function parseRoomDepositHold(value: unknown): RoomDepositHoldInfo | null {
  if (value === null || value === undefined) return null;
  const parsed = depositHoldSchema.safeParse(value);
  if (!parsed.success) return null;
  const hold = parsed.data;
  return {
    voucherId: hold.voucher_id,
    code: hold.code?.trim() || null,
    voucherDate: hold.voucher_date,
    payerName: hold.payer_name?.trim() || null,
    heldDays: hold.held_days,
    voucherCount: hold.voucher_count,
    roomOccupied: hold.room_occupied,
  };
}

/** Phòng bị che 'rented' vì đang giữ bằng phiếu cọc chờ hợp đồng. */
export function isDepositHeld(room: Pick<Room, 'status' | 'depositHold'>): boolean {
  return room.status === 'rented' && !!room.depositHold;
}

/** Quá 14 ngày chưa có hợp đồng: tô cảnh báo để dọn phiếu treo (ký HĐ mới kéo MỌI phiếu cọc chờ của phòng). */
export function depositHoldStale(hold: Pick<RoomDepositHoldInfo, 'heldDays'>): boolean {
  return hold.heldDays > DEPOSIT_HOLD_STALE_DAYS;
}

function dayLabel(day: string): string {
  return `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;
}

/** Dòng chi tiết đi kèm nhãn «Đã cọc · …»: mã phiếu + ngày lập, số phiếu chờ, cảnh báo quá hạn. */
export function depositHoldLines(hold: RoomDepositHoldInfo): string[] {
  const lines = [`Phiếu ${hold.code ?? 'chưa có mã'} · lập ${dayLabel(hold.voucherDate)}${hold.payerName ? '' : ' · chưa ghi người nộp'}`];
  if (hold.voucherCount > 1) lines.push(`Phòng có ${hold.voucherCount} phiếu cọc chờ hợp đồng — kiểm trước khi ký hợp đồng mới`);
  if (depositHoldStale(hold)) lines.push(`Quá ${DEPOSIT_HOLD_STALE_DAYS} ngày chưa có hợp đồng — kiểm lại phiếu cọc`);
  return lines;
}
