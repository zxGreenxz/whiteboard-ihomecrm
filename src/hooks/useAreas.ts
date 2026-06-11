import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import type { Database } from "@/integrations/supabase/types";
import { toast } from "sonner";

type AreaInsert = Database["public"]["Tables"]["areas"]["Insert"];
type AreaUpdate = Database["public"]["Tables"]["areas"]["Update"];

// Fetch all areas with buildings count
export const useAreas = () => {
  return useQuery({
    queryKey: ["areas"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("areas")
        .select(`
          *,
          members:area_buildings(count)
        `)
        .is("deleted_at", null)
        .order("created_at", { ascending: false });

      if (error) {
        console.error('useAreas error:', error);
        return [];
      }

      return (data || []).map(area => ({
        ...area,
        buildings_count: area.members?.[0]?.count || 0
      }));
    },
  });
};

// Fetch single area by ID
export const useArea = (id: string) => {
  return useQuery({
    queryKey: ["areas", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("areas")
        .select(`*`)
        .eq("id", id)
        .is("deleted_at", null)
        .single();

      if (error) {
        console.error('useArea error:', error);
        return null;
      }

      return data;
    },
    enabled: !!id,
  });
};

// Create new area
export const useCreateArea = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (area: Omit<AreaInsert, "user_id">) => {
      const user = await getSessionUser();

      if (!user) {
        throw new Error("User not authenticated");
      }

      const { data, error } = await supabase
        .from("areas")
        .insert({
          ...area,
          user_id: user.id,
        })
        .select()
        .single();

      if (error) {
        if (error.code === "23505") {
          toast.error("Mã khu vực đã tồn tại");
        } else {
          toast.error("Không thể tạo khu vực");
        }
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["areas"] });
      toast.success("Khu vực đã được tạo thành công");
    },
    onError: (error) => {
      console.error("Error creating area:", error);
    },
  });
};

// Update existing area
export const useUpdateArea = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      updates,
    }: {
      id: string;
      updates: AreaUpdate;
    }) => {
      const { data, error } = await supabase
        .from("areas")
        .update(updates)
        .eq("id", id)
        .select()
        .single();

      if (error) {
        if (error.code === "23505") {
          toast.error("Mã khu vực đã tồn tại");
        } else {
          toast.error("Không thể cập nhật khu vực");
        }
        throw error;
      }

      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["areas"] });
      queryClient.invalidateQueries({ queryKey: ["areas", data.id] });
      toast.success("Khu vực đã được cập nhật thành công");
    },
    onError: (error) => {
      console.error("Error updating area:", error);
    },
  });
};

// Assign/unassign buildings to an area — N-N qua area_buildings:
// 1 toà có thể thuộc nhiều khu, gán/gỡ chỉ chạm join rows của khu đang sửa.
export const useAssignBuildingsToArea = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      areaId,
      toAddIds,
      toRemoveIds,
    }: {
      areaId: string;
      toAddIds: string[];
      toRemoveIds: string[];
    }) => {
      if (toRemoveIds.length > 0) {
        const { error } = await supabase
          .from("area_buildings")
          .delete()
          .eq("area_id", areaId)
          .in("building_id", toRemoveIds);
        if (error) {
          toast.error("Không thể bỏ tòa nhà khỏi khu vực");
          throw error;
        }
      }
      if (toAddIds.length > 0) {
        const user = await getSessionUser();
        const rows = toAddIds.map((building_id) => ({
          area_id: areaId,
          building_id,
          user_id: user!.id,
        }));
        const { error } = await supabase
          .from("area_buildings")
          .upsert(rows, { onConflict: "area_id,building_id", ignoreDuplicates: true });
        if (error) {
          toast.error("Không thể gán tòa nhà vào khu vực");
          throw error;
        }
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["buildings"] });
      queryClient.invalidateQueries({ queryKey: ["areas"] });
      // Scope nhân viên gán theo khu là LIVE → membership đổi ảnh hưởng hiển thị phạm vi
      queryClient.invalidateQueries({ queryKey: ["staff_assignments"] });
    },
    onError: (error) => {
      console.error("Error assigning buildings to area:", error);
    },
  });
};

// Soft delete area — khu vực chỉ là NHÃN NHÓM toà: xoá khu thì gỡ nhãn khỏi
// các toà (toà vẫn giữ các khu khác). Riêng khu đang được dùng làm PHẠM VI
// phân quyền nhân viên (staff_assignments.area_id) thì DB chặn (trigger
// AREA_IN_STAFF_SCOPE) — phải gỡ phân quyền trước, tránh nâng quyền nhầm.
export const useDeleteArea = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      // Soft delete trước — nếu khu đang là phạm vi phân quyền thì trigger DB
      // chặn ngay tại đây, membership chưa bị gỡ (không mất dữ liệu nhóm).
      const { error } = await supabase
        .from("areas")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id);

      if (error) {
        if (error.message?.includes("AREA_IN_STAFF_SCOPE")) {
          toast.error(
            "Khu vực đang được dùng làm phạm vi phân quyền nhân viên — gỡ phân quyền trước khi xoá."
          );
        } else {
          toast.error("Không thể xóa khu vực");
        }
        throw error;
      }

      // Gỡ membership (join rows) — toà về "Chưa phân khu" nếu không còn khu khác
      const { error: unassignError } = await supabase
        .from("area_buildings")
        .delete()
        .eq("area_id", id);

      if (unassignError) {
        toast.error("Không thể gỡ toà nhà khỏi khu vực");
        throw unassignError;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["areas"] });
      queryClient.invalidateQueries({ queryKey: ["buildings"] });
      queryClient.invalidateQueries({ queryKey: ["staff_assignments"] });
      toast.success("Khu vực đã được xóa thành công");
    },
    onError: (error) => {
      console.error("Error deleting area:", error);
    },
  });
};
