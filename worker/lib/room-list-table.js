// =============================================================================
// room-list-table.js — BẢN PORT của `src/pages/phong-trong/roomListTable.ts`
// (kèm `genInfoLines` + `MANAGER` copy từ `src/pages/phong-trong/sampleData.ts`).
//
// HAI BẢN PHẢI GIỮ KHỚP. Web dựng bảng bằng bản TS rồi vẽ ảnh cho người xem
// trang /r/:token; worker dựng LẠI đúng bảng đó để gửi Zalo. Nếu hai bản lệch
// nhau thì khách nhận được một bảng, người mở link thấy một bảng khác — mà
// không có gì báo động, vì cả hai đều "chạy được". Sửa một bên thì sửa luôn
// bên kia, và giữ nguyên chuỗi tiếng Việt từng chữ.
//
// Vì sao phải copy `genInfoLines`/`MANAGER` sang đây thay vì import: worker là
// Node thuần, không có bước biên dịch TypeScript, nên không với tới `.ts` được.
// Đây là bản chép có chủ ý, không phải trùng lặp do quên.
//
// File này PURE — không đọc DB, không vẽ, không I/O. Phần vẽ nằm ở
// `room-list-image.js`, đúng như cách bản web tách roomListTable ↔
// exportRoomListImage.
// =============================================================================

/** Trạng thái được đưa vào ảnh — đúng bucket "trống" của trang (bỏ `rented`). */
export const EXPORT_STATUSES = ['free', 'soon', 'pass'];

const EXPORTABLE = new Set(EXPORT_STATUSES);

/* --------------------------------------------------------------------------
 * Phần chép từ sampleData.ts — thông tin chung + quản lý mặc định.
 * ------------------------------------------------------------------------ */

/** Định dạng dòng điện cho khối "Thông tin chung"; chưa khai giá → câu chung. */
function fmtElec(rate) {
  return rate ? `Điện ${Math.round(rate).toLocaleString('vi-VN')}đ/số` : 'Điện theo định mức tòa nhà';
}

/**
 * Bốn dòng thông tin chung điện/nước/phí dịch vụ/nội quy.
 * Dòng ĐẦU TIÊN luôn là dòng điện — `buildRoomListTable` cắt bỏ dòng này rồi
 * thay bằng dòng tính theo tòa thật, nên đừng đổi thứ tự các dòng.
 */
export function genInfoLines(b) {
  return [
    fmtElec(b?.elecRate),
    'Nước 100k/người · Phí dịch vụ 150k/phòng',
    `Free xe${b?.liftLabel ? ` · ${b.liftLabel}` : ''} · Máy giặt chung · Sân phơi`,
    'Tối đa 3 người · 2 xe · Không nhận xe điện',
  ];
}

/** SĐT/Zalo quản lý mặc định cho ô liên hệ (dùng khi không tòa nào khai SĐT). */
export const MANAGER = { name: 'Quản lý hệ thống', phone: '0909 123 456', zalo: '0909123456' };

/* --------------------------------------------------------------------------
 * Định dạng từng ô
 * ------------------------------------------------------------------------ */

/** Room.price tính bằng triệu → "4.500.000" (làm tròn nghìn, tránh bụi số thực). */
export function fmtVndFull(priceTrieu) {
  if (!priceTrieu || priceTrieu <= 0) return '';
  return (Math.round(priceTrieu * 1000) * 1000).toLocaleString('vi-VN');
}

/** "01/08" → "1/8" (bỏ số 0 đứng đầu như file Excel Sale đang dùng). */
function trimDate(d) {
  return d
    .split('/')
    .map((x) => String(Number(x) || x))
    .join('/');
}

/** Cột TÌNH TRẠNG. Phòng khách pass mang thêm dòng liên hệ của khách. */
export function statusLines(r) {
  if (r.status === 'soon') {
    return [r.availDate ? `${trimDate(r.availDate)} TRỐNG` : 'SẮP TRỐNG'];
  }
  if (r.status === 'pass') {
    // Khách ẩn SĐT: KHÔNG được bịa số nào khác vào đây — đúng ý khách là chỉ
    // đi qua admin iHome.
    if (r.passContactManager) {
      return ['KHÁCH PASS PHÒNG', 'LIÊN HỆ ADMIN IHOME MỞ CỬA'];
    }
    const who = [r.passContactPhone, r.passContactName ? `(${r.passContactName})` : '']
      .filter(Boolean)
      .join(' ');
    return who ? ['KHÁCH PASS PHÒNG:', who] : ['KHÁCH PASS PHÒNG'];
  }
  return ['TRỐNG SẴN'];
}

