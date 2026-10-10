/* ===== Bản nháp bảng "DANH SÁCH PHÒNG TRỐNG" ở Cài đặt hiển thị =====
 * PURE: áp các ô đang gõ (hotline, chính sách chung, SĐT riêng tòa, chính sách
 * riêng phòng, giá, loại phòng, nội thất, tình trạng) lên Building[] rồi đưa qua
 * ĐÚNG buildRoomListTable của ảnh — nhờ vậy khung nhập (desktop lẫn mobile) và
 * ảnh tải về không thể lệch nhau.
 */
import { amenitiesCell, fmtVndFull, samePhone, typeCell } from "@/pages/phong-trong/roomListTable";
import type { Building, Room } from "@/pages/phong-trong/sampleData";

export interface HotlineOption {
  id: string;
  name?: string | null;
  phone_number: string | null;
  is_active?: boolean | null;
  created_at?: string | null;
}

/** Ô của phòng (ngoài chính sách) sửa và lưu thẳng vào phòng. */
export type RoomField = "price" | "type" | "amenities" | "status";

/** Ô đang gõ, theo id. Chưa có khoá = giữ giá trị đang lưu. */
export interface SheetEdits {
  phones: Record<string, string>;
  policies: Record<string, string>;
  /** Giá đầy đủ VND như ảnh in ("4.500.000") → rooms.rent_price. */
  prices: Record<string, string>;
  /** Cả ô LOẠI PHÒNG ("Phòng 20m², Ban công"): phần "Nm²" → rooms.area, còn lại → rooms.room_type. */
  types: Record<string, string>;
  /** Ô NỘI THẤT, phân cách dấu phẩy → rooms.amenities (string[]). Chưa khai thì ảnh in mô tả phòng. */
  amenities: Record<string, string>;
  /** TÌNH TRẠNG gõ tay → rooms.sale_status_note (+ khoá tình trạng tự tính lúc gõ); rỗng = tự tính. */
  statuses: Record<string, string>;
}

export const EMPTY_SHEET_EDITS: SheetEdits = { phones: {}, policies: {}, prices: {}, types: {}, amenities: {}, statuses: {} };
export const ROOM_POLICY_MAX = 300;
export const ROOM_TYPE_MAX = 120;
export const ROOM_AMENITIES_MAX = 300;
/** Khớp CHECK rooms_sale_status_note_len. */
export const ROOM_STATUS_MAX = 120;
const PRICE_DIGITS_MAX = 10;

const FIELD_EDITS: Record<RoomField, Exclude<keyof SheetEdits, "phones" | "policies">> = {
  price: "prices", type: "types", amenities: "amenities", status: "statuses",
};

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

/** Phòng khách pass: giá là giá khách đặt ở tin pass, không phải giá phòng. */
export const priceEditable = (r: Room) => r.status !== "pass";

/** Chữ ô đang LƯU: giá/loại phòng đúng chữ ảnh in; nội thất là tiện nghi đã khai; tình trạng là chữ gõ tay còn hiệu lực. */
export function savedRoomCell(r: Room, field: RoomField): string {
  switch (field) {
    case "price": return fmtVndFull(r.price);
    case "type": return typeCell(r);
    case "amenities": return r.amenities.filter(Boolean).join(", ");
    case "status": return r.saleStatusNote?.trim() ?? "";
  }
}

/** Ô nội thất trống thì ảnh in mô tả phòng — hiện làm gợi ý, không chép vào ô (để không thành tiện nghi). */
export function amenitiesFallback(r: Room): string {
  return r.amenities.some(Boolean) ? "" : amenitiesCell(r);
}

/** Giá trị ô đang hiện: bản đang gõ, chưa gõ thì chữ đang lưu. */
export function roomCellValue(r: Room, field: RoomField, edits: SheetEdits): string {
  return edits[FIELD_EDITS[field]][r.id] ?? savedRoomCell(r, field);
}

/** Ghi một ô phòng vào bản nháp (bất biến). */
export function withRoomField(edits: SheetEdits, field: RoomField, roomId: string, value: string): SheetEdits {
  const key = FIELD_EDITS[field];
  return { ...edits, [key]: { ...edits[key], [roomId]: value } };
}

