// Fetch-all phân trang cho PostgREST — diệt bug class "cap 1000 dòng".
//
// PostgREST giới hạn mặc định 1000 dòng/response. Bất kỳ chỗ nào SELECT một
// danh sách rồi CỘNG TIỀN phía client (.reduce) mà không phân trang sẽ âm thầm
// hụt tổng khi vượt 1000 dòng (án lệ: từng mất ~1,5 tỷ). Helper này lặp từng
// trang tới khi trang cuối RỖNG, gộp lại trả về đủ.
//
// GIAO KÈO QUAN TRỌNG: query PHẢI có thứ tự ổn định (order theo cột + tiebreaker
// duy nhất, thường là `id`) để phân trang không sót/trùng ở ranh giới trang.
// Truyền một factory `build(from, to)` áp `.range(from, to)` ở cuối chuỗi.
//
// FAIL-CLOSED (đừng âm thầm trả số sai):
//   - Lỗi query  → trả `null`. Caller PHẢI coi null là LỖI (throw / báo lỗi),
//     KHÔNG được coi là "rỗng" rồi cộng ra 0 (đó chính là bug "biến lỗi tải
//     thành tiền 0"). Ví dụ đúng: `if (rows === null) throw ...`.
//   - Chạm hardCap → THROW (không cắt mảng trả về). Vượt trần = nghi order
//     không ổn định (lặp vô tận) hoặc dataset lớn bất thường → thà lỗi ồn ào
//     còn hơn cộng thiếu tiền. Với dataset thật > hardCap: nâng hardCap CÓ CHỦ Ý
//     hoặc chuyển sang SUM/aggregate trong SQL (ưu tiên hơn kéo hết về client).
//
// KHÔNG suy "trang ngắn = hết": PostgREST/DB có thể cấu hình max-rows THẤP HƠN
// pageSize (vd max-rows=500 dù ta xin 1000) → một trang "đầy" vẫn ngắn hơn
// pageSize. Vì vậy ta TIẾN theo số dòng THỰC nhận và chỉ dừng khi trang RỖNG.
//
// Trùng convention fetchAll đã có trong useAccrualReport.ts — gom về 1 chỗ.

export const SUPABASE_PAGE = 1000;

/**
 * Lặp phân trang một query PostgREST và gộp toàn bộ dòng.
 *
 * @param build  factory nhận (from, to) và trả về một PostgREST builder đã
 *               gắn `.range(from, to)` ở cuối (kèm order ổn định + tiebreaker).
 * @param opts.pageSize  kích thước trang yêu cầu (mặc định 1000). Phải là số
 *                       nguyên dương.
 * @param opts.hardCap   trần an toàn số dòng; VƯỢT sẽ THROW (không cắt). Phải là
 *                       số nguyên dương ≥ pageSize. Mặc định 100k.
 * @returns mảng đầy đủ, hoặc `null` nếu query lỗi (caller PHẢI xử lý null như lỗi).
 * @throws RangeError nếu pageSize/hardCap không hợp lệ; Error nếu chạm hardCap.
 */
/**
 * Query phân trang: nhận (from, to), trả về một thứ `await` được có `data`/`error`.
 *
 * `data: unknown` là CỐ Ý. Trước đây tham số này khai
 * `PromiseLike<{ data: T[] | null; error: unknown }>`, tức đòi builder PostgREST
 * phải trả về ĐÚNG kiểu viết tay mà caller mong. Builder không bao giờ làm vậy —
 * nó trả kiểu SINH TỪ DB, và với select có quan hệ lồng thì hình dạng còn khác
 * nữa. Hệ quả: mọi call site phải ép `(supabase as any)` để đi qua, và cái ép đó
 * tắt kiểm tra cho TOÀN BỘ lời gọi — tên bảng gõ sai, cột không tồn tại, đều
 * biên dịch sạch. Đo 07/08/2026: 22 chỗ ép như vậy còn lại trong code tiền.
 *
 * Nới `data` thành `unknown` đảo ngược đánh đổi: builder vào được mà không cần
 * ép, nên TÊN BẢNG VÀ DANH SÁCH CỘT được kiểm lại; còn `T` chỉ còn chi phối kiểu
 * TRẢ VỀ — một khẳng định của caller, nhưng là khẳng định có tên và nhìn thấy
 * được tại chỗ, không phải một dấu `any` nuốt cả câu lệnh.
 *
 * Cùng khuôn với CustomerCreditRpcInvoker trong src/lib/customerCreditRpc.ts.
 */
export type PagedQueryBuilder = (
  from: number,
  to: number,
) => PromiseLike<{ data: unknown; error: unknown }>;

export async function fetchAllRows<T = any>(
  build: PagedQueryBuilder,
  opts: { pageSize?: number; hardCap?: number; label?: string } = {},
): Promise<T[] | null> {
  const page = opts.pageSize ?? SUPABASE_PAGE;
  const hardCap = opts.hardCap ?? 100_000;
  const tag = opts.label ? ` [${opts.label}]` : "";

  if (!Number.isInteger(page) || page <= 0) {
    throw new RangeError(`fetchAllRows${tag}: pageSize phải là số nguyên dương (nhận ${page}).`);
  }
  if (!Number.isInteger(hardCap) || hardCap <= 0) {
    throw new RangeError(`fetchAllRows${tag}: hardCap phải là số nguyên dương (nhận ${hardCap}).`);
  }
  if (hardCap < page) {
    throw new RangeError(`fetchAllRows${tag}: hardCap (${hardCap}) không được nhỏ hơn pageSize (${page}).`);
  }

  const out: T[] = [];
  // Tiến theo số dòng THỰC nhận (không giả định server trả đúng `page` dòng).
  for (let from = 0; ; ) {
    const { data, error } = await build(from, from + page - 1);
    if (error) {
      console.error(`fetchAllRows${tag} error:`, error);
      return null;
    }
    const rows = (data ?? []) as T[];
    if (rows.length === 0) break; // trang rỗng = hết thật (không suy từ "trang ngắn")
    out.push(...rows);
    if (out.length > hardCap) {
      // FAIL-CLOSED: không trả mảng bị cắt. Vượt trần = order không ổn định
      // (lặp/trùng) hoặc dataset lớn bất thường — cả hai đều phải lộ ra, không
      // được âm thầm cộng thiếu.
      throw new Error(
        `fetchAllRows${tag}: vượt hardCap ${hardCap} dòng (đã gộp ${out.length}). ` +
          `Nghi order không ổn định (thiếu tiebreaker duy nhất) hoặc dataset quá lớn — ` +
          `nâng hardCap có chủ ý hoặc chuyển sang SUM/aggregate trong SQL.`,
      );
    }
    from += rows.length;
  }
  return out;
}
