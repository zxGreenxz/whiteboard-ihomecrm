// Phòng đang giữ cho khách nhận sang nhượng (trả phòng trước hạn "Nhờ sale / Tự tìm khách sang phòng").
// Máy chủ (migration 20261124075933_tra_phong_truoc_han_ba_truong_hop, app_private.room_exit_hold_json_v1) gắn
// khoá `exit_hold` vào mỗi phòng của get_my_available_rooms() và get_sale_room_inventory_v1(); link công khai
// không có khoá này. Còn hạn giữ thì phòng vẫn là status_public='rented' (như Lock tạm, không có giá trị trạng
// thái mới); ở đây chỉ kiểm dạng dữ liệu và trình bày cho nhân viên.
import { z } from 'zod';
import { EARLY_REASON_LABELS } from '@/lib/contractExitEarlyTerms';
import type { RoomSaleFact } from '@/lib/roomSaleFacts';
import type { Room, RoomExitHoldInfo } from './sampleData';

export const EXIT_HOLD_STATUS_LABEL = 'Chờ khách Sang/Nhượng phòng';
/** Nhãn tình trạng của phòng đang giữ — thay "Đã thuê / giữ chỗ" chung khi máy chủ che phòng vì giữ. */
export const EXIT_HOLD_SALE_FACT: RoomSaleFact = { kind: 'rented', label: EXIT_HOLD_STATUS_LABEL, availableOn: null };
export const EXIT_HOLD_DAY_OPTIONS = [1, 2, 3, 4, 5, 6, 7] as const;
export const EXIT_HOLD_DEFAULT_DAYS = 3;

const optionalText = z.string().nullable().optional();
const exitHoldSchema = z.object({
  exit_case_id: z.string().guid(),
  version: z.number().int().positive(),
  early_reason: z.enum(['SALE_ASSISTED', 'SELF_FOUND']),
  sale_name: optionalText,
  old_customer_name: optionalText,
  old_contract_number: optionalText,
  actual_move_out_on: z.string(),
  recorded_by_name: z.string(),
  recorded_by_me: z.boolean().nullable().optional(),
  hold_until: z.string().datetime({ offset: true }),
  active: z.boolean(),
  can_manage: z.boolean(),
});

/**
 * Lệch dạng thì coi như phòng không có hồ sơ giữ: một khoá phụ sai không được làm vỡ cả danh sách phòng,
 * và không bao giờ hiện nút Mở bán lại / Giữ tiếp với mã hồ sơ hay phiên bản không dùng được.
 */
export function parseRoomExitHold(value: unknown): RoomExitHoldInfo | null {
  if (value === null || value === undefined) return null;
  const parsed = exitHoldSchema.safeParse(value);
  if (!parsed.success) return null;
  const hold = parsed.data;
  return {
    exitCaseId: hold.exit_case_id,
    version: hold.version,
    earlyReason: hold.early_reason,
    saleName: hold.sale_name?.trim() || null,
    oldCustomerName: hold.old_customer_name?.trim() || null,
    oldContractNumber: hold.old_contract_number?.trim() || null,
    actualMoveOutOn: hold.actual_move_out_on,
    recordedByName: hold.recorded_by_name.trim() || 'Người dùng',
    recordedByMe: hold.recorded_by_me === true,
    holdUntil: hold.hold_until,
    active: hold.active,
    canManage: hold.can_manage,
  };
}

/** Phòng bị che "rented" chỉ vì đang giữ cho khách nhận sang nhượng (nhân viên vẫn xem, cọc được). */
export function isExitHeld(room: Pick<Room, 'status' | 'exitHold'>): boolean {
  return room.status === 'rented' && room.exitHold?.active === true;
}

const VN_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', hourCycle: 'h23',
});
/** "2026-11-27T03:05:00Z" → "10:05 27/11" theo giờ Việt Nam (cùng dạng giờ hết hạn Lock tạm). */
export function exitHoldUntilLabel(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return 'chưa rõ hạn';
  const part = (type: Intl.DateTimeFormatPartTypes) => VN_TIME.formatToParts(new Date(time)).find(p => p.type === type)?.value ?? '';
  return `${part('hour')}:${part('minute')} ${part('day')}/${part('month')}`;
}

export function exitHoldCaseLabel(hold: Pick<RoomExitHoldInfo, 'earlyReason' | 'saleName'>): string {
  const label = EARLY_REASON_LABELS[hold.earlyReason];
  return hold.earlyReason === 'SALE_ASSISTED' && hold.saleName ? `${label} · sale ${hold.saleName}` : label;
}

/** Số HĐ đã có tiền tố riêng (vd "HD-2026-00451") nên không ghép thêm chữ "HĐ" phía trước. */
export function exitHoldOldContractLabel(hold: Pick<RoomExitHoldInfo, 'oldCustomerName' | 'oldContractNumber'>): string {
  return `${hold.oldCustomerName ?? 'Khách cũ chưa có tên'} (${hold.oldContractNumber ?? 'chưa có số HĐ'})`;
}

/**
 * Dòng thông tin đi kèm nhãn tình trạng. Còn hạn: khách cũ (tên + số HĐ), trường hợp (kèm tên sale), người ghi và
 * hạn giữ. Hết hạn: dòng "Hết hạn giữ…" rồi giờ hết hạn — phòng đang rao như phòng trống.
 */
export function exitHoldLines(hold: RoomExitHoldInfo): string[] {
  const until = exitHoldUntilLabel(hold.holdUntil);
  if (!hold.active) {
    return [
      `Hết hạn giữ cho khách sang nhượng (HĐ cũ ${hold.oldContractNumber ?? 'chưa có số'}${hold.oldCustomerName ? ` · ${hold.oldCustomerName}` : ''})`,
      `Hết hạn lúc ${until} · phòng đang rao lại, hồ sơ vẫn chờ hợp đồng khách nhận`,
    ];
  }
  return [
    `Khách cũ: ${exitHoldOldContractLabel(hold)}`,
    exitHoldCaseLabel(hold),
    `Người ghi: ${hold.recordedByMe ? 'bạn' : hold.recordedByName} · giữ đến ${until}`,
  ];
}

/** Hộp thoại Mở bán lại / Giữ tiếp đang mở: hồ sơ hiện tại phải vẫn là hồ sơ đã chọn và còn quyền xử lý. */
export function exitHoldActionBlockedReason(selected: RoomExitHoldInfo, current: RoomExitHoldInfo | null | undefined): string | undefined {
  if (!current || current.exitCaseId !== selected.exitCaseId) {
    return 'Hồ sơ giữ phòng đã thay đổi hoặc đã được xử lý ở nơi khác. Đóng hộp thoại và kiểm tra lại phòng.';
  }
  if (!current.canManage) return 'Bạn không còn quyền xử lý hồ sơ trả phòng ở toà này (cần quyền thanh lý hợp đồng).';
  return undefined;
}