const digits = (s: string) => s.replace(/\D/g, "");

/** Ô giá khi gõ: chỉ giữ chữ số, chấm nghìn kiểu Việt ("4500000" → "4.500.000"). */
export function formatPriceInput(raw: string): string {
  const d = digits(raw).replace(/^0+(?=\d)/, "").slice(0, PRICE_DIGITS_MAX);
  return d ? Number(d).toLocaleString("vi-VN") : "";
}

// Đúng khuôn ảnh in: "Phòng 20m²" / "phòng 20,5 m2". Số m² đứng riêng ("Gác 6m2") là chữ của loại phòng.
const AREA_RE = /phòng\s*(\d{1,4}(?:[.,]\d{1,2})?)\s*m(?:²|2)(?![\p{L}\d])/iu;

/** Ô LOẠI PHÒNG → diện tích (khi có "Phòng Nm²", không có thì null = giữ nguyên) + loại phòng (phần còn lại). */
export function parseTypeCell(text: string): { area: number | null; roomType: string } {
  const m = AREA_RE.exec(text);
  const rest = m ? `${text.slice(0, m.index)},${text.slice(m.index + m[0].length)}` : text;
  const roomType = rest.split(/[,;\n]/).map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean).join(", ");
  const area = m?.[1] ? Number(m[1].replace(",", ".")) : NaN;
  return { area: area > 0 ? area : null, roomType };
}

/** Ô NỘI THẤT → danh sách tiện nghi (phân cách phẩy/chấm phẩy/xuống dòng). */
export function parseAmenities(text: string): string[] {
  return text.split(/[,;\n]/).map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
}

/** Phòng như thể các ô đang gõ đã được lưu. */
function applyRoomEdits(r: Room, edits: SheetEdits): Room {
  const policy = edits.policies[r.id];
  const price = edits.prices[r.id];
  const type = edits.types[r.id];
  const amen = edits.amenities[r.id];
  const status = edits.statuses[r.id];
  if ([policy, price, type, amen, status].every((v) => v === undefined)) return r;
  const next: Room = { ...r };
  if (policy !== undefined) next.saleNote = policy.trim() || null;
  if (price !== undefined && priceEditable(r)) next.price = Number(digits(price) || 0) / 1_000_000;
  if (type !== undefined) {
    const parsed = parseTypeCell(type);
    next.type = parsed.roomType;
    if (parsed.area !== null) next.area = parsed.area;
  }
  // Rỗng → giữ rỗng: ảnh tự lấy mô tả phòng như khi chưa khai nội thất.
  if (amen !== undefined) next.amenities = parseAmenities(amen);
  if (status !== undefined) next.saleStatusNote = status.trim() || null;
  return next;
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
      rooms: b.rooms.map((r) => applyRoomEdits(r, draft.edits)),
    };
  });
}

/** Thay đổi một phòng; chỉ có khoá của cột thật sự đổi. */
export interface RoomChange {
  id: string;
  saleNote?: string | null;
  /** null = ô giá bị xoá trống (sheetErrors chặn). */
  rentPrice?: number | null;
  area?: number;
  roomType?: string | null;
  amenities?: string[] | null;
  saleStatusNote?: string | null;
  /** Khoá tình trạng tự tính lúc gõ (sale_fact_key); luôn đi cùng saleStatusNote. */
  saleStatusKey?: string | null;
}

export interface SheetChanges {
  buildings: { id: string; phone: string | null }[];
  rooms: RoomChange[];
}

