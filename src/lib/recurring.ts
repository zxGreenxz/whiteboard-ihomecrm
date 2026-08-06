// Tiện ích cho tính năng "Cài đặt lặp lại" phiếu thu/chi.
// addCycle phải KHỚP hàm SQL public.add_cycle (neo ngày-trong-tháng, chống drift).

export type RepeatCycle = 'NONE' | 'WEEK' | 'MONTH' | 'QUARTER' | 'YEAR';

/**
 * Ngày của kỳ thứ `k` (k >= 1) tính TỪ `anchor` (ngày phiếu gốc = kỳ #1).
 * Neo theo ngày-trong-tháng của anchor, clamp về cuối tháng khi tháng đích ngắn
 * hơn — nhưng KHÔNG tụt vĩnh viễn (vd 31/01 → 28/02 → 31/03 → 30/04).
 * Dùng UTC để tránh lệch do timezone.
 *
 * @param anchor chuỗi ngày 'YYYY-MM-DD'
 */
// ĐỪNG "sửa" các `toISOString().slice(0, 10)` trong hàm này thành giờ local.
// Ở đây ngày được DỰNG bằng `Date.UTC(...)` rồi đọc lại bằng `toISOString()` —
// constructor UTC + getter UTC là NHẤT QUÁN, và đó chính là idiom an toàn cho
// số học lịch thuần tuý (không có giờ trong bài toán này).
// Lỗi múi giờ nằm ở chỗ TRỘN hai hệ quy chiếu — ví dụ `new Date()` (thời điểm
// thật) rồi đọc bằng UTC, hoặc dựng bằng setDate() (local) rồi đọc bằng UTC.
// Đợt rà 06/08/2026 sửa 35 chỗ thuộc loại trộn đó và CỐ Ý bỏ qua hàm này.
export function addCycle(anchor: string, cycle: RepeatCycle, k: number): string {
  const [y, m, d] = anchor.split('-').map(Number);

  if (cycle === 'WEEK') {
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + 7 * k);
    return dt.toISOString().slice(0, 10);
  }

  const step = cycle === 'MONTH' ? 1 : cycle === 'QUARTER' ? 3 : cycle === 'YEAR' ? 12 : 0;
  if (step === 0) return anchor; // NONE

  const totalMonth = (m - 1) + step * k; // 0-based tháng tích luỹ
  const ty = y + Math.floor(totalMonth / 12);
  const tm = ((totalMonth % 12) + 12) % 12; // 0-based tháng đích
  const daysInTarget = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  const dom = Math.min(d, daysInTarget);
  return new Date(Date.UTC(ty, tm, dom)).toISOString().slice(0, 10);
}
