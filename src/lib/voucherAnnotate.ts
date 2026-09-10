// Ai được thấy nút "Bổ sung chứng từ / ghi chú" (Đợt 2).
//
// Có BỐN mặt thao tác song song trên phiếu thu chi (bảng desktop, danh sách
// mobile, dialog chi tiết, trang chi tiết mobile) và lịch sử cho thấy chúng
// trôi lệch nhau. Một hàm thuần dùng chung để không phải sửa bốn chỗ.
//
// Đây CHỈ là lớp hiển thị. Quyết định thật nằm ở
// public.append_income_expense_supplement_v1: quyền sửa thu chi trên toà, HOẶC là chủ
// tổ chức / super admin, HOẶC đang giữ/biết sổ quỹ, HOẶC là người lập phiếu.
// FE không biết được vế "giữ sổ" nếu không tải thêm dữ liệu, nên ở đây cố tình
// xấp xỉ HẸP HƠN server: thà ẩn nút của một người vốn được phép, còn hơn bày
// một nút bấm vào là lỗi.

export interface AnnotateVisibilityInput {
  /** Có handler mở dialog không. */
  hasHandler: boolean;
  /** Kept for callers; supplementation is available at every status. */
  isUnapproved: boolean;
  /** Admin/super admin also has the independent supplementation action. */
  isAdmin: boolean;
  /** Người lập phiếu. */
  isCreator: boolean;
  /** Có quyền income_expenses.edit. */
  canEdit: boolean;
}

export function canShowAnnotateAction(input: AnnotateVisibilityInput): boolean {
  if (!input.hasHandler) return false;
  return input.isAdmin || input.isCreator || input.canEdit;
}
