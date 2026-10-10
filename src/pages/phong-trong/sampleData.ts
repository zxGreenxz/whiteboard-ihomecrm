/* ===== Phòng trống — dữ liệu mẫu + bố cục sơ đồ theo tọa độ =====
 * Khi nối Supabase: thay `SAMPLE` bằng dữ liệu thật và ánh xạ sang các type dưới đây.
 * Tọa độ phòng (x,y,w,h) sau này lấy từ editor sơ đồ kéo-thả (layout_x/y/w/h).
 */

// "locked" chỉ có ở dữ liệu trong app (get_my_available_rooms): phòng bị lock tạm, reader công khai vẫn trả "rented".
export type RoomStatus = "free" | "soon" | "rented" | "pass" | "locked";
import type { RoomSaleFact } from '@/lib/roomSaleFacts';

export interface Box { x: number; y: number; w: number; h: number; }

/** Lock tạm còn hạn (6/12/24 giờ) — chỉ nhân viên trong app thấy. */
export interface RoomSaleLockInfo {
  id: string;
  hours: number;
  note: string | null;
  lockedAt: string;
  expiresAt: string;
  lockedByName: string;
  lockedByMe: boolean;
}

export interface Room extends Box {
  id: string;
  no: number;
  code: string;
  buildingId: string;
  buildingName: string;
  buildingArea: string;
  buildingAddr: string;
  floor: number;
  type: string;
  price: number;        // triệu/tháng
  area: number;         // m²
  status: RoomStatus;
  amenities: string[];
  availDate: string | null;
  saleFact?: RoomSaleFact;
  imgCount: number;
  phClass: string;
  images?: string[];   // ảnh thật từ Supabase; rỗng -> chưa có ảnh
  description?: string | null; // mô tả/ghi chú phòng (vd "cửa sổ hành lang", "ban công")
  saleNote?: string | null;    // ô "Khuyến mãi" (promo riêng của phòng, gửi khách được)
  saleBonus?: string | null;   // ô "Thưởng sale" (nội bộ — KHÔNG đưa vào text gửi khách)
  // Phòng "khách nhờ sale / pass" (status === "pass"): liên hệ + chính sách là CỦA KHÁCH
  passContactName?: string | null;
  passContactPhone?: string | null;
  passSalePolicy?: string | null;
  passAvailDate?: string | null;  // "dd/mm" — ngày dự kiến trống (tuỳ chọn)
  passContactManager?: boolean;   // true = khách ẩn SĐT, chỉ "Liên hệ quản lý" (dùng SĐT QL tòa)
  saleLock?: RoomSaleLockInfo | null; // status === "locked"
}

export interface Fixture extends Box {
  id: string;
  kind: "elevator" | "stairs";
}

export interface FloorPlan {
  floor: number;
  rooms: Room[];
  fixtures: Fixture[];
  corridor: Box;
  canvasW: number;
  canvasH: number;
}

export interface Building {
  id: string;
  code: string;
  name: string;
  area: string;
  district: string;    // nhóm lọc "Quận" ở header (map từ buildings.district khi nối Supabase)
  address: string;
  manager: string;
  phone: string;            // SĐT riêng tòa; chưa khai → hotline chung
  contactPhone?: string;    // đúng public_contact_phone đang lưu ('' = chưa khai) — ô nhập ở Cài đặt hiển thị
  // Hai trường cấp TÀI KHOẢN, chép giống nhau trên mọi tòa (như phone rơi về hotline):
  // bảng ảnh "DANH SÁCH PHÒNG TRỐNG" đọc để in ô liên hệ và khối chính sách chung.
  hotline?: string;         // hotline đang chọn ở Cài đặt hiển thị ('' = chưa có)
  salePolicy?: string;      // chính sách sale chung, nhiều dòng ('' = không in)
  mapUrl?: string | null;   // link Google Maps "Chỉ đường" riêng từng tòa
  elecRate?: number | null; // điện mặc định của tòa (đ/số) — lấy từ building_services
  liftLabel?: string | null; // "Thang máy" | "Thang bộ" — đặc điểm tòa
  lift: boolean;
  policy: string;
  images?: string[];   // ảnh sale của tòa (hero ở header); rỗng -> không hiện
  floors: FloorPlan[];
  rooms: Room[];
  freeCount: number;
  total: number;
}

