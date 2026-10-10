/**
 * Adapter: map payload RPC public `get_public_available_rooms(p_token)` -> type
 * Building/Room cho cả public và in-app. Reader quyết định occupancy/hold;
 * adapter chỉ trình bày facts ngày máy chủ, báo trả và chuẩn bị phòng.
 */
import { supabase } from "@/integrations/supabase/client";
import { z } from 'zod';
import { roomSaleFacts } from '@/lib/roomSaleFacts';
import {
  layoutFloor,
  type Building,
  type Room,
  type RoomStatus,
} from "./sampleData";
import { applyStoredLayout, type StoredFloorLayout } from "./floorLayoutShared";

/** Bucket Storage PUBLIC cho ảnh sale (phòng + tòa). Ảnh thường lưu dạng URL đầy đủ
 *  (imageUrl pass-through); bucket dùng khi giá trị là storage PATH. */
const IMAGES_BUCKET = "room-sale-images";

/* ---- Shape payload (khớp RPC get_public_available_rooms) ---- */
export interface RpcBuilding {
  id: string;
  name: string;
  code: string | null;
  area_ids?: string[] | null;   // các khu chứa toà (N-N) — tên tra từ payload.areas
  district: string | null;      // "Quận …" — dùng cho bộ lọc Quận ở header
  ward: string | null;
  address: string | null;       // RPC đã ghép địa chỉ đầy đủ
  total_floors: number | null;
  floor_layouts?: Record<string, StoredFloorLayout> | null; // sơ đồ tọa độ thủ công
  images?: unknown;             // jsonb: ảnh tòa (URL/path) | []
  public_contact_name?: string | null;   // liên hệ QL riêng tòa (gọi/Zalo)
  public_contact_phone?: string | null;
  public_map_url?: string | null;        // link Google Maps "Chỉ đường" riêng tòa
  elec_rate?: number | null;             // điện mặc định của tòa (đ/số) — RPC tính từ building_services
  public_lift_type?: string | null;      // "Thang máy" | "Thang bộ"
}
export interface RpcRoom {
  id: string;
  building_id: string;
  floor: number;
  name: string;                 // số phòng dạng chuỗi ("501")
  code: string | null;          // mã phòng (thường null) -> fallback name
  area: number | null;          // m²
  rent_price: number | null;    // VND
  deposit_amount?: number | null;
  max_occupants: number | null;
  amenities: unknown;           // jsonb: string[] | {k:bool} | []
  images: unknown;              // jsonb: string[] (storage path hoặc URL) | []
  description: string | null;
  sale_note?: string | null;        // ô "Khuyến mãi" (promo riêng phòng, gửi khách được)
  sale_bonus_note?: string | null;  // ô "Thưởng sale" (nội bộ — KHÔNG gửi khách)
  room_type?: string | null;    // "Loại phòng" (Gác, Cửa kính, Ban công, Studio…)
  status_public: RoomStatus;    // 'free' | 'soon' | 'rented' | 'pass' (RPC tính sẵn)
  avail_date: string | null;    // 'YYYY-MM-DD' cho phòng 'soon'
  sale_state?: string | null;
  sale_today?: string | null;
  expected_ready_on?: string | null;
  // Phòng "khách nhờ sale / pass" (status_public='pass'): liên hệ + chính sách CỦA KHÁCH
  pass_contact_name?: string | null;
  pass_contact_phone?: string | null;
  pass_sale_policy?: string | null;
  pass_price?: number | null;       // giá pass (VND) — override rent_price nếu có
  pass_avail_date?: string | null;  // 'YYYY-MM-DD' — ngày dự kiến trống (pass)
  pass_contact_manager?: boolean | null; // true = ẩn SĐT khách, chỉ "Liên hệ quản lý"
}
export interface RpcContact { name: string | null; phone: string | null }
export interface RpcPayload {
  areas?: { id: string; name: string }[];
  buildings: RpcBuilding[];
  rooms: RpcRoom[];
  contact?: RpcContact | null;
  sale_policy?: string | null;  // chính sách sale chung (public_room_settings) — RPC cũ không trả
}

export class PublicRoomLinkError extends Error {
  constructor() {
    super('Liên kết phòng trống không hợp lệ hoặc đã hết hạn.');
    this.name = 'PublicRoomLinkError';
  }
}

const boxSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
const nullableText = z.string().nullable();
const optionalText = nullableText.optional();
const layoutSchema = z.object({
  canvasW: z.number(), canvasH: z.number(), corridor: boxSchema,
  fixtures: z.array(boxSchema.extend({ id: z.string(), kind: z.enum(['elevator', 'stairs']) })),
  rooms: z.record(boxSchema),
});
const payloadSchema = z.object({
  areas: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
  buildings: z.array(z.object({
    id: z.string(), name: z.string(), code: nullableText, district: nullableText, ward: nullableText,
    address: nullableText, total_floors: z.number().nullable(), area_ids: z.array(z.string()).nullable().optional(),
    floor_layouts: z.record(layoutSchema).nullable().optional(), images: z.unknown(),
    public_contact_name: optionalText, public_contact_phone: optionalText, public_map_url: optionalText,
    elec_rate: z.number().nullable().optional(), public_lift_type: optionalText,
  })),
  rooms: z.array(z.object({
    id: z.string(), building_id: z.string(), floor: z.number(), name: z.string(), code: nullableText,
    area: z.number().nullable(), rent_price: z.number().nullable(), deposit_amount: z.number().nullable().optional(),
    max_occupants: z.number().nullable(), amenities: z.unknown(), images: z.unknown(), description: nullableText,
    sale_note: optionalText, sale_bonus_note: optionalText, room_type: optionalText,
    status_public: z.enum(['free', 'soon', 'rented', 'pass']), avail_date: nullableText,
    sale_state: z.enum(['READY', 'NOTICE', 'NOTICE_OVERDUE', 'PREPARING', 'RENTED', 'PASS']).nullable().optional(),
    sale_today: optionalText, expected_ready_on: optionalText,
    pass_contact_name: optionalText, pass_contact_phone: optionalText, pass_sale_policy: optionalText,
    pass_price: z.number().nullable().optional(), pass_avail_date: optionalText, pass_contact_manager: z.boolean().nullable().optional(),
  })),
  contact: z.object({ name: nullableText, phone: nullableText }).nullable().optional(),
  sale_policy: optionalText,
});

function isRoomSalePayload(value: unknown): value is RpcPayload {
  return payloadSchema.safeParse(value).success;
}

export function parseRoomSalePayload(value: unknown): RpcPayload {
  if (!isRoomSalePayload(value)) throw new Error('Dữ liệu danh sách phòng không hợp lệ.');
  return value;
}

/* ---- helpers ---- */
function imageUrl(pathOrUrl: string): string {
  if (!pathOrUrl) return "";
  // URL đầy đủ -> dùng thẳng; storage path -> getPublicUrl (đổi IMAGES_BUCKET nếu cần).
  if (/^https?:\/\//i.test(pathOrUrl) || pathOrUrl.startsWith("blob:") || pathOrUrl.startsWith("data:")) return pathOrUrl;
  return supabase.storage.from(IMAGES_BUCKET).getPublicUrl(pathOrUrl).data.publicUrl;
}
function toImages(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => imageUrl(String(x))).filter(Boolean);
}
function toAmenities(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .map((a) =>
        typeof a === "string"
          ? a
          : a && typeof a === "object"
          ? String((a as Record<string, unknown>).name ?? (a as Record<string, unknown>).label ?? "")
          : String(a),
      )
      .filter(Boolean);
  }
  if (raw && typeof raw === "object") return Object.keys(raw).filter((k) => (raw as Record<string, unknown>)[k]);
  return [];
}
/** Số phòng từ name/code ("501" -> 501); không có chữ số thì dùng fallback. */
function roomNo(r: RpcRoom, fallback: number): number {
  const digits = String(r.name ?? r.code ?? "").replace(/\D/g, "");
  return digits ? Number(digits) : fallback;
}
/** "2026-06-30" -> "30/06" (đúng định dạng availDate của UI). */
// Nhận cả `undefined`: `pass_avail_date` là trường TUỲ CHỌN của RpcRoom (RPC cũ
// không trả), nên kiểu thật ở chỗ gọi là `string | null | undefined`. Thân hàm đã
// chặn mọi giá trị falsy sẵn rồi — chỉ chữ ký là hẹp hơn dữ liệu.
function fmtAvail(d: string | null | undefined): string | null {
  if (!d) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  return m ? `${m[3]}/${m[2]}` : d;
}

