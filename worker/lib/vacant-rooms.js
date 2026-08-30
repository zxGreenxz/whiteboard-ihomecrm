// =============================================================================
// vacant-rooms.js — lấy phòng trống của một công ty và đổ về shape Building/Room
// mà bộ dựng bảng (room-list-table.js) đang dùng.
//
// Đây là bản worker của src/pages/phong-trong/supabaseData.ts. Hai bản cùng đọc
// MỘT payload jsonb {areas, buildings, rooms, contact} nên phép map giống nhau;
// khác ba chỗ, đều do worker không phải trình duyệt:
//   • gọi `zalo_phong_trong_cho_worker_v1(org)` thay vì RPC theo token/theo
//     người dùng — worker chạy service-role, không có auth.uid();
//   • không dựng sơ đồ tầng (floors): ảnh bảng không vẽ sơ đồ;
//   • URL ảnh tự ghép từ SUPABASE_URL thay vì qua supabase-js client.
//
// KHÔNG có `saleBonus` ở đây, và đó là chủ ý: RPC phía DB đã không trả
// `sale_bonus_note`. Tiền thưởng sale là dữ liệu nội bộ, mà tin broadcast đi vào
// group Zalo hàng chục người — chặn ở tầng dữ liệu chắc hơn dặn tầng trên nhớ lọc.
// =============================================================================
import { sb, log, SUPABASE_URL } from './ctx.js';

/** Bucket PUBLIC chứa ảnh sale (phòng + toà) — khớp supabaseData.ts. */
const IMAGES_BUCKET = 'room-sale-images';

function urlAnh(pathOrUrl) {
  const s = String(pathOrUrl || '');
  if (!s) return '';
  if (/^https?:\/\//i.test(s) || s.startsWith('data:')) return s;
  return `${SUPABASE_URL}/storage/v1/object/public/${IMAGES_BUCKET}/${s.replace(/^\/+/, '')}`;
}

function dsAnh(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => urlAnh(x)).filter(Boolean);
}

/** amenities trong DB có 3 dạng: mảng chuỗi, mảng object {name|label}, object cờ. */
function dsTienNghi(raw) {
  if (Array.isArray(raw)) {
    return raw
      .map((a) => (typeof a === 'string' ? a : a && typeof a === 'object' ? String(a.name ?? a.label ?? '') : String(a ?? '')))
      .filter(Boolean);
  }
  if (raw && typeof raw === 'object') return Object.keys(raw).filter((k) => raw[k]);
  return [];
}

/** "2026-09-05" → "5/9" (đúng định dạng cột TÌNH TRẠNG của bảng). */
function ngayNgan(d) {
  if (!d) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d));
  return m ? `${Number(m[3])}/${Number(m[2])}` : String(d);
}

function soPhong(r, duPhong) {
  const so = String(r.name ?? r.code ?? '').replace(/\D/g, '');
  return so ? Number(so) : duPhong;
}

/**
 * Đổ payload RPC về Building[] (mỗi Building kèm rooms[]).
 * @param {object|null} payload
 * @returns {Array} buildings
 */
export function mapPayloadSangToa(payload) {
  if (!payload || !Array.isArray(payload.buildings)) return [];

  const tenLienHe = payload.contact?.name || 'Quản lý hệ thống';
  const sdtLienHe = payload.contact?.phone || '';

  const phongTheoToa = new Map();
  for (const r of payload.rooms ?? []) {
    const arr = phongTheoToa.get(r.building_id) ?? [];
    arr.push(r);
    phongTheoToa.set(r.building_id, arr);
  }

  const tenKhuTheoId = new Map((payload.areas ?? []).map((a) => [a.id, a.name]));

  return payload.buildings.map((b) => {
    const tenKhu = (b.area_ids ?? []).map((id) => tenKhuTheoId.get(id)).find(Boolean);
    const quan = b.district || tenKhu || b.ward || 'Khác';
    const diaChi = b.address || quan;
    const tho = phongTheoToa.get(b.id) ?? [];

    const rooms = tho.map((rr, i) => {
      const status = rr.status_public;
      return {
        id: rr.id,
        no: soPhong(rr, (rr.floor ?? 1) * 100 + i + 1),
        code: rr.code || rr.name || String(rr.id).slice(0, 6),
        buildingId: b.id,
        buildingName: b.name,
        buildingArea: quan,
        buildingAddr: diaChi,
        floor: rr.floor ?? 1,
        type: (rr.room_type || '').trim(),
        // Phòng khách pass: giá của khách đè giá thuê gốc (khớp supabaseData.ts).
        price: ((status === 'pass' && rr.pass_price != null ? rr.pass_price : rr.rent_price) ?? 0) / 1_000_000,
        area: Math.round(rr.area ?? 0),
        status,
        amenities: dsTienNghi(rr.amenities),
        availDate: status === 'soon' ? ngayNgan(rr.avail_date) : null,
        images: dsAnh(rr.images),
        description: rr.description || null,
        saleNote: rr.sale_note || null,
        passContactName: rr.pass_contact_name || null,
        passContactPhone: rr.pass_contact_phone || null,
        passSalePolicy: rr.pass_sale_policy || null,
        passAvailDate: status === 'pass' ? ngayNgan(rr.pass_avail_date) : null,
        passContactManager: !!rr.pass_contact_manager,
      };
    });

    return {
      id: b.id,
      code: b.code || '',
      name: b.name,
      area: quan,
      district: quan,
      address: diaChi,
      manager: (b.public_contact_name || '').trim() || tenLienHe,
      phone: (b.public_contact_phone || '').trim() || sdtLienHe,
      mapUrl: (b.public_map_url || '').trim() || null,
      elecRate: typeof b.elec_rate === 'number' ? b.elec_rate : (b.elec_rate ? Number(b.elec_rate) : null),
      liftLabel: (b.public_lift_type || '').trim() || null,
      lift: !!b.public_lift_type && /máy/i.test(b.public_lift_type),
      policy: '',
      images: dsAnh(b.images),
      floors: [],
      rooms,
      freeCount: rooms.length,
      total: rooms.length,
    };
  });
}

/**
 * Đọc phòng trống của một công ty.
 * @param {string} organizationId
 * @returns {Promise<{buildings: Array, rooms: Array, hotline: string}>}
 *          `rooms` là danh sách PHẲNG đã kèm tên/địa chỉ toà — engine dùng nó để
 *          soạn tin chi tiết và để tính vân tay thay đổi.
 */
export async function docPhongTrong(organizationId) {
  const { data, error } = await sb.rpc('zalo_phong_trong_cho_worker_v1', {
    p_organization_id: organizationId,
  });
  if (error) throw new Error(`Không đọc được phòng trống: ${error.message}`);

  const buildings = mapPayloadSangToa(data);
  const rooms = buildings.flatMap((b) => b.rooms);
  const hotline = data?.contact?.phone || buildings.find((b) => b.phone)?.phone || '';
  log('phòng trống org', String(organizationId).slice(0, 8), '→', rooms.length, 'phòng /', buildings.length, 'toà');
  return { buildings, rooms, hotline };
}
