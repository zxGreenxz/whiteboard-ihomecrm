/* ===== Bản nháp bảng "DANH SÁCH PHÒNG TRỐNG" ở Cài đặt hiển thị =====
 * PURE: áp các ô đang gõ (hotline, chính sách chung, SĐT riêng tòa, chính sách
 * riêng phòng) lên Building[] rồi đưa qua ĐÚNG buildRoomListTable của ảnh —
 * nhờ vậy khung nhập và ảnh tải về không thể lệch nhau.
 */
import { samePhone } from "@/pages/phong-trong/roomListTable";
import type { Building } from "@/pages/phong-trong/sampleData";

export interface HotlineOption {
  id: string;
  name?: string | null;
  phone_number: string | null;
  is_active?: boolean | null;
  created_at?: string | null;
}

/** Ô đang gõ, theo id. Chưa có khoá = giữ giá trị đang lưu. */
export interface SheetEdits {
  phones: Record<string, string>;
  policies: Record<string, string>;
}

export const EMPTY_SHEET_EDITS: SheetEdits = { phones: {}, policies: {} };
export const ROOM_POLICY_MAX = 300;

/**
 * Hotline trang công khai sẽ in — khớp contact_j của RPC phòng trống: đã chọn
 * thì chỉ đúng số đó (còn bật); để mặc định thì số đang bật tạo sớm nhất.
 */
export function effectiveHotline(list: HotlineOption[], hotlineId: string | null): HotlineOption | undefined {
  const active = list.filter((h) => h.is_active !== false);
  if (hotlineId) return active.find((h) => h.id === hotlineId);
  return [...active].sort((a, z) => String(a.created_at ?? "").localeCompare(String(z.created_at ?? "")))[0];
}

/**
 * SĐT riêng đang LƯU của tòa (public_contact_phone). Dữ liệu cũ không có trường
 * này thì suy từ phone: trùng hotline coi như chưa khai.
 */
export function ownPhone(b: Building): string {
  if (b.contactPhone !== undefined) return b.contactPhone.trim();
  const phone = b.phone?.trim() ?? "";
  return phone && !samePhone(phone, b.hotline) ? phone : "";
}

/** Building[] như thể các ô đang gõ đã được lưu — dùng cho khung nhập và ảnh thử. */
export function applySheetDraft(
  buildings: Building[],
  draft: { hotline: string; salePolicy: string; edits: SheetEdits },
): Building[] {
  return buildings.map((b) => {
    const own = (draft.edits.phones[b.id] ?? ownPhone(b)).trim();
    return {
      ...b,
      hotline: draft.hotline,
      salePolicy: draft.salePolicy,
      phone: own || draft.hotline,
      rooms: b.rooms.map((r) => {
        const policy = draft.edits.policies[r.id];
        return policy === undefined ? r : { ...r, saleNote: policy.trim() || null };
      }),
    };
  });
}

export interface SheetChanges {
  buildings: { id: string; phone: string | null }[];
  rooms: { id: string; saleNote: string | null }[];
}

/** Chỉ các ô thật sự khác giá trị đang lưu (gõ rồi xoá về như cũ thì không ghi). */
export function sheetChanges(buildings: Building[], edits: SheetEdits): SheetChanges {
  const out: SheetChanges = { buildings: [], rooms: [] };
  for (const b of buildings) {
    const phone = edits.phones[b.id];
    if (phone !== undefined && phone.trim() !== ownPhone(b)) out.buildings.push({ id: b.id, phone: phone.trim() || null });
    for (const r of b.rooms) {
      const policy = edits.policies[r.id];
      if (policy !== undefined && policy.trim() !== (r.saleNote?.trim() ?? "")) {
        out.rooms.push({ id: r.id, saleNote: policy.trim() || null });
      }
    }
  }
  return out;
}

const PHONE_RE = /^\+?[\d\s().-]{8,20}$/;

/** SĐT gõ tay: chữ số (cho phép +, khoảng trắng, chấm, gạch, ngoặc), 8–20 ký tự, ít nhất 8 chữ số. */
export function isPhone(value: string): boolean {
  return PHONE_RE.test(value) && value.replace(/\D/g, "").length >= 8;
}

/** Lỗi theo khoá ô (`phone:<buildingId>` / `policy:<roomId>`) — rỗng là hợp lệ. */
export function sheetErrors(changes: SheetChanges): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const b of changes.buildings) {
    if (b.phone && !isPhone(b.phone)) errors[`phone:${b.id}`] = "SĐT chỉ gồm số (8–20 ký tự), để trống nếu dùng hotline.";
  }
  for (const r of changes.rooms) {
    if (r.saleNote && r.saleNote.length > ROOM_POLICY_MAX) errors[`policy:${r.id}`] = `Tối đa ${ROOM_POLICY_MAX} ký tự.`;
  }
  return errors;
}
