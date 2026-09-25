// Ai được mở màn "Sổ nhận tiền" (đợt 1 sửa phiếu, 25/09/2026): chủ công ty hoặc
// super admin.
//
// Đây chỉ là CỜ HIỂN THỊ (ẩn/hiện tab, nút). Hàng rào thật nằm ở máy chủ:
// list_receiving_cashbook_settings_v1 / set_personal_cash_book_v1 /
// set_building_receiving_cashbooks_v1 đều kiểm `is_super_admin()` hoặc
// `ie_actor_is_company_owner_v1` theo ĐÚNG tổ chức. `useIsCompanyOwner` không nhận
// org nên trả "có" khi là chủ ở ít nhất một tổ chức — chọn nhầm công ty thì RPC
// trả 42501 và màn cài hiện lỗi đó.
//
// Dùng chung cho màn cài và hai trang Sổ quỹ (máy tính / điện thoại) để luật
// "ai thấy" chỉ có một chỗ.

import { useIsCompanyOwner } from "@/hooks/useIsCompanyOwner";
import { useIsSuperAdmin } from "@/hooks/useIsAdmin";

export function useCanManageReceivingCashbooks(): { allowed: boolean; isLoading: boolean } {
  const owner = useIsCompanyOwner();
  const superAdmin = useIsSuperAdmin();
  const allowed = owner.data === true || superAdmin.data === true;
  // Một cờ đã trả "có" là đủ kết luận; chỉ còn "đang tải" khi chưa cờ nào trả "có"
  // mà vẫn còn cờ đang hỏi.
  const isLoading = !allowed && (owner.isLoading || superAdmin.isLoading);
  return { allowed, isLoading };
}
