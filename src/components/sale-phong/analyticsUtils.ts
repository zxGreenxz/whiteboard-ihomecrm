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

/**
 * User-agent → nhãn ngắn đọc được.
 *
 * Thứ tự kiểm tra quan trọng: trình duyệt in-app (Zalo, Facebook) tự khai mình
 * là Safari/Chrome ở cuối chuỗi, nên phải bắt dấu hiệu in-app TRƯỚC. Đây cũng
 * chính là thông tin đáng giá nhất khi soi lỗi trang công khai — phần lớn khách
 * tới từ link dán trong Zalo.
 */
export function parseUA(ua: string | null | undefined): string {
  const s = String(ua || "");
  if (!s) return "—";
  if (/\bZalo\b/i.test(s)) return "Zalo in-app";
  if (/FBAN|FBAV|FB_IAB|Instagram/i.test(s)) return "Facebook in-app";
  if (/\bLine\//i.test(s)) return "LINE in-app";
  if (/EdgA?\//i.test(s)) return "Edge";
  if (/SamsungBrowser/i.test(s)) return "Samsung Internet";
  if (/CriOS/i.test(s)) return "Chrome (iOS)";
  if (/FxiOS/i.test(s)) return "Firefox (iOS)";
  if (/Firefox\//i.test(s)) return "Firefox";
  if (/Chrome\//i.test(s)) return /Android/i.test(s) ? "Chrome (Android)" : "Chrome";
  if (/Safari\//i.test(s)) return /iPhone|iPad|iPod/i.test(s) ? "Safari (iOS)" : "Safari";
  return "Khác";
}

/** "app" | "external" → nhãn tiếng Việt cho bảng lỗi. */
export function sourceLabel(source: string | null | undefined): string {
  return source === "external" ? "Ngoài app" : "Ứng dụng";
}
