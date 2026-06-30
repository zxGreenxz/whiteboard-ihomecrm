import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/**
 * Mirror của SQL function `public.is_admin()` (xem migration
 * 20260506000002_admin_bypass_rls.sql).
 *
 * Trả về true khi current user có ít nhất 1 staff_assignment với role thoả:
 *   - role.permissions @> '{"__superadmin": true}', HOẶC
 *   - role.name = 'Admin'
 *
 * Dùng để mở khoá UI cho super admin (vd cho phép sửa phiếu thu/chi của bất
 * kỳ ai ở bất kỳ trạng thái — RLS đã bypass cho admin nên server đã sẵn sàng).
 */
export const useIsAdmin = () => {
  return useQuery({
    queryKey: ["auth", "is_admin"],
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await (supabase as any).rpc("is_admin");
      if (error) {
        console.error("useIsAdmin error:", error);
        return false;
      }
      return !!data;
    },
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
};

/**
 * Mirror của SQL `public.is_super_admin()` (migration
 * 20260506000003_super_admin_tier.sql): true khi auth.uid() ∈ super_admins.
 *
 * KHÁC `useIsAdmin` (gồm cả role Admin của tenant): đây là tier cao nhất,
 * cross-tenant. Dùng để gate đúng các thao tác CHỈ super admin (vd khôi phục
 * phiếu thu/chi đã huỷ) — khớp chính xác guard của RPC restore_income_expense,
 * tránh hiện nút cho người mà RPC sẽ từ chối.
 */
export const useIsSuperAdmin = () => {
  return useQuery({
    queryKey: ["auth", "is_super_admin"],
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await (supabase as any).rpc("is_super_admin");
      if (error) {
        console.error("useIsSuperAdmin error:", error);
        return false;
      }
      return !!data;
    },
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
};