// Thông tin chung điện/nước/PDV + tiện ích — hiện ở "Thông tin chung" trang tổng
// quan (chung) và mục "Mô tả" từng phòng (điện + thang máy/bộ lấy theo TÒA).
function fmtElec(rate?: number | null): string {
  return rate ? `Điện ${Math.round(rate).toLocaleString("vi-VN")}đ/số` : "Điện theo định mức tòa nhà";
}
export function genInfoLines(b?: { elecRate?: number | null; liftLabel?: string | null }): string[] {
  return [
    ...(b?.elecRate && b.elecRate > 0 ? [fmtElec(b.elecRate)] : []),
    ...(b?.liftLabel?.trim() ? [b.liftLabel.trim()] : []),
  ];
}
// Bản chung (không gắn tòa) cho box "Thông tin chung" ở trang tổng quan.
export const GENERAL_POLICY = { items: genInfoLines() };

export const STATUS_META: Record<RoomStatus, { label: string; short: string }> = {
  free:   { label: "Trống sẵn", short: "Trống" },
  soon:   { label: "Sắp trống", short: "Sắp trống" },
  rented: { label: "Đã thuê",   short: "Đã thuê" },
  pass:   { label: "Khách pass phòng", short: "Khách pass" },
  locked: { label: "Đã chốt tạm", short: "Chốt tạm" },
};

export const fmtPrice = (p: number): string =>
  Number.isInteger(p) ? String(p) : p.toFixed(1).replace(".", ",");

/* ---- layout constants (đơn vị px trong canvas, sẽ scale-to-fit) ---- */
const RW = 150, RH = 118, GAP = 14, M = 18, CORRIDOR = 40;
const colX = (c: number) => M + c * (RW + GAP);

/* ---- generator ---- */
const STATUSES: RoomStatus[] = ["free", "free", "free", "free", "soon", "soon", "rented", "rented", "rented"];
const TYPES: { name: string; area: readonly [number, number]; base: number }[] = [
  { name: "Studio", area: [26, 34], base: 7.5 },
  { name: "1PN",    area: [36, 46], base: 10.5 },
  { name: "1PN+",   area: [44, 52], base: 12.5 },
  { name: "2PN",    area: [55, 70], base: 16 },
  { name: "Duplex", area: [60, 78], base: 19 },
];
const AMENITIES = [
  "Máy lạnh", "Ban công", "Gác lửng", "Bếp riêng", "Máy giặt",
  "Cửa sổ lớn", "Tủ lạnh", "Full nội thất", "Wifi", "Nóng lạnh", "View thành phố",
];
const DEFS = [
  { id: "p1", code: "ORC", name: "The Orchard",      area: "Thảo Điền, Q.2", floors: 9,  perFloor: 7, address: "12 Nguyễn Văn Hưởng, Thảo Điền, Q.2", manager: "A. Hiển", phone: "0357 758 719", lift: true,  policy: "HĐ 12 tháng giảm 200k suốt hợp đồng" },
  { id: "p2", code: "LAV", name: "Lavender House",   area: "Bình Thạnh",     floors: 7,  perFloor: 6, address: "88 Điện Biên Phủ, P.25, Bình Thạnh", manager: "A. Hiệp", phone: "0708 882 357", lift: true,  policy: "HĐ 12 tháng giảm 300k suốt hợp đồng" },
  { id: "p3", code: "SUN", name: "Sunwah Court",     area: "Quận 1",         floors: 12, perFloor: 6, address: "37 Tôn Đức Thắng, Bến Nghé, Q.1", manager: "C. Lan", phone: "0901 234 567", lift: true,  policy: "Giảm 500k tháng đầu" },
  { id: "p4", code: "MAI", name: "Maison Riverside", area: "Quận 4",         floors: 8,  perFloor: 8, address: "5 Bến Vân Đồn, P.12, Q.4", manager: "A. Nam", phone: "0938 111 222", lift: false, policy: "Thưởng sale 500k / hợp đồng" },
];

