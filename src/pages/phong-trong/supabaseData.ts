/**
 * Adapter: map payload RPC public `get_public_available_rooms(p_token)` -> type
 * Building/Room mà giao diện "Phòng trống" đang dùng. Giữ NGUYÊN toàn bộ UI.
 *
 * Nguồn: RPC SECURITY DEFINER get_public_available_rooms trả jsonb
 *   { areas, buildings, rooms, contact }  (xem
 *   supabase/migrations/20260606120000_public_room_share_phong_trong.sql).
 * RPC đã tự tính `status_public` (free/soon/rented) theo HỢP ĐỒNG là nguồn sự
 * thật, nên adapter chỉ việc đổ vào shape UI. KHÔNG tạo RPC/migration mới —
 * tái dùng đúng kết nối public đã chạy.
 */
import { supabase } from "@/integrations/supabase/client";
import {
  layoutFloor,
  MANAGER,
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
  area_id: string | null;
  area_name: string | null;     // tên khu vực (join areas)
  district: string | null;      // "Quận …" — dùng cho bộ lọc Quận ở header
  ward: string | null;
  address: string | null;       // RPC đã ghép địa chỉ đầy đủ
  total_floors: number | null;
  floor_layouts?: Record<string, StoredFloorLayout> | null; // sơ đồ tọa độ thủ công
  images?: unknown;             // jsonb: ảnh tòa (URL/path) | []
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
  sale_note?: string | null;    // ô "Khuyến mãi" (promo riêng phòng)
  room_type?: string | null;    // "Loại phòng" (Gác, Cửa kính, Ban công, Studio…)
  status_public: RoomStatus;    // 'free' | 'soon' | 'rented' (RPC tính sẵn)
  avail_date: string | null;    // 'YYYY-MM-DD' cho phòng 'soon'
}
export interface RpcContact { name: string; phone: string }
export interface RpcPayload {
  areas?: { id: string; name: string }[];
  buildings: RpcBuilding[];
  rooms: RpcRoom[];
  contact?: RpcContact | null;
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
function fmtAvail(d: string | null): string | null {
  if (!d) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  return m ? `${m[3]}/${m[2]}` : d;
}

/* ---- main ---- */
export function mapPayloadToBuildings(payload: RpcPayload | null | undefined): Building[] {
  if (!payload || !Array.isArray(payload.buildings)) return [];

  // Liên hệ chung (hotlines). RPC trả 1 contact cho cả owner; chưa có -> MANAGER mặc định.
  const contactName = payload.contact?.name || MANAGER.name;
  const contactPhone = payload.contact?.phone || MANAGER.phone;

  // gom phòng theo tòa
  const roomsByB = new Map<string, RpcRoom[]>();
  for (const r of payload.rooms ?? []) {
    const arr = roomsByB.get(r.building_id) ?? [];
    arr.push(r);
    roomsByB.set(r.building_id, arr);
  }

  return payload.buildings.map((b) => {
    const district = b.district || b.area_name || b.ward || "Khác";
    const address = b.address || district;
    const rawRooms = roomsByB.get(b.id) ?? [];

    const rooms: Room[] = rawRooms.map((rr, i) => {
      const imgs = toImages(rr.images);
      const status = rr.status_public;
      return {
        id: rr.id,
        no: roomNo(rr, rr.floor * 100 + i + 1),
        code: rr.code || rr.name || rr.id.slice(0, 6),
        buildingId: b.id,
        buildingName: b.name,
        buildingArea: district,
        buildingAddr: address,
        floor: rr.floor ?? 1,
        type: rr.room_type || (rr.max_occupants ? `Tối đa ${rr.max_occupants} người` : "Chờ cập nhật"),
        price: (rr.rent_price ?? 0) / 1_000_000,                 // VND -> triệu/tháng
        area: Math.round(rr.area ?? 0),
        status,
        amenities: toAmenities(rr.amenities),
        availDate: status === "soon" ? fmtAvail(rr.avail_date) : null,
        // rooms.images hiện rỗng -> gallery/card dùng placeholder picsum; >=1 để
        // bottom-sheet không hiện gallery trống. Có ảnh thật thì lấy đúng số lượng.
        imgCount: imgs.length || 1,
        phClass: "",
        images: imgs,
        description: rr.description || null,
        saleNote: rr.sale_note || null,
        x: 0, y: 0, w: 0, h: 0,
      };
    });

    // Nhóm theo tầng (cao -> thấp). Có sơ đồ thủ công cho tầng -> dùng (applyStoredLayout),
    // không thì tự sinh layoutFloor (fallback). Phòng chưa đặt được applyStoredLayout xếp tạm.
    const stored = b.floor_layouts ?? null;
    // Chỉ giữ tầng có ≥1 phòng trống/sắp trống (ẩn tầng đã full khỏi Sơ đồ).
    const floorNums = Array.from(new Set(rooms.map((r) => r.floor)))
      .filter((f) => rooms.some((r) => r.floor === f && (r.status === "free" || r.status === "soon")))
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
      manager: contactName,
      phone: contactPhone,
      lift: (b.total_floors ?? 0) > 1,
      policy: "",
      images: toImages(b.images),
      floors,
      rooms,
      freeCount: rooms.filter((r) => r.status === "free").length,
      total: rooms.length,
    };
  });
}
