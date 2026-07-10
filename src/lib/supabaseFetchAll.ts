// Fetch-all phân trang cho PostgREST — diệt bug class "cap 1000 dòng".
//
// PostgREST giới hạn mặc định 1000 dòng/response. Bất kỳ chỗ nào SELECT một
// danh sách rồi CỘNG TIỀN phía client (.reduce) mà không phân trang sẽ âm thầm
// hụt tổng khi vượt 1000 dòng (án lệ: từng mất ~1,5 tỷ). Helper này lặp từng
// trang PAGE=1000 tới khi trang cuối ngắn hơn PAGE, gộp lại trả về đủ.
//
// GIAO KÈO QUAN TRỌNG: query PHẢI có thứ tự ổn định (order theo cột + tiebreaker
// duy nhất, thường là `id`) để phân trang không sót/trùng ở ranh giới trang.
// Truyền một factory `build(from, to)` áp `.range(from, to)` ở cuối chuỗi.
//
// Trùng convention fetchAll đã có trong useAccrualReport.ts — gom về 1 chỗ.

export const SUPABASE_PAGE = 1000;

/**
 * Lặp phân trang một query PostgREST và gộp toàn bộ dòng.
 *
 * @param build  factory nhận (from, to) và trả về một PostgREST builder đã
 *               gắn `.range(from, to)` ở cuối (kèm order ổn định + tiebreaker).
 * @param opts.pageSize  kích thước trang (mặc định 1000).
 * @param opts.hardCap   trần an toàn số dòng; vượt sẽ dừng + cảnh báo (tránh
 *                       vòng lặp vô tận nếu order không ổn định). Mặc định 100k.
 * @returns mảng đầy đủ, hoặc null nếu có lỗi query (giữ nguyên hành vi cũ:
 *          caller tự quyết fallback).
 */
export async function fetchAllRows<T = any>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  opts: { pageSize?: number; hardCap?: number; label?: string } = {},
): Promise<T[] | null> {
  const page = opts.pageSize ?? SUPABASE_PAGE;
  const hardCap = opts.hardCap ?? 100_000;
  const out: T[] = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await build(from, from + page - 1);
    if (error) {
      console.error(`fetchAllRows${opts.label ? ` [${opts.label}]` : ""} error:`, error);
      return null;
    }
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < page) break;
    if (out.length >= hardCap) {
      console.warn(
        `fetchAllRows${opts.label ? ` [${opts.label}]` : ""}: chạm hardCap ${hardCap} dòng — CẮT. ` +
          `Kiểm tra order ổn định hoặc thu hẹp filter.`,
      );
      break;
    }
  }
  return out;
}
