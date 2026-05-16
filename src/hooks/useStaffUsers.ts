import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface StaffUser {
  id: string;
  full_name: string | null;
  email: string | null;
  is_active: boolean | null;
}

// Dùng cho các dropdown "chọn người phụ trách" (sổ quỹ, jobs, …).
// RLS của profiles tự lọc:
//   • admin (is_admin) thấy tất cả profiles
//   • user thường chỉ thấy chính mình + staff mà mình quản lý / manager của mình
export const useStaffUsers = () => {
  return useQuery({
    queryKey: ["staff_users"],
    queryFn: async (): Promise<StaffUser[]> => {
      const { data, error } = await (supabase
        .from("profiles")
        .select("id, full_name, email, is_active" as any) as any)
        .order("full_name", { ascending: true });

      if (error) {
        console.error("useStaffUsers error", error);
        return [];
      }

      return ((data || []) as any[]).filter((p) => p.is_active !== false) as StaffUser[];
    },
    staleTime: 5 * 60 * 1000,
  });
};
