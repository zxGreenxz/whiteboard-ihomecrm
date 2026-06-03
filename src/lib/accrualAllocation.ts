/**
 * Phân bổ ACCRUAL theo THÁNG cho hạng mục thu/chi.
 *
 * Số tiền của một hạng mục có "kỳ áp dụng" [start, end] được CHIA ĐỀU cho số
 * tháng trong kỳ (đếm theo year-month, KHÔNG chia theo ngày).
 *
 * Dùng làm tròn LUỸ TIẾN (cumulative rounding): phần tháng i =
 * round(amount*(i+1)/n) − round(amount*i/n). Cách này cho:
 *  - Chia đều: mọi phần lệch nhau tối đa 1 đồng, không sinh phần âm khi amount ≥ 0.
 *  - Bảo toàn tổng: Σ phần = round(amount) (== amount khi amount nguyên — đúng với VND).
 *
 * Thuần (pure) — không phụ thuộc timezone: parse year-month bằng cắt chuỗi, KHÔNG
 * dùng `new Date('yyyy-MM-dd')` (tránh lùi 1 ngày ở GMT+7).
 */

export interface MonthAllocation {
  /** Định dạng 'YYYY-MM'. */
  month: string;
  amount: number;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' | 'YYYY-MM' → chỉ số tháng tuyệt đối (Y*12 + M-1), hoặc null nếu không hợp lệ. */
function monthIndexOf(dateStr: string): number | null {
  const ym = dateStr.slice(0, 7); // 'YYYY-MM'
  const parts = ym.split('-');
  if (parts.length < 2) return null;
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return null;
  return y * 12 + (m - 1);
}

/** Chỉ số tháng tuyệt đối → 'YYYY-MM'. */
function monthKeyFromIndex(idx: number): string {
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  return `${y}-${pad2(m)}`;
}

/**
 * Chia đều `amount` cho các tháng trong kỳ [startDate, endDate].
 *
 * - start/end null/rỗng/không hợp lệ → `[]` (caller tự fallback theo voucher_date).
 * - end < start (data bẩn) → gom hết vào tháng của `start`.
 * - n === 1 (đa số dữ liệu hiện tại) → đúng 1 phần == amount (giữ nguyên, không làm tròn).
 */
export function allocateAmountByMonth(
  amount: number | string | null | undefined,
  startDate: string | null | undefined,
  endDate: string | null | undefined,
): MonthAllocation[] {
  if (!startDate || !endDate) return [];

  const startIdx = monthIndexOf(startDate);
  const endIdx = monthIndexOf(endDate);
  if (startIdx === null || endIdx === null) return [];

  const amt = Number(amount) || 0;

  // Data bẩn: end < start → gom vào tháng start (không vứt tiền).
  if (endIdx < startIdx) {
    return [{ month: monthKeyFromIndex(startIdx), amount: amt }];
  }

  const n = endIdx - startIdx + 1;

  // 1 tháng: giữ nguyên amount (không làm tròn) — đúng với đa số item hiện có.
  if (n === 1) {
    return [{ month: monthKeyFromIndex(startIdx), amount: amt }];
  }

  const result: MonthAllocation[] = [];
  let prevPrefix = 0;
  for (let i = 0; i < n; i++) {
    const prefix = Math.round((amt * (i + 1)) / n);
    result.push({ month: monthKeyFromIndex(startIdx + i), amount: prefix - prevPrefix });
    prevPrefix = prefix;
  }
  return result;
}
