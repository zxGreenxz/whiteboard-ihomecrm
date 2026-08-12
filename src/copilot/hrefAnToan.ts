/**
 * Lọc link do MÔ HÌNH sinh ra trước khi cho vào `<a href>`.
 *
 * Đây là biên giới tin cậy, không phải chỗ định dạng cho đẹp. Mô hình đọc dữ
 * liệu nghiệp vụ — tên khách, ghi chú, tin nhắn Zalo — nên một chuỗi do người
 * ngoài nhập có thể đi trọn đường từ ô nhập liệu tới thuộc tính `href` này.
 * Nhận mọi scheme nghĩa là `[Bấm vào đây](javascript:...)` trở thành nút chạy mã
 * trong phiên đã đăng nhập, và `data:text/html,...` thành trang giả mạo trông
 * như cùng nguồn gốc.
 *
 * Cho qua đúng hai dạng:
 *   - đường dẫn nội bộ bắt đầu bằng `/` — nhưng KHÔNG phải `//`, vốn là URL
 *     giao thức-tương đối trỏ ra host khác dù nhìn như đường dẫn nội bộ;
 *   - URL tuyệt đối `https:`.
 *
 * Ngoài ra trả `null`; chỗ gọi render thành chữ thường để người dùng vẫn thấy
 * mô hình định trỏ đi đâu mà không bấm được.
 *
 * Dùng `new URL` thay vì tự cắt chuỗi scheme: các mẹo né như `JavaScript:`,
 * `java\tscript:` hay khoảng trắng đầu chuỗi đều được nó chuẩn hoá giúp.
 */
export function hrefAnToan(raw: string): string | null {
  const href = raw.trim();
  if (href.startsWith('/') && !href.startsWith('//')) return href;
  try {
    return new URL(href).protocol === 'https:' ? href : null;
  } catch {
    return null; // không phải URL tuyệt đối hợp lệ → chữ thường
  }
}
