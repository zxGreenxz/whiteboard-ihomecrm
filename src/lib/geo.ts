// =============================================================================
// geo.ts — tiện ích thuần phục vụ geo-fence nghiệm thu công việc.
//  - distanceMeters: khoảng cách haversine giữa 2 toạ độ (mét).
//  - parseLatLngFromMapsUrl: tách lat/lng từ link Google Maps (dán vào form).
// Không phụ thuộc React/DOM để test được bằng vitest.
// =============================================================================

export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_M = 6_371_000;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Khoảng cách đường chim bay giữa 2 toạ độ theo công thức haversine, trả về mét.
 */
export function distanceMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

/** Một toạ độ hợp lệ: lat ∈ [-90,90], lng ∈ [-180,180], không phải 0,0. */
export function isValidLatLng(
  lat: number | null | undefined,
  lng: number | null | undefined,
): lat is number {
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180 &&
    !(lat === 0 && lng === 0)
  );
}

/**
 * Tách lat,lng từ một chuỗi (link Google Maps đầy đủ/rút gọn, hoặc "lat, lng").
 * Hỗ trợ các dạng phổ biến:
 *   - https://maps.google.com/?q=10.806,106.665
 *   - https://www.google.com/maps/@10.806,106.665,17z
 *   - https://www.google.com/maps/place/.../@10.806,106.665,17z/data=...
 *   - .../data=...!3d10.806!4d106.665
 *   - "10.806, 106.665"  (nhập tay)
 * Trả null nếu không tách được toạ độ hợp lệ.
 */
export function parseLatLngFromMapsUrl(input: string): LatLng | null {
  if (!input) return null;
  const text = input.trim();

  const candidates: Array<[number, number]> = [];

  // !3d<lat>!4d<lng> — toạ độ chính xác trong link "place"
  const d = text.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (d) candidates.push([parseFloat(d[1]), parseFloat(d[2])]);

  // q=<lat>,<lng> hoặc query=<lat>,<lng> hoặc ll=<lat>,<lng>
  const q = text.match(/[?&](?:q|query|ll|destination)=(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
  if (q) candidates.push([parseFloat(q[1]), parseFloat(q[2])]);

  // @<lat>,<lng> — view center
  const at = text.match(/@(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
  if (at) candidates.push([parseFloat(at[1]), parseFloat(at[2])]);

  // Nhập tay thuần "lat, lng" (không phải URL)
  if (!/https?:\/\//i.test(text)) {
    const pair = text.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (pair) candidates.push([parseFloat(pair[1]), parseFloat(pair[2])]);
  }

  for (const [lat, lng] of candidates) {
    if (isValidLatLng(lat, lng)) return { lat, lng };
  }
  return null;
}
