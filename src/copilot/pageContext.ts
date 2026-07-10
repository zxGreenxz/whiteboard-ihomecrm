// Page-level instructions cho UI-control (instructions.getPageInstructions —
// gọi TRƯỚC MỖI STEP theo URL hiện tại). Cho agent biết đang ở trang nào và
// làm được gì (pilot: CHỈ điều hướng + lọc, KHÔNG form-fill/submit).
export function pageContext(pathname: string): string | null {
  if (pathname.startsWith('/apartments')) {
    return 'Đang ở trang Căn hộ/Phòng. Bạn có thể lọc theo trạng thái/toà nhà bằng các ô lọc trên trang, hoặc điều hướng. KHÔNG chỉnh sửa/xoá dữ liệu.';
  }
  if (pathname.startsWith('/invoices')) {
    return 'Đang ở trang Hoá đơn. Bạn có thể lọc (kỳ, trạng thái thanh toán, toà) và mở chi tiết. TUYỆT ĐỐI KHÔNG duyệt/huỷ/xoá hoá đơn hay bấm nút thanh toán.';
  }
  if (pathname.startsWith('/customers')) {
    return 'Đang ở trang Cư dân. Bạn có thể tìm kiếm và lọc. KHÔNG sửa/xoá hồ sơ khách hàng.';
  }
  return 'Trang này ngoài phạm vi thao tác. Hãy dừng và báo người dùng.';
}
