// Page-level instructions cho UI-control (instructions.getPageInstructions —
// gọi TRƯỚC MỖI STEP theo URL hiện tại). Cho agent biết đang ở trang nào và
// làm được gì (pilot: CHỈ điều hướng + lọc, KHÔNG form-fill/submit).
//
// Nội dung KHÔNG còn ở đây: chuỗi `if (pathname.startsWith(...))` viết tay đã
// chuyển thành map theo `pageKey` trong `pageScope.ts`, cùng chỗ với hai danh
// sách phạm vi kia. Xem đầu file đó để biết vì sao gộp.
import { chiDanTrang } from './pageScope';

export function pageContext(pathname: string): string | null {
  return chiDanTrang(pathname);
}
