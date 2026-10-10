/* ===== Mô hình bảng "DANH SÁCH PHÒNG TRỐNG" (nguồn cho ảnh xuất ra) =====
 * Tách PURE khỏi phần vẽ canvas (exportRoomListImage.ts) để test được bằng
 * vitest — canvas 2D không chạy trong jsdom nên toàn bộ logic chọn/định dạng
 * dữ liệu phải nằm ở đây.
 *
 * Bảng bám đúng file Excel mà Sale vẫn gửi Zalo: tiêu đề, ô liên hệ admin
 * (hotline), khối thông tin chung (chính sách sale chung chủ tự gõ), rồi 7 cột
 * ĐỊA CHỈ / MÃ PHÒNG / GIÁ / CHÍNH SÁCH SALE / LOẠI PHÒNG / NỘI THẤT /
 * TÌNH TRẠNG, mỗi tòa một khối nền màu riêng.
 */
import { type Building, type Room } from "./sampleData";

/** Trạng thái được đưa vào ảnh — đúng bucket "trống" của trang (bỏ `rented`). */
export const EXPORT_STATUSES = ["free", "soon", "pass"] as const;

/** Bảng màu Excel quen thuộc của file cũ — mỗi tòa một nền; ảnh và khung nhập
 * ở Cài đặt hiển thị dùng chung để hai bên trông giống nhau. */
export const GROUP_BG = [
  "#f4b183", "#a9d18e", "#9dc3e6", "#ffc000", "#ff7c80",
  "#f8cbad", "#ffd966", "#c6e0b4", "#bdd7ee", "#d9d9d9",
] as const;

export interface TableRow {
  /** Phòng nguồn — màn cài đặt dùng để gắn ô nhập chính sách sale vào đúng phòng. */
  roomId: string;
  /** Mã/số phòng hiển thị ở cột MÃ PHÒNG. */
  code: string;
  /** Giá đầy đủ VND đã định dạng ("4.500.000"); rỗng khi chưa có giá. */
  price: string;
  /** Cột CHÍNH SÁCH SALE — chính sách riêng của phòng (xem policyCell). */
  policy: string;
  /** Cột LOẠI PHÒNG — loại phòng + diện tích. */
  type: string;
  /** Cột NỘI THẤT — tiện nghi, fallback sang mô tả phòng. */
  amenities: string;
  /** Cột TÌNH TRẠNG — nhiều dòng (phòng khách pass kèm số liên hệ). */
  status: string[];
}

export type LiftKind = "elevator" | "stairs";

export interface TableGroup {
  buildingId: string;
  /** Cột ĐỊA CHỈ (gộp ô cho cả khối): địa chỉ rút tới phường (xem shortAddress). */
  address: string;
  /** "(thang máy)"/"(thang bộ)" — vẽ nối cùng dòng địa chỉ, có icon phía trước. */
  lift: { kind: LiftKind; label: string } | null;
  /** SĐT riêng của tòa khi KHÁC số ở ô liên hệ đầu bảng; trùng hoặc không có → null. */
  phone: string | null;
  rows: TableRow[];
}

export interface RoomListTable {
  title: string;
  /** Ô đỏ bên trái khối đầu: "LIÊN HỆ ADMIN ĐỂ MỞ CỬA" + số hotline. */
  contactLines: string[];
  /** Khối thông tin chung bên phải: chính sách sale chung (mỗi dòng một ý, chủ tự gõ cả giá điện). */
  infoLines: string[];
  groups: TableGroup[];
  totalRooms: number;
}

const EXPORTABLE = new Set<string>(EXPORT_STATUSES);

/** Room.price tính bằng triệu → "4.500.000" (làm tròn nghìn, tránh bụi số thực). */
export function fmtVndFull(priceTrieu: number): string {
  if (!priceTrieu || priceTrieu <= 0) return "";
  return (Math.round(priceTrieu * 1000) * 1000).toLocaleString("vi-VN");
}