/* ---- main ---- */
export function mapPayloadToBuildings(payload: RpcPayload | null | undefined, options: { includeInternal?: boolean } = {}): Building[] {
  if (!payload || !Array.isArray(payload.buildings)) return [];

  // Chỉ dùng liên hệ đã cấu hình; thiếu thì giữ rỗng.
  const contactName = payload.contact?.name?.trim() || '';
  const contactPhone = payload.contact?.phone?.trim() || '';
  const salePolicy = payload.sale_policy?.trim() || '';

  // gom phòng theo tòa
  const roomsByB = new Map<string, RpcRoom[]>();
  for (const r of payload.rooms ?? []) {
    const arr = roomsByB.get(r.building_id) ?? [];
    arr.push(r);
    roomsByB.set(r.building_id, arr);
  }

  // Tra tên khu từ payload.areas (RPC chỉ trả area_ids per toà — N-N)
  const areaNameById = new Map(
    (payload.areas ?? []).map((a) => [a.id, a.name] as const),
  );

  return payload.buildings.map((b) => {
    const firstAreaName = (b.area_ids ?? [])
      .map((id) => areaNameById.get(id))
      .find(Boolean);
    const district = b.district || firstAreaName || b.ward || "Khác";
    const address = b.address || district;
    const rawRooms = roomsByB.get(b.id) ?? [];

    const rooms: Room[] = rawRooms.map((rr, i) => {
      const imgs = toImages(rr.images);
      const status = rr.status_public;
      const saleFact = roomSaleFacts({ status, state: rr.sale_state, today: rr.sale_today,
        availableOn: rr.avail_date, expectedReadyOn: rr.expected_ready_on });
      return {
        id: rr.id,
        no: roomNo(rr, rr.floor * 100 + i + 1),
        code: rr.code || rr.name || rr.id.slice(0, 6),
        buildingId: b.id,
        buildingName: b.name,
        buildingArea: district,
        buildingAddr: address,
        floor: rr.floor ?? 1,
        type: rr.room_type?.trim() || "",   // chưa có loại phòng -> để trống
        // Phòng pass: ưu tiên giá khách đặt (pass_price) nếu có.
        price: ((status === "pass" && rr.pass_price != null ? rr.pass_price : rr.rent_price) ?? 0) / 1_000_000,
        area: Math.round(rr.area ?? 0),
        status,
        amenities: toAmenities(rr.amenities),
        availDate: status === "soon" ? fmtAvail(saleFact.availableOn) : null,
        saleFact,
        // Thiếu ảnh không tự thêm ảnh mẫu.
        imgCount: imgs.length,
        phClass: "",
        images: imgs,
        description: rr.description || null,
        saleNote: rr.sale_note || null,
        saleBonus: options.includeInternal ? rr.sale_bonus_note || null : null,
        passContactName: rr.pass_contact_name || null,
        passContactPhone: rr.pass_contact_phone || null,
        passSalePolicy: rr.pass_sale_policy || null,
        passAvailDate: status === "pass" ? fmtAvail(rr.pass_avail_date) : null,
        passContactManager: !!rr.pass_contact_manager,
        x: 0, y: 0, w: 0, h: 0,
      };
    });

    // Nhóm theo tầng (cao -> thấp). Có sơ đồ thủ công cho tầng -> dùng (applyStoredLayout),
    // không thì tự sinh layoutFloor (fallback). Phòng chưa đặt được applyStoredLayout xếp tạm.
    const stored = b.floor_layouts ?? null;
    // Chỉ giữ tầng có ≥1 phòng trống/sắp trống/khách-pass (ẩn tầng đã full khỏi Sơ đồ).
    const floorNums = Array.from(new Set(rooms.map((r) => r.floor)))
      .filter((f) => rooms.some((r) => r.floor === f && (r.status === "free" || r.status === "soon" || r.status === "pass")))
      .sort((a, z) => z - a);
    const floors = floorNums.map((f) => {
      const floorRooms = rooms.filter((r) => r.floor === f).sort((a, z) => a.no - z.no);
      const sl = stored?.[String(f)];
      return sl ? applyStoredLayout(f, floorRooms, sl) : layoutFloor(f, floorRooms);
    });

    return {
      id: b.id,
      code: b.code || "",
      name: b.name,
      area: district,
      district,
      address,
      // Liên hệ riêng từng tòa nếu có; chưa set -> dùng hotline/owner chung.
      manager: b.public_contact_name?.trim() || contactName,
      phone: b.public_contact_phone?.trim() || contactPhone,
      contactPhone: b.public_contact_phone?.trim() || '',
      hotline: contactPhone,
      salePolicy,
      mapUrl: b.public_map_url?.trim() || null,
      elecRate: typeof b.elec_rate === "number" ? b.elec_rate : (b.elec_rate ? Number(b.elec_rate) : null),
      liftLabel: b.public_lift_type?.trim() || null,
      lift: !!b.public_lift_type && /máy/i.test(b.public_lift_type),
      policy: "",
      images: toImages(b.images),
      floors,
      rooms,
      // "Trống" = mọi phòng có thể chào khách: trống sẵn (free) + sắp trống (soon) + khách pass (pass). Chỉ "đã thuê" (rented) không tính.
      freeCount: rooms.filter((r) => r.status === "free" || r.status === "soon" || r.status === "pass").length,
      total: rooms.length,
    };
  });
}
