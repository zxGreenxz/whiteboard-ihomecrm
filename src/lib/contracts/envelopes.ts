import { classifyDbError, isRetryable, type ErrorCategory } from "./errors";

/**
 * Bao kết quả cho lời gọi RPC/Edge — plan §9.
 *
 * VÌ SAO KHÔNG DÙNG `T | null`
 *   `null` không phân biệt được ba chuyện khác hẳn nhau: "không có dữ liệu",
 *   "không có quyền xem", và "gọi hỏng". Đo ngày 07/08 trên 984 file: 147 chỗ
 *   biến lỗi thành `[]`, `{}` hoặc `null` — 34 chỗ trong đó nằm ở vùng tiền.
 *   Ở đó, "không có quyền" hiển thị y hệt "không có phiếu nào", và người đối
 *   chiếu quỹ đọc ra một con số thiếu mà không có gì báo là thiếu.
 *
 * VÌ SAO KHÔNG NÉM
 *   Ném hợp với đường GHI (đã có: các wrapper canonical `fail closed`). Với
 *   đường ĐỌC trong React Query thì một lỗi quyền và một lỗi mạng cần xử khác
 *   nhau, mà cả hai đều tới chỗ `onError` như nhau. Envelope giữ được PHÂN LOẠI
 *   tới tận nơi quyết định.
 */
/**
 * PHÂN BIỆT BẰNG CHUỖI `kind`, KHÔNG BẰNG BOOLEAN `ok`.
 *
 * Bản đầu dùng `{ ok: true } | { ok: false }`. Nó biên dịch ở chế độ strict nhưng
 * KHÔNG thu hẹp kiểu dưới cấu hình thật của repo: tsconfig.app.json đặt
 * `strictNullChecks: false`, và ở đó TypeScript không coi `true`/`false` là kiểu
 * literal đủ mạnh để phân nhánh union. Hậu quả: `result.error` báo lỗi ngay sau
 * `if (result.ok) return …`, tức envelope không dùng được ở chính nơi nó phục vụ.
 * Discriminant chuỗi thu hẹp đúng ở cả hai chế độ.
 */
export type ContractResult<T> =
  | { kind: "ok"; data: T }
  | { kind: "loi"; category: ErrorCategory; error: unknown; retryable: boolean };

/** Bọc `{ data, error }` của supabase-js thành envelope đã phân loại. */
export function toResult<T>(res: { data: T | null; error: unknown }): ContractResult<T> {
  if (res.error) {
    const category = classifyDbError(res.error);
    return { kind: "loi", category, error: res.error, retryable: isRetryable(category) };
  }
  // `data === null` KHÔNG error là hợp lệ với `.maybeSingle()`; người gọi tự
  // quyết định null có nghĩa gì trong ngữ cảnh của họ.
  return { kind: "ok", data: res.data as T };
}

/**
 * Lấy dữ liệu, ném nếu hỏng — cho đường GHI và cho React Query `queryFn`.
 *
 * Giữ nguyên đối tượng lỗi gốc thay vì bọc lại: `friendlyError()` và mọi chỗ
 * đang đọc `error.code` vẫn chạy như cũ. Chỉ gắn thêm `category` để nơi bắt lỗi
 * biết phải làm gì mà không phải tự tra bảng mã lần nữa.
 */
export function unwrapOrThrow<T>(result: ContractResult<T>): T {
  if (result.kind === "ok") return result.data;
  const err = result.error;
  if (err && typeof err === "object") {
    (err as Record<string, unknown>).category = result.category;
    (err as Record<string, unknown>).retryable = result.retryable;
  }
  throw err;
}

/**
 * Hàm `retry` cho React Query, dựa trên PHÂN LOẠI thay vì đếm lần.
 *
 * Mặc định của React Query là thử lại 3 lần cho MỌI lỗi. Trên đường ghi tiền,
 * đó là cách tạo ra bút toán trùng: một lời gọi đã ghi xong rồi hỏng ở đường về
 * sẽ được gửi lại. Hàm này chỉ cho thử lại nhóm `concurrency` — ba mã mà
 * PostgreSQL bảo đảm giao dịch không để lại tác dụng phụ nào.
 */
export function retryOnlyConcurrency(soLan: number, error: unknown): boolean {
  if (soLan >= 2) return false;
  return isRetryable(classifyDbError(error));
}
