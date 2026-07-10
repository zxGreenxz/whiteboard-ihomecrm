import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface AssignablePerson {
  id: string;
  full_name: string | null;
}

// Hook canonical: danh sách người CÓ THỂ được giao việc / bảo trì
// ("người nhận" / assignee). RLS trên profiles tự lọc phạm vi:
//   • admin (is_admin) thấy tất cả profiles
//   • user thường chỉ thấy chính mình + staff mình quản lý / manager của mình
//
// queryKey ["profiles", "assignable"] được scope-qualify để KHÔNG đụng cache
// với các query profiles khác scope (vd query self-only ["profiles","self"],
// hay staff list ["staff_users"]). Trước đây dùng chung key ["profiles"] gây
// nhiễm chéo cache: kết quả một scope tràn sang picker của scope khác.
export const useAssignablePeople = () => {
  return useQuery({
    queryKey: ["profiles", "assignable"],
    queryFn: async (): Promise<AssignablePerson[]> => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name")
        .order("full_name");

      if (error) {
        console.error("useAssignablePeople error:", error);
        return [];
      }

      return data || [];
    },
  });
};