/** "01/08" → "1/8" (bỏ số 0 đứng đầu như file Excel Sale đang dùng). */
function trimDate(d: string): string {
  return d
    .split("/")
    .map((x) => String(Number(x) || x))
    .join("/");
}

/** Cột TÌNH TRẠNG. Phòng khách pass mang thêm dòng liên hệ của khách. */
export function statusLines(r: Room): string[] {
  if (r.saleFact && r.status !== 'pass') return [r.saleFact.label.toLocaleUpperCase('vi-VN')];
  if (r.status === "soon") {
    return [r.availDate ? `${trimDate(r.availDate)} TRỐNG` : "SẮP TRỐNG"];
  }
  if (r.status === "pass") {
    if (r.passContactManager) {
      return ["KHÁCH PASS PHÒNG", "LIÊN HỆ ADMIN IHOME MỞ CỬA"];
    }
    const who = [r.passContactPhone, r.passContactName ? `(${r.passContactName})` : ""]
      .filter(Boolean)
      .join(" ");
    return who ? ["KHÁCH PASS PHÒNG:", who] : ["KHÁCH PASS PHÒNG"];
  }
  return ["TRỐNG SẴN"];
}

/** Cột LOẠI PHÒNG — loại phòng + diện tích; thiếu cái nào thì bỏ cái đó. */
export function typeCell(r: Room): string {
  const parts: string[] = [];
  if (r.area > 0) parts.push(`Phòng ${r.area}m²`);
  if (r.type?.trim()) parts.push(r.type.trim());
  return parts.join(", ");
}

/** Cột NỘI THẤT — tiện nghi; chưa khai thì lấy mô tả phòng. */
export function amenitiesCell(r: Room): string {
  const amen = r.amenities.filter(Boolean).join(", ").trim();
  return amen || r.description?.trim() || "";
}

/** Cột CHÍNH SÁCH SALE — ô "Khuyến mãi" riêng phòng; phòng khách pass chưa ghi
 * thì lấy chính sách khách pass đã khai. */
export function policyCell(r: Room): string {
  return r.saleNote?.trim() || (r.status === "pass" ? r.passSalePolicy?.trim() : "") || "";
}

// Phường: "Phường …"/"Xã …"/"Thị trấn …", "P.…", hoặc "P15" (1–2 chữ số — "P305" là số phòng).
const WARD_RE = /^(?:(?:phường|xã|thị trấn)(?=\s|$)|p\.|p\s*\d{1,2}$)/i;
// Chỉ thành phố trực thuộc trung ương / tỉnh / quốc gia — "TP Thủ Đức" ở giữa là cấp quận, giữ lại.
const CITY_RE = /^(?:(?:thành phố|tp\.?|t\.p\.?)\s*)?(?:hồ chí minh|ho chi minh|hcm|sài gòn|hà nội|ha noi|đà nẵng|cần thơ|hải phòng|huế)$|^tphcm$|^tỉnh\s|^việt nam$/i;

/**
 * Địa chỉ tới phường, bỏ thành phố/tỉnh. Phường đánh số ("Phường 15", "P.11")
 * không tự đứng được nên giữ thêm đoạn ngay sau (quận) — đúng cách file Excel
 * Sale vẫn ghi ("403 Phạm Văn Bạch, P15, Tân Bình"). Không thấy phường thì chỉ
 * cắt các đoạn cuối là thành phố trực thuộc trung ương/tỉnh.
 */
export function shortAddress(address: string): string {
  const parts = address.normalize("NFC").split(",").map((p) => p.trim()).filter(Boolean);
  const ward = parts.findIndex((p, i) => i > 0 && WARD_RE.test(p));
  if (ward > 0) {
    const next = parts[ward + 1];
    const keepDistrict = /\d/.test(parts[ward] ?? "") && !!next && !CITY_RE.test(next);
    return parts.slice(0, ward + (keepDistrict ? 2 : 1)).join(", ");
  }
  while (parts.length > 1 && CITY_RE.test(parts[parts.length - 1] ?? "")) parts.pop();
  return parts.join(", ");
}

