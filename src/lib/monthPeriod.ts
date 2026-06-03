/**
 * Helpers bind `<input type="month">` ('YYYY-MM') với cột DATE ('YYYY-MM-DD')
 * của income_expense_items.start_date / end_date.
 *
 * Quy ước lưu trữ: start_date = ngày ĐẦU tháng bắt đầu, end_date = ngày CUỐI
 * tháng kết thúc. Mọi xử lý dùng cắt chuỗi / số học để TRÁNH lệch timezone
 * (không `new Date('yyyy-MM-dd')`).
 */

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' | 'YYYY-MM' → 'YYYY-MM'. Null/rỗng → ''. */
export function dateToMonth(d: string | null | undefined): string {
  if (!d) return '';
  return d.slice(0, 7);
}

/** 'YYYY-MM' → 'YYYY-MM-01' (ngày đầu tháng). Rỗng → ''. */
export function monthToStartDate(m: string | null | undefined): string {
  if (!m) return '';
  return `${m.slice(0, 7)}-01`;
}

/** 'YYYY-MM' → ngày CUỐI tháng 'YYYY-MM-DD'. Rỗng → ''. */
export function monthToEndDate(m: string | null | undefined): string {
  if (!m) return '';
  const [y, mo] = m.slice(0, 7).split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(mo)) return '';
  // new Date(y, mo, 0) = ngày cuối của tháng `mo` (mo tính từ 1). getDate() an
  // toàn timezone vì chỉ lấy số ngày của Date dựng ở local midnight.
  const lastDay = new Date(y, mo, 0).getDate();
  return `${y}-${pad2(mo)}-${pad2(lastDay)}`;
}

/** Tháng hiện tại 'YYYY-MM' (local). */
export function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
}

/** 'YYYY-MM-DD' | 'YYYY-MM' → 'MM/yyyy'. Null/rỗng → ''. */
function monthLabel(d: string | null | undefined): string {
  const ym = dateToMonth(d);
  if (!ym) return '';
  const [y, m] = ym.split('-');
  return `${m}/${y}`;
}

/**
 * Nhãn kỳ áp dụng để hiển thị: 'MM/yyyy' nếu cùng tháng, 'MM/yyyy – MM/yyyy' nếu
 * khác. Trả '' nếu thiếu start hoặc end (không hiển thị).
 */
export function formatPeriod(
  start: string | null | undefined,
  end: string | null | undefined,
): string {
  if (!start || !end) return '';
  const a = monthLabel(start);
  const b = monthLabel(end);
  if (!a || !b) return '';
  return a === b ? a : `${a} – ${b}`;
}
