import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

// Mirror SQL function public.is_super_admin().
// Trả true khi auth.uid() thuộc bảng super_admins (xem migration
// 20260506000003_super_admin_tier.sql).
// Super admin bypass toàn bộ RLS + toàn bộ logic phân quyền chi tiết.
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

// Trả về Set các user_id là super admin. RLS chỉ cho super admin đọc
// bảng super_admins → user thường sẽ nhận về Set rỗng.
// Dùng để dialog phân quyền hiển thị banner cảnh báo khi target là super admin
// (vì override không có hiệu lực — super admin bypass tất cả).
export const useSuperAdminUserIds = () => {
  return useQuery({
    queryKey: ["super_admins", "ids"],
    queryFn: async (): Promise<Set<string>> => {
      const { data, error } = await (supabase as any)
        .from("super_admins")
        .select("user_id");
      if (error) {
        console.error("useSuperAdminUserIds error:", error);
        return new Set();
      }
      return new Set(((data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id));
    },
    staleTime: 5 * 60 * 1000,
  });
};
