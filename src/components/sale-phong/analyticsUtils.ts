/** Tiện ích format cho tab Thống kê /sale-phong — tách riêng để test thuần. */

/** ms → "m:ss" (hoặc "h:mm" nếu ≥1 giờ). */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const m = Math.floor(s / 60);
  const ss = s % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}h${String(m % 60).padStart(2, "0")}`;
  }
  return `${m}:${String(ss).padStart(2, "0")}`;
}
