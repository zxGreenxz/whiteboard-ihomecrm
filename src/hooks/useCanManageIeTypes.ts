// Ai được thêm / sửa / gộp / lưu trữ hạng mục thu chi: SUPERADMIN hoặc CHỦ CÔNG TY
// (chủ duyệt 03/10/2026). Đây là cờ HIỂN THỊ — hàng rào thật là policy RESTRICTIVE
// income_expense_types_editor_* dùng public.ie_type_rule_editor_ok_v1(organization_id)
// (migration 20261003151606_danh_muc_chi_cau_truc). Quản lý toà vẫn xem được danh mục.
import { useIsCompanyOwner } from "@/hooks/useIsCompanyOwner";
import { useIsSuperAdmin } from "@/hooks/useIsAdmin";

export function useCanManageIeTypes(): { canManage: boolean; isLoading: boolean } {
  const owner = useIsCompanyOwner();
  const superAdmin = useIsSuperAdmin();
  return {
    canManage: owner.data === true || superAdmin.data === true,
    isLoading: owner.isLoading || superAdmin.isLoading,
  };
}
