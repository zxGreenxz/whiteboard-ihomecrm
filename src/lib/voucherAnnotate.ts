// Ai được thấy nút "Bổ sung chứng từ / ghi chú" (Đợt 2).
//
// Có BỐN mặt thao tác song song trên phiếu thu chi (bảng desktop, danh sách
// mobile, dialog chi tiết, trang chi tiết mobile) và lịch sử cho thấy chúng
// trôi lệch nhau. Một hàm thuần dùng chung để không phải sửa bốn chỗ.
//
// Đây CHỈ là lớp hiển thị. Quyết định thật nằm ở
// public.annotate_income_expense_v1: quyền sửa thu chi trên toà, HOẶC là chủ
// tổ chức / super admin, HOẶC đang giữ/biết sổ quỹ, HOẶC là người lập phiếu.
// FE không biết được vế "giữ sổ" nếu không tải thêm dữ liệu, nên ở đây cố tình
// xấp xỉ HẸP HƠN server: thà ẩn nút của một người vốn được phép, còn hơn bày
// một nút bấm vào là lỗi.

export interface AnnotateVisibilityInput {
  /** Có handler mở dialog không. */
  hasHandler: boolean;
  /** Phiếu đang ở trạng thái Chờ duyệt — lúc đó dùng form sửa đầy đủ. */
  isUnapproved: boolean;
  /** Admin/super admin đã có nút sửa đầy đủ nên không cần nút này. */
  isAdmin: boolean;
  /** Người lập phiếu. */
  isCreator: boolean;
  /** Có quyền income_expenses.edit. */
  canEdit: boolean;
}

export function canShowAnnotateAction(input: AnnotateVisibilityInput): boolean {
  if (!input.hasHandler) return false;
  if (input.isUnapproved) return false;
  if (input.isAdmin) return false;
  return input.isCreator || input.canEdit;
}
