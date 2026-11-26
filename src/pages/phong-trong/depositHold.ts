// Phòng đang giữ bằng cọc chờ hợp đồng (Sale phòng đợt 3, lỗi 21 audit 24/11/2026). Máy chủ (migration
// 20261125165113_coc_thu_chi_chan_0d_va_khoi_da_coc_tren_dot_giu_cho, app_private.room_deposit_hold_json_v1) gắn khoá
// `deposit_hold` vào phòng 'rented' của get_sale_room_inventory_v1 và get_my_available_rooms: đợt giữ chỗ đang mở của
// #499 (người gửi phiếu đầu, ngày nhận phiếu đầu, các mã phiếu), hoặc phiếu cọc treo chưa nối đợt (dữ liệu cũ). Link công
// khai, bot Zalo, Hermes không có khoá này (không lộ tên người cọc). Người xem không có deposits.view ở toà thì máy chủ bỏ
// người gửi / mã phiếu / id (detail = false). Ở đây chỉ kiểm dạng dữ liệu và trình bày; các dòng này chỉ cho bảng Sale nội bộ,
// không vào saleFact.label (nhãn công khai của tin chia sẻ).
import { z } from 'zod';
import { DEPOSIT_HOLD_STALE_DAYS } from '@/lib/roomSaleFacts';
import type { Room, RoomDepositHoldInfo } from './sampleData';

const uuid = z.string().guid();
const depositHoldSchema = z.object({
  source: z.enum(['hold', 'voucher']),
  hold_id: uuid.nullable(),
  voucher_id: uuid.nullable(),
  code: z.string().nullable().optional(),
  codes: z.array(z.string()),
  voucher_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  payer_name: z.string().nullable().optional(),
  held_days: z.number().int().nonnegative(),
  voucher_count: z.number().int().nonnegative(),
  room_occupied: z.boolean(),
  detail: z.boolean().optional(),
}).refine((hold) => hold.detail === false
  ? hold.payer_name == null && hold.code == null && hold.codes.length === 0 && (hold.source === 'hold' || hold.voucher_count > 0)
  : hold.source === 'hold' ? hold.hold_id !== null : hold.voucher_id !== null && hold.voucher_count > 0);

/** Lệch dạng thì coi như không có khối: một khoá phụ sai không được làm vỡ cả danh sách phòng. */
export function parseRoomDepositHold(value: unknown): RoomDepositHoldInfo | null {
  if (value === null || value === undefined) return null;
  const parsed = depositHoldSchema.safeParse(value);
  if (!parsed.success) return null;
  const hold = parsed.data;
  return {
    source: hold.source,
    holdId: hold.hold_id,
    voucherId: hold.voucher_id,
    code: hold.code?.trim() || null,
    codes: hold.codes.map((code) => code.trim()).filter(Boolean),
    voucherDate: hold.voucher_date,
    payerName: hold.payer_name?.trim() || null,
    heldDays: hold.held_days,
    voucherCount: hold.voucher_count,
    roomOccupied: hold.room_occupied,
    detail: hold.detail !== false,
  };
}

export function hasPrecontractDeposit(room: Pick<Room, 'depositHold' | 'hasDepositHold'>): boolean {
  return room.hasDepositHold === true || (room.depositHold?.source === 'voucher' && !room.depositHold.roomOccupied);
}

/** Phòng bị che 'rented' vì đang giữ bằng cọc: có khối, hoặc chỉ có cờ has_deposit_hold của #499 (máy chủ cũ). */
export function isDepositHeld(room: Pick<Room, 'status' | 'depositHold' | 'hasDepositHold'>): boolean {
  return room.status === 'rented' && (!!room.depositHold || room.hasDepositHold === true);
}

/** Quá 14 ngày chưa có hợp đồng: tô cảnh báo để dọn phiếu treo (không tự gỡ giữ phòng vì tiền đã thu). */
export function depositHoldStale(hold: Pick<RoomDepositHoldInfo, 'heldDays'>): boolean {
  return hold.heldDays > DEPOSIT_HOLD_STALE_DAYS;
}

function dayLabel(day: string): string {
  return `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;
}

/** Dòng chi tiết đi kèm nhãn «Đã cọc · …»: các mã phiếu + ngày nhận phiếu đầu, phiếu treo ngoài đợt, cảnh báo quá hạn. */
export function depositHoldLines(hold: RoomDepositHoldInfo): string[] {
  const day = dayLabel(hold.voucherDate);
  if (hold.source === 'voucher') {
    const codes = hold.codes.length ? hold.codes : [hold.code].filter(Boolean);
    const label = hold.detail && codes.length ? `Phiếu ${codes.join(', ')}` : `${hold.voucherCount} phiếu cọc`;
    const lines = [`${label} · nhận ${day} · chờ đối chiếu lượt thuê`];
    if (depositHoldStale(hold)) lines.push(`Phiếu đã thu quá ${DEPOSIT_HOLD_STALE_DAYS} ngày, cần đối chiếu lượt thuê.`);
    return lines;
  }
  const first = !hold.detail
    ? hold.voucherCount > 0 ? `${hold.voucherCount} phiếu cọc · nhận đầu ${day}` : `Đợt giữ chỗ từ ${day} · chưa có phiếu thu`
    : hold.codes.length > 0
      ? `Phiếu ${hold.codes.join(', ')} · nhận đầu ${day}`
      : hold.source === 'hold' ? `Đợt giữ chỗ từ ${day} · chưa có phiếu thu` : `Phiếu ${hold.code ?? 'chưa có mã'} · lập ${day}`;
  // Không có quyền xem phiếu cọc thì tên bị ẩn chứ không phải thiếu: không nhắc «chưa ghi người gửi».
  const lines = [hold.payerName || !hold.detail ? first : `${first} · chưa ghi người gửi`];
  // Đợt giữ chỗ gom nhiều lần thu là bình thường; phiếu treo NGOÀI đợt thì nhiều phiếu là dấu hiệu cần dọn.
  if (depositHoldStale(hold)) lines.push(`Quá ${DEPOSIT_HOLD_STALE_DAYS} ngày chưa có hợp đồng — kiểm lại phiếu cọc`);
  return lines;
}
