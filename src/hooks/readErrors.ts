import { classifyDbError } from "@/lib/contracts/errors";

/**
 * Dùng ở query đọc MỘT dòng (`.single()`, `.maybeSingle()`, RPC trả một bản ghi).
 *
 * VÌ SAO KHÔNG THROW THẲNG
 *   `.single()` trả PGRST116 khi khớp 0 dòng. Đó là "bản ghi không tồn tại /
 *   đã bị xoá" — một CÂU TRẢ LỜI, không phải hỏng hóc. Đổi máy móc mọi
 *   `return null` thành `throw` sẽ biến màn chi tiết của một bản ghi vừa bị xoá
 *   thành màn lỗi đỏ, tức sửa một lỗi bằng cách tạo ra lỗi ngược lại.
 *
 * VÌ SAO KHÔNG TRẢ NULL CHO MỌI THỨ (hành vi cũ)
 *   42501 (RLS từ chối), 5xx, đứt mạng cũng ra null → UI hiện "không có bản
 *   ghi" y hệt ca trên. Người dùng đọc ra một sự thật SAI mà không có gì báo là
 *   sai, và không có nút thử lại vì query vẫn ở trạng thái success.
 *
 * Phân loại dùng `classifyDbError` (src/lib/contracts/errors.ts) nên PGRST116 và
 * P0002 đi một đường, phần còn lại đi đường lỗi.
 *
 * GIỚI HẠN đã biết: PostgREST dùng CHUNG mã PGRST116 cho "0 dòng" và "nhiều hơn
 * một dòng" ở `.single()`, nên ca thứ hai (giả định duy nhất bị vỡ) cũng ra null
 * thay vì nổ. Chỉ dùng hàm này cho `.single()` lọc theo khoá chính/khoá duy
 * nhất. Với `.maybeSingle()` thì PGRST116 CHỈ còn nghĩa "nhiều dòng" — chỗ đó
 * phải `throw` thẳng, đừng gọi hàm này.
 */
export function nullIfNotFound(error: unknown, label: string): null {
  if (classifyDbError(error) === "not_found") return null;
  console.error(`${label} error:`, error);
  throw error;
}
