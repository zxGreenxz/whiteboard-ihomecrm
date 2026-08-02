/* ===== Mô hình bảng "DANH SÁCH PHÒNG TRỐNG" (nguồn cho ảnh xuất ra) =====
 * Tách PURE khỏi phần vẽ canvas (exportRoomListImage.ts) để test được bằng
 * vitest — canvas 2D không chạy trong jsdom nên toàn bộ logic chọn/định dạng
 * dữ liệu phải nằm ở đây.
 *
 * Bảng bám đúng file Excel mà Sale vẫn gửi Zalo: tiêu đề, ô liên hệ admin,
 * khối thông tin chung, rồi 6 cột ĐỊA CHỈ / MÃ PHÒNG / GIÁ / LOẠI PHÒNG /
 * NỘI THẤT / TÌNH TRẠNG, mỗi tòa một khối nền màu riêng.
 */
import { genInfoLines, MANAGER, type Building, type Room } from "./sampleData";

/** Trạng thái được đưa vào ảnh — đúng bucket "trống" của trang (bỏ `rented`). */
export const EXPORT_STATUSES = ["free", "soon", "pass"] as const;

export interface TableRow {
  /** Mã/số phòng hiển thị ở cột MÃ PHÒNG. */
  code: string;
  /** Giá đầy đủ VND đã định dạng ("4.500.000"); rỗng khi chưa có giá. */
  price: string;
  /** Cột LOẠI PHÒNG — loại phòng + diện tích. */
  type: string;
  /** Cột NỘI THẤT — tiện nghi, fallback sang mô tả phòng. */
  amenities: string;
  /** Cột TÌNH TRẠNG — nhiều dòng (phòng khách pass kèm số liên hệ). */
  status: string[];
}

export interface TableGroup {
  buildingId: string;
  /** Cột ĐỊA CHỈ (gộp ô cho cả khối): địa chỉ, (thang máy), (QL). */
  addressLines: string[];
  rows: TableRow[];
}

export interface RoomListTable {
  title: string;
  /** Ô đỏ bên trái khối đầu: "LIÊN HỆ ADMIN ĐỂ MỞ CỬA" + số điện thoại. */
  contactLines: string[];
  /** Khối thông tin chung bên phải: điện/nước/phí dịch vụ/nội quy. */
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

/** Cột ĐỊA CHỈ (ô gộp): địa chỉ tòa, loại thang, quản lý phụ trách. */
export function addressLines(b: Building): string[] {
  const out = [b.address || b.name];
  if (b.liftLabel?.trim()) out.push(`(${b.liftLabel.trim().toLowerCase()})`);
  if (b.manager?.trim()) out.push(`(${b.manager.trim()})`);
  return out;
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
 * Dòng "Điện …" cho khối thông tin chung. Cùng một giá thì 1 dòng; lệch nhau
 * thì lấy giá phổ biến làm chuẩn và liệt kê tòa ngoại lệ (đúng cách file Excel
 * đang ghi: "3800đ/số với nhà thang máy (102/30 Lê Văn Thọ … 3900đ/số)").
 */
export function elecLines(buildings: Building[]): string[] {
  const rated = buildings.filter((b) => typeof b.elecRate === "number" && b.elecRate! > 0);
  if (!rated.length) return ["Điện theo định mức tòa nhà"];

  const fmt = (n: number) => `${Math.round(n).toLocaleString("vi-VN")}đ/số`;
  const main = Number(modeOf(rated.map((b) => String(b.elecRate))));
  const others = rated.filter((b) => b.elecRate !== main);
  const lines = [`Điện ${fmt(main)}`];
  for (const [rate, names] of groupExceptions(others)) {
    lines.push(`Riêng ${names.join(", ")}: điện ${fmt(rate)}`);
  }
  return lines;
}

/** Gom tòa ngoại lệ theo mức giá điện → [rate, [tên tòa…]]. */
function groupExceptions(buildings: Building[]): [number, string[]][] {
  const byRate = new Map<number, string[]>();
  for (const b of buildings) {
    const rate = Number(b.elecRate);
    const arr = byRate.get(rate) ?? [];
    arr.push(b.name || b.address);
    byRate.set(rate, arr);
  }
  return [...byRate.entries()].sort((a, z) => a[0] - z[0]);
}

/**
 * Dựng toàn bộ bảng từ danh sách tòa. KHÔNG áp bộ lọc quận/tòa/giá đang chọn
 * trên màn hình — ảnh gửi khách luôn là bảng đầy đủ mọi phòng còn chào được.
 */
export function buildRoomListTable(buildings: Building[]): RoomListTable {
  const groups: TableGroup[] = [];
  for (const b of buildings) {
    const rooms = b.rooms
      .filter((r) => EXPORTABLE.has(r.status))
      .sort((a, z) => z.floor - a.floor || a.no - z.no);
    if (!rooms.length) continue;
    groups.push({
      buildingId: b.id,
      addressLines: addressLines(b),
      rows: rooms.map((r) => ({
        code: r.code || String(r.no),
        price: fmtVndFull(r.price),
        type: typeCell(r),
        amenities: amenitiesCell(r),
        status: statusLines(r),
      })),
    });
  }

  const phone = modeOf(buildings.map((b) => b.phone)) ?? MANAGER.phone;
  // Bỏ dòng "Điện …" mặc định của genInfoLines, thay bằng dòng tính theo tòa thật.
  const [, ...rest] = genInfoLines();

  return {
    title: "DANH SÁCH PHÒNG TRỐNG",
    contactLines: ["LIÊN HỆ ADMIN ĐỂ MỞ CỬA", phone],
    infoLines: [...elecLines(buildings), ...rest],
    groups,
    totalRooms: groups.reduce((n, g) => n + g.rows.length, 0),
  };
}

/** Tên file ảnh: danh-sach-phong-trong-YYYYMMDD.png (giữ đúng nếp đặt tên cũ). */
export function exportFileName(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `danh-sach-phong-trong-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}.png`;
}