/** Cột LOẠI PHÒNG — loại phòng + diện tích; thiếu cái nào thì bỏ cái đó. */
export function typeCell(r) {
  const parts = [];
  if (r.area > 0) parts.push(`Phòng ${r.area}m²`);
  if (r.type?.trim()) parts.push(r.type.trim());
  return parts.join(', ');
}

/** Cột NỘI THẤT — tiện nghi; chưa khai thì lấy mô tả phòng. */
export function amenitiesCell(r) {
  const amen = r.amenities.filter(Boolean).join(', ').trim();
  return amen || r.description?.trim() || '';
}

/** Cột ĐỊA CHỈ (ô gộp): địa chỉ tòa, loại thang, quản lý phụ trách. */
export function addressLines(b) {
  const out = [b.address || b.name];
  if (b.liftLabel?.trim()) out.push(`(${b.liftLabel.trim().toLowerCase()})`);
  if (b.manager?.trim()) out.push(`(${b.manager.trim()})`);
  return out;
}

/* --------------------------------------------------------------------------
 * Khối thông tin chung — dòng điện tính theo tòa thật
 * ------------------------------------------------------------------------ */

/** Giá trị xuất hiện nhiều nhất (mode); rỗng → undefined. */
function modeOf(values) {
  const count = new Map();
  for (const v of values) {
    const s = v?.trim();
    if (s) count.set(s, (count.get(s) ?? 0) + 1);
  }
  let best;
  let bestN = 0;
  for (const [v, n] of count) if (n > bestN) { best = v; bestN = n; }
  return best;
}

/**
 * Dòng "Điện …" cho khối thông tin chung. Cùng một giá thì 1 dòng; lệch nhau
 * thì lấy giá phổ biến làm chuẩn và liệt kê tòa ngoại lệ (đúng cách file Excel
 * đang ghi: "3800đ/số với nhà thang máy (102/30 Lê Văn Thọ … 3900đ/số)").
 */
export function elecLines(buildings) {
  const rated = buildings.filter((b) => typeof b.elecRate === 'number' && b.elecRate > 0);
  if (!rated.length) return ['Điện theo định mức tòa nhà'];

  const fmt = (n) => `${Math.round(n).toLocaleString('vi-VN')}đ/số`;
  const main = Number(modeOf(rated.map((b) => String(b.elecRate))));
  const others = rated.filter((b) => b.elecRate !== main);
  const lines = [`Điện ${fmt(main)}`];
  for (const [rate, names] of groupExceptions(others)) {
    lines.push(`Riêng ${names.join(', ')}: điện ${fmt(rate)}`);
  }
  return lines;
}

/** Gom tòa ngoại lệ theo mức giá điện → [rate, [tên tòa…]]. */
function groupExceptions(buildings) {
  const byRate = new Map();
  for (const b of buildings) {
    const rate = Number(b.elecRate);
    const arr = byRate.get(rate) ?? [];
    arr.push(b.name || b.address);
    byRate.set(rate, arr);
  }
  return [...byRate.entries()].sort((a, z) => a[0] - z[0]);
}

/* --------------------------------------------------------------------------
 * Dựng bảng
 * ------------------------------------------------------------------------ */

/**
 * Dựng toàn bộ bảng từ danh sách tòa. KHÔNG áp bộ lọc quận/tòa/giá đang chọn
 * trên màn hình — ảnh gửi khách luôn là bảng đầy đủ mọi phòng còn chào được.
 *
 * Trả về `{ title, contactLines, infoLines, groups, totalRooms }`; `groups` là
 * `{ buildingId, addressLines, rows }` với `rows` là
 * `{ code, price, type, amenities, status[] }`. Đây chính là hình dạng mà
 * `room-list-image.js` chờ nhận.
 */
export function buildRoomListTable(buildings) {
  const groups = [];
  for (const b of buildings) {
    // Sắp xếp: tầng cao xuống thấp, cùng tầng thì số phòng tăng dần — đúng
    // thói quen đọc của Sale (tầng đẹp nằm trên đầu bảng).
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
    title: 'DANH SÁCH PHÒNG TRỐNG',
    contactLines: ['LIÊN HỆ ADMIN ĐỂ MỞ CỬA', phone],
    infoLines: [...elecLines(buildings), ...rest],
    groups,
    totalRooms: groups.reduce((n, g) => n + g.rows.length, 0),
  };
}

/** Tên file ảnh: danh-sach-phong-trong-YYYYMMDD.png (giữ đúng nếp đặt tên cũ). */
export function exportFileName(now) {
  const p = (n) => String(n).padStart(2, '0');
  return `danh-sach-phong-trong-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}.png`;
}
