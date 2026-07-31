/**
 * Toán học vòng xoay may mắn (/quayso).
 *
 * Quy ước:
 * - Canvas 2D: trục y hướng xuống, góc dương quay theo chiều kim đồng hồ.
 * - Kim cố định ở đỉnh (12 giờ) = góc -PI/2.
 * - Bánh xe vẽ ô i chiếm cung [i*seg, (i+1)*seg) TRƯỚC khi cộng góc xoay `rot`.
 *
 * Server đã chốt đội trúng (winner index trong danh sách đội quay); client chỉ
 * việc quay bánh xe dừng đúng ô đó. Jitter làm kim không đậu chính giữa ô cho
 * tự nhiên nhưng không bao giờ được phép lệch sang ô kề — clamp ±0.35*seg.
 */

export const POINTER_ANGLE = -Math.PI / 2;

/** Chuẩn hoá góc về [0, 2PI). */
export function normalizeAngle(a: number): number {
  const TAU = Math.PI * 2;
  const x = a % TAU;
  if (x >= 0) return x;
  // Số âm cực nhỏ (vd -1e-16) cộng TAU sẽ LÀM TRÒN LÊN đúng TAU — phá biên
  // trên và làm Math.floor(x/seg) trả về `count`. Trả 0 cho đúng nửa khoảng.
  const shifted = x + TAU;
  return shifted >= TAU ? 0 : shifted;
}

/** Ô đang nằm dưới kim với góc xoay `rot` và `count` ô. */
export function indexAtPointer(rot: number, count: number): number {
  if (count <= 0) return -1;
  const seg = (Math.PI * 2) / count;
  // Math.floor có thể trả về `count` khi normalize sát 2PI (sai số float) → kẹp lại.
  return Math.min(count - 1, Math.floor(normalizeAngle(POINTER_ANGLE - rot) / seg));
}

/**
 * Góc đích tuyệt đối để kim dừng ĐÚNG ô `winIdx`.
 * @param winIdx    ô trúng (0-based trong danh sách đội trên bánh)
 * @param count     tổng số ô
 * @param jitter01  số ngẫu nhiên [0,1) — lệch tâm ô, clamp ±0.35*seg
 * @param turns     số vòng quay trọn trước khi dừng (>=1)
 */
export function targetRotation(
  winIdx: number,
  count: number,
  jitter01: number,
  turns: number,
): number {
  const seg = (Math.PI * 2) / count;
  const jitter = Math.max(-0.35 * seg, Math.min(0.35 * seg, (jitter01 - 0.5) * seg * 0.7));
  const targetLocal = winIdx * seg + seg / 2 + jitter;
  return POINTER_ANGLE - targetLocal - Math.max(1, turns) * Math.PI * 2;
}

/** Ease-out bậc 5 cho chuyển động quay giảm tốc. */
export function easeOutQuint(p: number): number {
  return 1 - Math.pow(1 - Math.min(1, Math.max(0, p)), 5);
}

/** Đếm ngược "hh:mm:ss" (hoặc "d ngày hh:mm:ss") từ số ms còn lại. */
export function formatCountdown(msLeft: number): string {
  const total = Math.max(0, Math.floor(msLeft / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const hh = String(h).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return d > 0 ? `${d} ngày ${hh}:${mm}:${ss}` : `${hh}:${mm}:${ss}`;
}
