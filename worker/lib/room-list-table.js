// =============================================================================
// room-list-table.js — BẢN PORT của `src/pages/phong-trong/roomListTable.ts`
//
// HAI BẢN PHẢI GIỮ KHỚP. Web dựng bảng bằng bản TS rồi vẽ ảnh cho người xem
// trang /r/:token; worker dựng LẠI đúng bảng đó để gửi Zalo. Nếu hai bản lệch
// nhau thì khách nhận được một bảng, người mở link thấy một bảng khác — mà
// không có gì báo động, vì cả hai đều "chạy được". Sửa một bên thì sửa luôn
// bên kia, và giữ nguyên chuỗi tiếng Việt từng chữ.
//
// Vì sao phải copy sang đây thay vì import: worker là
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
  if (r.saleFact && r.status !== 'pass') return [r.saleFact.label.toLocaleUpperCase('vi-VN')];
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

/** Cột CHÍNH SÁCH SALE — ô "Khuyến mãi" riêng phòng; phòng khách pass chưa ghi
 * thì lấy chính sách khách pass đã khai. */
export function policyCell(r) {
  return r.saleNote?.trim() || (r.status === 'pass' ? r.passSalePolicy?.trim() : '') || '';
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
export function shortAddress(address) {
  const parts = address.normalize('NFC').split(',').map((p) => p.trim()).filter(Boolean);
  const ward = parts.findIndex((p, i) => i > 0 && WARD_RE.test(p));
  if (ward > 0) {
    const next = parts[ward + 1];
    const keepDistrict = /\d/.test(parts[ward] ?? '') && !!next && !CITY_RE.test(next);
    return parts.slice(0, ward + (keepDistrict ? 2 : 1)).join(', ');
  }
  while (parts.length > 1 && CITY_RE.test(parts[parts.length - 1] ?? '')) parts.pop();
  return parts.join(', ');
}

/** Loại thang của tòa → nhãn "(thang máy)"/"(thang bộ)" kèm loại icon. */
export function liftCell(b) {
  const label = b.liftLabel?.trim().toLowerCase();
  if (!label) return null;
  return { kind: /máy/.test(label) ? 'elevator' : 'stairs', label: `(${label})` };
}

/** Hai số điện thoại là một khi trùng chữ số (bỏ khoảng trắng/dấu, +84 ≡ 0084 ≡ 0). */
export function samePhone(a, b) {
  const digits = (v) =>
    (v ?? '').replace(/\D/g, '').replace(/^00(?=84\d{9}$)/, '').replace(/^84(?=\d{9}$)/, '0');
  return digits(a) === digits(b);
}

/** Chính sách sale chung (chữ tự do nhiều dòng) → mỗi dòng một ý, bỏ dòng trống. */
export function salePolicyLines(text) {
  return (text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/* --------------------------------------------------------------------------
 * Số liên hệ phổ biến nhất (khi chưa chọn hotline)
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

/* --------------------------------------------------------------------------
 * Dựng bảng
 * ------------------------------------------------------------------------ */

/**
 * Dựng toàn bộ bảng từ danh sách tòa. KHÔNG áp bộ lọc quận/tòa/giá đang chọn
 * trên màn hình — ảnh gửi khách luôn là bảng đầy đủ mọi phòng còn chào được.
 *
 * Trả về `{ title, contactLines, infoLines, groups, totalRooms }`; `groups` là
 * `{ buildingId, address, lift, phone, rows }` với `rows` là
 * `{ roomId, code, price, policy, type, amenities, status[] }`. Đây chính là
 * hình dạng mà `room-list-image.js` chờ nhận.
 */
export function buildRoomListTable(buildings) {
  // Hotline/chính sách chung là cấp tài khoản, chép sẵn trên mọi tòa (xem
  // vacant-rooms.js). Chưa chọn hotline → lấy SĐT phổ biến nhất giữa các tòa.
  const hotline = buildings.find((b) => b.hotline?.trim())?.hotline?.trim() || modeOf(buildings.map((b) => b.phone));
  const salePolicy = buildings.find((b) => b.salePolicy?.trim())?.salePolicy;
  const groups = [];
  for (const b of buildings) {
    // Sắp xếp: tầng cao xuống thấp, cùng tầng thì số phòng tăng dần — đúng
    // thói quen đọc của Sale (tầng đẹp nằm trên đầu bảng).
    const rooms = b.rooms
      .filter((r) => EXPORTABLE.has(r.status))
      .sort((a, z) => z.floor - a.floor || a.no - z.no);
    if (!rooms.length) continue;
    const phone = b.phone?.trim() || '';
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
    title: 'DANH SÁCH PHÒNG TRỐNG',
    contactLines: hotline ? ['LIÊN HỆ ADMIN ĐỂ MỞ CỬA', hotline] : ['Chưa có số liên hệ'],
    // Chỉ chữ chủ tự gõ (giá điện, nước, nội quy…) — chủ bỏ dòng điện tự tính 10/10/2026.
    infoLines: salePolicyLines(salePolicy),
    groups,
    totalRooms: groups.reduce((n, g) => n + g.rows.length, 0),
  };
}

/** Tên file ảnh: danh-sach-phong-trong-YYYYMMDD.png (giữ đúng nếp đặt tên cũ). */
export function exportFileName(now) {
  const p = (n) => String(n).padStart(2, '0');
  return `danh-sach-phong-trong-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}.png`;
}
