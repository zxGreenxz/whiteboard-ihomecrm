// =============================================
// CCCD Address → provinces.open-api.vn code lookup
// Map chuỗi địa chỉ thường trú trong QR CCCD sang mã tỉnh/quận/phường
// để auto-select các dropdown trong CustomerForm.
// =============================================

const API_BASE = 'https://provinces.open-api.vn/api';

interface ApiProvince {
  code: number;
  name: string;
  districts?: ApiDistrict[];
}

interface ApiDistrict {
  code: number;
  name: string;
  wards?: ApiWard[];
}

interface ApiWard {
  code: number;
  name: string;
}

export interface AddressLookupResult {
  provinceCode?: string;
  districtCode?: string;
  wardCode?: string;
  /** Phần còn lại của địa chỉ sau khi đã trừ tỉnh/quận/phường đã match */
  detailedAddress: string;
  /**
   * Districts đã fetch (kèm theo wards). Dùng để seed React Query cache cho
   * `useDistricts`/`useWards`, tránh tình trạng Select hiển thị placeholder
   * vì SelectItem chưa render khi setValue.
   */
  districts?: { code: number; name: string; province_code: number }[];
  wards?: { code: number; name: string; district_code: number }[];
}

/** Bỏ dấu tiếng Việt + lowercase để so khớp lỏng. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Bỏ các prefix như "Tỉnh", "TP.", "Thành phố", "Quận", "Huyện", "Phường", "Xã", "Thị xã", "Thị trấn"
 * để so khớp với API (API trả về có prefix nhưng QR thường viết tắt).
 */
function stripPrefix(s: string): string {
  return normalize(s)
    .replace(
      /^(tinh|thanh pho|tp|t p|quan|huyen|thi xa|thi tran|phuong|p|xa|x)\s+/,
      ''
    )
    .trim();
}

function looseMatch(input: string, candidate: string): boolean {
  const a = stripPrefix(input);
  const b = stripPrefix(candidate);
  if (!a || !b) return false;
  return a === b;
}

let provincesCache: ApiProvince[] | null = null;
const districtsCache = new Map<number, ApiDistrict[]>();

async function fetchProvinces(): Promise<ApiProvince[]> {
  if (provincesCache) return provincesCache;
  const res = await fetch(`${API_BASE}/p/`);
  if (!res.ok) return [];
  const data = (await res.json()) as ApiProvince[];
  provincesCache = data || [];
  return provincesCache;
}

async function fetchDistrictsWithWards(provinceCode: number): Promise<ApiDistrict[]> {
  if (districtsCache.has(provinceCode)) return districtsCache.get(provinceCode)!;
  const res = await fetch(`${API_BASE}/p/${provinceCode}?depth=3`);
  if (!res.ok) return [];
  const data = (await res.json()) as ApiProvince;
  const districts = data.districts || [];
  districtsCache.set(provinceCode, districts);
  return districts;
}

/**
 * Phân tích địa chỉ "78H/2, KP3, P.Hiệp Thành, Quận 12, TP.Hồ Chí Minh"
 * → tìm mã province/district/ward, phần thừa làm `detailedAddress`.
 *
 * Best-effort: nếu không match được level nào thì để trống level đó (và các level con).
 * Luôn trả về `detailedAddress` chứa phần thừa để không mất dữ liệu.
 */
export async function lookupAddressFromText(
  rawAddress: string
): Promise<AddressLookupResult> {
  const parts = rawAddress
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    return { detailedAddress: rawAddress };
  }

  // Theo convention VN: phần cuối là tỉnh, kế cuối là quận/huyện, kế nữa là xã/phường.
  const provinceText = parts[parts.length - 1] || '';
  const districtText = parts[parts.length - 2] || '';
  const wardText = parts[parts.length - 3] || '';

  const provinces = await fetchProvinces();
  const province = provinces.find((p) => looseMatch(provinceText, p.name));

  if (!province) {
    return { detailedAddress: parts.join(', ') };
  }

  const apiDistricts = await fetchDistrictsWithWards(province.code);
  const district = districtText
    ? apiDistricts.find((d) => looseMatch(districtText, d.name))
    : undefined;

  let ward: ApiWard | undefined;
  if (district && wardText) {
    ward = (district.wards || []).find((w) => looseMatch(wardText, w.name));
  }

  // Phần thừa = các parts đứng trước level được match thấp nhất.
  let consumedFromEnd = 1; // luôn ăn province
  if (district) consumedFromEnd++;
  if (ward) consumedFromEnd++;
  const remaining = parts.slice(0, parts.length - consumedFromEnd).join(', ');

  const districtsForCache = apiDistricts.map((d) => ({
    code: d.code,
    name: d.name,
    province_code: province.code,
  }));
  const wardsForCache = district
    ? (district.wards || []).map((w) => ({
        code: w.code,
        name: w.name,
        district_code: district.code,
      }))
    : undefined;

  return {
    provinceCode: String(province.code),
    districtCode: district ? String(district.code) : undefined,
    wardCode: ward ? String(ward.code) : undefined,
    detailedAddress: remaining,
    districts: districtsForCache,
    wards: wardsForCache,
  };
}

/** Test-only helper để clear cache. */
export function __clearCccdAddressCache() {
  provincesCache = null;
  districtsCache.clear();
}
