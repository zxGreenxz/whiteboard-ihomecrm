// =============================================================================
// gpsFix.ts — lấy toạ độ "bền" cho camera nghiệm thu/kiểm tra nhà.
//
// BỆNH ĐÃ GẶP (27/07/2026, phiên 158PVC): mỗi lần mở camera là một vòng
// watchPosition MỚI với enableHighAccuracy=true. Đứng trong nhà (tủ điện, hầm
// bơm) GPS không có tầm nhìn vệ tinh → 15s timeout, mà nhân viên bấm chụp sau
// ~8s nên lat/lng = NULL. Kết quả: 7/7 ảnh geofence_status='gps_denied', phiên
// rơi 'presence' với lời nhắc "Cần ≥1 ảnh trong bán kính toà" trong khi mọi mục
// checklist đã ✓ — người dùng không còn chỗ nào để bấm chụp nữa.
//
// THUỐC (3 lớp, theo thứ tự rẻ → đắt):
//  1. CACHE toàn app: fix lấy được ở lần mở camera trước dùng lại ngay cho lần
//     sau (mặc định còn hạn 2 phút) → chụp liên tiếp 6 mục chỉ phải "bắt" 1 lần.
//  2. Vòng CHÍNH xác cao (enableHighAccuracy) cho ảnh sát toà.
//  3. Vòng THÔ (enableHighAccuracy=false, maximumAge dài) khi vòng 1 timeout —
//     định vị theo wifi/cell thường vẫn ăn trong nhà, sai số vài chục mét vẫn
//     đủ để so bán kính toà.
//
// Không phụ thuộc React để test được bằng vitest (geolocation tiêm vào).
// =============================================================================

export interface GpsFix {
  lat: number;
  lng: number;
  accuracy: number;
  /** Epoch ms lúc lấy được fix (theo đồng hồ máy). */
  at: number;
}

export type GpsPhase = 'locating' | 'ok' | 'denied' | 'unavailable';

/** Fix cũ còn dùng được bao lâu (ms) — đủ cho một lượt chụp hết checklist. */
export const GPS_CACHE_MAX_AGE_MS = 120_000;

const HIGH_ACCURACY_OPTS: PositionOptions = {
  enableHighAccuracy: true,
  timeout: 12_000,
  maximumAge: 30_000,
};
const COARSE_OPTS: PositionOptions = {
  enableHighAccuracy: false,
  timeout: 30_000,
  maximumAge: 300_000,
};

let lastFix: GpsFix | null = null;

/** Ghi nhớ fix mới nhất để lần mở camera sau dùng lại ngay. */
export function rememberGpsFix(fix: GpsFix): void {
  lastFix = fix;
}

/** Fix gần nhất nếu còn hạn, null nếu chưa có/đã cũ. */
export function getCachedGpsFix(
  maxAgeMs: number = GPS_CACHE_MAX_AGE_MS,
  now: number = Date.now(),
): GpsFix | null {
  if (!lastFix) return null;
  return now - lastFix.at <= maxAgeMs ? lastFix : null;
}

/** Chỉ dùng trong test. */
export function __resetGpsCache(): void {
  lastFix = null;
}

export interface AcquireGpsOptions {
  /** Tiêm cho test; mặc định navigator.geolocation. */
  geolocation?: Pick<Geolocation, 'watchPosition' | 'clearWatch'> | null;
  /** Tiêm cho test; mặc định Date.now. */
  now?: () => number;
  /** Bỏ qua cache (mặc định dùng cache 2 phút). */
  maxCacheAgeMs?: number;
}

function toFix(pos: GeolocationPosition, now: () => number): GpsFix {
  return {
    lat: pos.coords.latitude,
    lng: pos.coords.longitude,
    accuracy: pos.coords.accuracy,
    at: now(),
  };
}

/**
 * Bắt đầu lấy toạ độ theo thang 3 lớp ở trên. Gọi `onUpdate` mỗi khi có thay
 * đổi (fix mới hoặc đổi trạng thái). Trả hàm dừng.
 *
 * Quy ước trạng thái:
 *  - 'locating'    : đang bắt, chưa có toạ độ nào
 *  - 'ok'          : đang có toạ độ dùng được (có thể là fix cache)
 *  - 'denied'      : user/OS chặn quyền vị trí → không tự khỏi được
 *  - 'unavailable' : hết đường (không có API, hoặc cả 2 vòng đều lỗi)
 */
export function acquireGpsFix(
  onUpdate: (fix: GpsFix | null, phase: GpsPhase) => void,
  opts: AcquireGpsOptions = {},
): () => void {
  const now = opts.now ?? (() => Date.now());
  const geo =
    opts.geolocation !== undefined
      ? opts.geolocation
      : typeof navigator !== 'undefined' && 'geolocation' in navigator
        ? navigator.geolocation
        : null;

  let stopped = false;
  let watchId: number | null = null;
  let best: GpsFix | null = getCachedGpsFix(opts.maxCacheAgeMs ?? GPS_CACHE_MAX_AGE_MS, now());

  // Lớp 1: có fix cache còn hạn → dùng NGAY, không bắt người dùng chờ.
  if (best) onUpdate(best, 'ok');
  else onUpdate(null, 'locating');

  if (!geo) {
    if (!best) onUpdate(null, 'unavailable');
    return () => {};
  }

  const clear = () => {
    if (watchId != null) {
      geo.clearWatch(watchId);
      watchId = null;
    }
  };

  const onPosition = (pos: GeolocationPosition) => {
    if (stopped) return;
    const fix = toFix(pos, now);
    best = fix;
    rememberGpsFix(fix);
    onUpdate(fix, 'ok');
  };

  const startCoarse = () => {
    if (stopped) return;
    watchId = geo.watchPosition(
      onPosition,
      (err) => {
        if (stopped) return;
        clear();
        // Vòng thô cũng chết: giữ nguyên fix cũ nếu có, không thì báo hết đường.
        onUpdate(best, best ? 'ok' : err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable');
      },
      COARSE_OPTS,
    );
  };

  // Lớp 2: chính xác cao.
  watchId = geo.watchPosition(
    onPosition,
    (err) => {
      if (stopped) return;
      clear();
      if (err.code === err.PERMISSION_DENIED) {
        onUpdate(best, best ? 'ok' : 'denied');
        return;
      }
      // Lớp 3: timeout/không bắt được vệ tinh (điển hình khi đứng TRONG nhà)
      // → hạ chuẩn sang định vị wifi/cell, chấp nhận fix cũ tới 5 phút.
      startCoarse();
    },
    HIGH_ACCURACY_OPTS,
  );

  return () => {
    stopped = true;
    clear();
  };
}