function seeded(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}
/** Bốc một phần tử theo số ngẫu nhiên [0,1) — mảng hằng không rỗng nên luôn có. */
function pick<T>(arr: readonly T[], r: number): T {
  const v = arr[Math.min(arr.length - 1, Math.floor(r * arr.length))];
  if (v === undefined) throw new Error("pick: mảng rỗng");
  return v;
}
function fmtDate(d: Date) {
  return String(d.getDate()).padStart(2, "0") + "/" + String(d.getMonth() + 1).padStart(2, "0");
}

export function layoutFloor(floor: number, rooms: Room[]): FloorPlan {
  const n = rooms.length;
  const perRow = Math.ceil(n / 2);
  const cols = perRow + 1;            // +1 cột lõi (thang máy/cầu thang) ở giữa
  const coreCol = Math.floor(cols / 2);
  const topY = M;
  const corridorY = M + RH;
  const botY = M + RH + CORRIDOR;
  const canvasW = M * 2 + cols * RW + (cols - 1) * GAP;
  const canvasH = botY + RH + M;

  const topRooms = rooms.slice(0, perRow);
  const botRooms = rooms.slice(perRow);
  let ti = 0, bi = 0;
  const placed: Room[] = [];
  for (let c = 0; c < cols; c++) {
    if (c === coreCol) continue;
    const x = colX(c);
    const top = topRooms[ti];
    if (top) { placed.push({ ...top, x, y: topY, w: RW, h: RH }); ti++; }
    const bot = botRooms[bi];
    if (bot) { placed.push({ ...bot, x, y: botY, w: RW, h: RH }); bi++; }
  }
  const fixtures: Fixture[] = [
    { id: `fx-tm-${floor}`, kind: "elevator", x: colX(coreCol), y: topY, w: RW, h: RH },
    { id: `fx-ct-${floor}`, kind: "stairs",   x: colX(coreCol), y: botY, w: RW, h: RH },
  ];
  const corridor: Box = { x: M, y: corridorY, w: canvasW - M * 2, h: CORRIDOR };
  return { floor, rooms: placed, fixtures, corridor, canvasW, canvasH };
}

function build(): Building[] {
  let gid = 1;
  return DEFS.map((p, pi) => {
    const rnd = seeded((pi + 3) * 9173);
    const floors: FloorPlan[] = [];
    const all: Room[] = [];
    for (let f = p.floors; f >= 1; f--) {
      const rooms: Room[] = [];
      for (let r = 1; r <= p.perFloor; r++) {
        const t = pick(TYPES, rnd());
        const area = Math.round(t.area[0] + rnd() * (t.area[1] - t.area[0]));
        const priceM = t.base + f * 0.18 + (rnd() - 0.5) * 1.4;
        const price = Math.round(priceM * 2) / 2;
        const status = pick(STATUSES, rnd());
        const no = f * 100 + r;
        const amenN = 4 + Math.floor(rnd() * 4);
        const amenities = [...AMENITIES].sort(() => rnd() - 0.5).slice(0, amenN);
        let availDate: string | null = null;
        if (status === "soon") availDate = fmtDate(new Date(2026, 5, 9 + Math.floor(rnd() * 30)));
        const room: Room = {
          id: "r" + gid++, no, code: p.code + "-" + no,
          buildingId: p.id, buildingName: p.name, buildingArea: p.area, buildingAddr: p.address,
          floor: f, type: t.name, area, price, status, amenities, availDate,
          imgCount: 4 + Math.floor(rnd() * 6),
          phClass: pick(["ph-a", "ph-b", "ph-c", "ph-d"], rnd()),
          x: 0, y: 0, w: RW, h: RH,
        };
        rooms.push(room);
        all.push(room);
      }
      floors.push(layoutFloor(f, rooms));
    }
    return {
      id: p.id, code: p.code, name: p.name, area: p.area, district: p.area, address: p.address,
      manager: p.manager, phone: p.phone, lift: p.lift, policy: p.policy,
      floors, rooms: all,
      freeCount: all.filter((r) => r.status === "free" || r.status === "soon" || r.status === "pass").length,
      total: all.length,
    };
  });
}

export const SAMPLE_BUILDINGS: Building[] = build();

/** SĐT/Zalo quản lý mặc định cho nút liên hệ (đổi khi nối dữ liệu thật). */
export const MANAGER = { name: "Quản lý hệ thống", phone: "0909 123 456", zalo: "0909123456" };
