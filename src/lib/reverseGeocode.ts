// =============================================================================
// reverseGeocode.ts — quy đổi toạ độ GPS → địa chỉ tiếng Việt (Timemark-style)
// để gắn watermark ảnh nghiệm thu công việc.
//
// Ưu tiên provider (đều CORS-ok cho fetch trực tiếp từ browser):
//   1. Geoapify   — nếu có VITE_GEOAPIFY_API_KEY (free key, không cần thẻ; có sẵn
//                   trường `formatted` tiếng Việt; ~3.000 req/ngày).
//   2. LocationIQ — nếu có VITE_LOCATIONIQ_KEY (Nominatim-grade; `display_name`).
//   3. Photon (Komoot) — MẶC ĐỊNH không cần key, CORS *, dữ liệu OSM street-level
//                   cho VN (verified live). Dùng được ngay không cần cấu hình.
//   4. Nominatim  — fallback cuối (keyless) nếu Photon lỗi.
//
// Dữ liệu địa chỉ từ OpenStreetMap (ODbL) — cần ghi "© OpenStreetMap contributors".
// Mọi lỗi (timeout/CORS/non-200/parse) → trả null để caller fallback về toạ độ.
// =============================================================================

const GEOAPIFY_KEY = import.meta.env.VITE_GEOAPIFY_API_KEY as string | undefined;
const LOCATIONIQ_KEY = import.meta.env.VITE_LOCATIONIQ_KEY as string | undefined;

const TIMEOUT_MS = 3500;

// Cache theo toạ độ làm tròn ~5 chữ số (~1m) để khỏi gọi lại khi render/jitter.
const cache = new Map<string, string | null>();
const keyOf = (lat: number, lng: number) => `${lat.toFixed(5)},${lng.toFixed(5)}`;

const clean = (parts: (string | undefined | null)[]) =>
  parts.map((p) => (p ?? '').trim()).filter(Boolean).join(', ') || null;

/** Thêm tiền tố "P." (phường) kiểu Timemark, nếu chưa có tiền tố hành chính. */
const ward = (w?: string) =>
  w ? (/^(p\.|phường|phuong|xã|x\.|tt\.|thị trấn)/i.test(w) ? w : `P. ${w}`) : undefined;

async function fetchJson(url: string): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function viaGeoapify(lat: number, lng: number): Promise<string | null> {
  const url =
    `https://api.geoapify.com/v1/geocode/reverse?lat=${lat}&lon=${lng}` +
    `&lang=vi&format=json&apiKey=${encodeURIComponent(GEOAPIFY_KEY!)}`;
  const j = await fetchJson(url);
  const r = j?.results?.[0];
  if (!r) return null;
  if (r.formatted) return r.formatted as string;
  return clean([
    [r.housenumber, r.street].filter(Boolean).join(' '),
    ward(r.suburb || r.district),
    r.city || r.state,
  ]);
}

async function viaLocationIq(lat: number, lng: number): Promise<string | null> {
  const url =
    `https://us1.locationiq.com/v1/reverse?key=${encodeURIComponent(LOCATIONIQ_KEY!)}` +
    `&lat=${lat}&lon=${lng}&format=json&accept-language=vi&normalizeaddress=1`;
  const j = await fetchJson(url);
  if (j?.display_name) return j.display_name as string;
  const a = j?.address;
  if (!a) return null;
  return clean([
    [a.house_number, a.road].filter(Boolean).join(' '),
    ward(a.suburb || a.quarter || a.neighbourhood),
    a.city || a.town || a.state,
  ]);
}

async function viaPhoton(lat: number, lng: number): Promise<string | null> {
  const url = `https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}&lang=default`;
  const j = await fetchJson(url);
  const p = j?.features?.[0]?.properties;
  if (!p) return null;
  return clean([
    [p.housenumber, p.street || p.name].filter(Boolean).join(' '),
    ward(p.district || p.locality || p.suburb),
    p.city || p.county || p.state,
  ]);
}

async function viaNominatim(lat: number, lng: number): Promise<string | null> {
  const url =
    `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}` +
    `&format=jsonv2&accept-language=vi&zoom=18&addressdetails=1`;
  const j = await fetchJson(url);
  const a = j?.address;
  if (a) {
    const assembled = clean([
      [a.house_number, a.road].filter(Boolean).join(' '),
      a.neighbourhood || a.quarter,
      ward(a.suburb || a.village),
      a.city_district || a.county,
      a.city || a.town || a.state,
    ]);
    if (assembled) return assembled;
  }
  // bỏ phần mã bưu chính + "Việt Nam" ở cuối display_name cho gọn
  if (j?.display_name) {
    return (j.display_name as string)
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s && !/^\d{4,6}$/.test(s) && !/^(việt nam|vietnam)$/i.test(s))
      .join(', ');
  }
  return null;
}

/**
 * Quy đổi (lat,lng) → địa chỉ tiếng Việt hoặc null. Có cache theo toạ độ.
 */
export async function reverseGeocode(
  lat: number,
  lng: number,
): Promise<string | null> {
  const k = keyOf(lat, lng);
  if (cache.has(k)) return cache.get(k)!;

  let addr: string | null = null;
  if (GEOAPIFY_KEY) addr = await viaGeoapify(lat, lng);
  if (!addr && LOCATIONIQ_KEY) addr = await viaLocationIq(lat, lng);
  if (!addr) addr = await viaPhoton(lat, lng);
  if (!addr) addr = await viaNominatim(lat, lng);

  cache.set(k, addr);
  return addr;
}

/** Ghi công dữ liệu địa chỉ (ODbL) — hiển thị nhỏ ở màn chụp. */
export const GEOCODE_ATTRIBUTION = '© OpenStreetMap';