/** Chỉ các ô thật sự khác giá trị đang lưu (gõ rồi xoá về như cũ thì không ghi). */
export function sheetChanges(buildings: Building[], edits: SheetEdits): SheetChanges {
  const out: SheetChanges = { buildings: [], rooms: [] };
  for (const b of buildings) {
    const phone = edits.phones[b.id];
    if (phone !== undefined && phone.trim() !== ownPhone(b)) out.buildings.push({ id: b.id, phone: phone.trim() || null });
    for (const r of b.rooms) {
      const change: RoomChange = { id: r.id };
      const policy = edits.policies[r.id];
      if (policy !== undefined && policy.trim() !== (r.saleNote?.trim() ?? "")) change.saleNote = policy.trim() || null;

      const price = edits.prices[r.id];
      if (price !== undefined && priceEditable(r) && digits(price) !== digits(savedRoomCell(r, "price"))) {
        change.rentPrice = digits(price) ? Number(digits(price)) : null;
      }

      const type = edits.types[r.id];
      if (type !== undefined && type.trim() !== savedRoomCell(r, "type")) {
        const parsed = parseTypeCell(type);
        if (parsed.area !== null && parsed.area !== r.area) change.area = parsed.area;
        if (parsed.roomType !== (r.type?.trim() ?? "")) change.roomType = parsed.roomType || null;
      }

      const amen = edits.amenities[r.id];
      if (amen !== undefined) {
        const list = parseAmenities(amen);
        if (list.join(", ") !== savedRoomCell(r, "amenities")) change.amenities = list.length ? list : null;
      }

      const status = edits.statuses[r.id];
      if (status !== undefined && status.trim() !== savedRoomCell(r, "status")) {
        change.saleStatusNote = status.trim() || null;
        change.saleStatusKey = change.saleStatusNote ? r.saleFactKey ?? null : null;
      }

      if (Object.keys(change).length > 1) out.rooms.push(change);
    }
  }
  return out;
}

const PHONE_RE = /^\+?[\d\s().-]{8,20}$/;

/** SĐT gõ tay: chữ số (cho phép +, khoảng trắng, chấm, gạch, ngoặc), 8–20 ký tự, ít nhất 8 chữ số. */
export function isPhone(value: string): boolean {
  return PHONE_RE.test(value) && value.replace(/\D/g, "").length >= 8;
}

/** Lỗi theo khoá ô (`phone:<buildingId>`, `policy|price|type|amenities|status:<roomId>`) — rỗng là hợp lệ. */
export function sheetErrors(changes: SheetChanges): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const b of changes.buildings) {
    if (b.phone && !isPhone(b.phone)) errors[`phone:${b.id}`] = "SĐT chỉ gồm số (8–20 ký tự), để trống nếu dùng hotline.";
  }
  for (const r of changes.rooms) {
    if (r.saleNote && r.saleNote.length > ROOM_POLICY_MAX) errors[`policy:${r.id}`] = `Tối đa ${ROOM_POLICY_MAX} ký tự.`;
    if (r.rentPrice !== undefined && !(r.rentPrice && r.rentPrice > 0)) errors[`price:${r.id}`] = "Nhập giá phòng (VND).";
    if (r.roomType && r.roomType.length > ROOM_TYPE_MAX) errors[`type:${r.id}`] = `Tối đa ${ROOM_TYPE_MAX} ký tự.`;
    if (r.amenities && r.amenities.join(", ").length > ROOM_AMENITIES_MAX) errors[`amenities:${r.id}`] = `Tối đa ${ROOM_AMENITIES_MAX} ký tự.`;
    if (r.saleStatusNote && r.saleStatusNote.length > ROOM_STATUS_MAX) errors[`status:${r.id}`] = `Tối đa ${ROOM_STATUS_MAX} ký tự.`;
  }
  return errors;
}

/** Bỏ các ô đã lưu (khoá `<loại>:<id>`) khỏi bản nháp, giữ ô chưa lưu để người dùng lưu lại. */
export function dropSaved(edits: SheetEdits, saved: string[]): SheetEdits {
  const keys = new Set(saved);
  const keep = (prefix: string, rec: Record<string, string>) =>
    Object.fromEntries(Object.entries(rec).filter(([id]) => !keys.has(`${prefix}:${id}`)));
  return {
    phones: keep("phone", edits.phones),
    policies: keep("policy", edits.policies),
    prices: keep("price", edits.prices),
    types: keep("type", edits.types),
    amenities: keep("amenities", edits.amenities),
    statuses: keep("status", edits.statuses),
  };
}