/** Loại thang của tòa → nhãn "(thang máy)"/"(thang bộ)" kèm loại icon. */
export function liftCell(b: Building): TableGroup["lift"] {
  const label = b.liftLabel?.trim().toLowerCase();
  if (!label) return null;
  return { kind: /máy/.test(label) ? "elevator" : "stairs", label: `(${label})` };
}

/** Hai số điện thoại là một khi trùng chữ số (bỏ khoảng trắng/dấu, +84 ≡ 0084 ≡ 0). */
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const digits = (v: string | null | undefined) =>
    (v ?? "").replace(/\D/g, "").replace(/^00(?=84\d{9}$)/, "").replace(/^84(?=\d{9}$)/, "0");
  return digits(a) === digits(b);
}

/** Chính sách sale chung (chữ tự do nhiều dòng) → mỗi dòng một ý, bỏ dòng trống. */
export function salePolicyLines(text: string | null | undefined): string[] {
  return (text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/** Giá trị xuất hiện nhiều nhất (mode); rỗng → undefined. */
function modeOf(values: (string | null | undefined)[]): string | undefined {
  const count = new Map<string, number>();
  for (const v of values) {
    const s = v?.trim();
    if (s) count.set(s, (count.get(s) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestN = 0;
  for (const [v, n] of count) if (n > bestN) { best = v; bestN = n; }
  return best;
}

/**
 * Dựng toàn bộ bảng từ danh sách tòa. KHÔNG áp bộ lọc quận/tòa/giá đang chọn
 * trên màn hình — ảnh gửi khách luôn là bảng đầy đủ mọi phòng còn chào được.
 */
export function buildRoomListTable(buildings: Building[]): RoomListTable {
  // Hotline/chính sách chung là cấp tài khoản, chép sẵn trên mọi tòa (xem
  // Building.hotline). Chưa chọn hotline → lấy SĐT phổ biến nhất giữa các tòa.
  const hotline = buildings.find((b) => b.hotline?.trim())?.hotline?.trim() || modeOf(buildings.map((b) => b.phone));
  const salePolicy = buildings.find((b) => b.salePolicy?.trim())?.salePolicy;
  const groups: TableGroup[] = [];
  for (const b of buildings) {
    const rooms = b.rooms
      .filter((r) => EXPORTABLE.has(r.status))
      .sort((a, z) => z.floor - a.floor || a.no - z.no);
    if (!rooms.length) continue;
    const phone = b.phone?.trim() || "";
    groups.push({
      buildingId: b.id,
      address: shortAddress(b.address || b.name),
      lift: liftCell(b),
      phone: phone && !samePhone(phone, hotline) ? phone : null,
      rows: rooms.map((r) => ({
        roomId: r.id,
        code: r.code || String(r.no),
        price: fmtVndFull(r.price),
        policy: policyCell(r),
        type: typeCell(r),
        amenities: amenitiesCell(r),
        status: statusLines(r),
      })),
    });
  }

  return {
    title: "DANH SÁCH PHÒNG TRỐNG",
    contactLines: hotline ? ["LIÊN HỆ ADMIN ĐỂ MỞ CỬA", hotline] : ['Chưa có số liên hệ'],
    // Chỉ chữ chủ tự gõ (giá điện, nước, nội quy…) — chủ bỏ dòng điện tự tính 10/10/2026.
    infoLines: salePolicyLines(salePolicy),
    groups,
    totalRooms: groups.reduce((n, g) => n + g.rows.length, 0),
  };
}

/** Tên file ảnh: danh-sach-phong-trong-YYYYMMDD.png (giữ đúng nếp đặt tên cũ). */
export function exportFileName(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `danh-sach-phong-trong-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}.png`;
}
