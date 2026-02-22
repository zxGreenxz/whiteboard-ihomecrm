import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { toast } from "sonner";

type StaffAssignment = Database["public"]["Tables"]["staff_assignments"]["Row"];
type StaffAssignmentInsert = Database["public"]["Tables"]["staff_assignments"]["Insert"];
type StaffAssignmentUpdate = Database["public"]["Tables"]["staff_assignments"]["Update"];

export const useStaffAssignments = () => {
  return useQuery({
    queryKey: ["staff_assignments"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("staff_assignments")
        .select(`
          *,
          role:roles(id, name, permissions),
          building:buildings(id, name)
        `)
        .order("created_at", { ascending: false });

      if (error) {
        console.error("useStaffAssignments error:", error);
        return [];
      }

      return data || [];
    },
  });
};

export const useStaffAssignmentsByStaff = (staffId: string) => {
  return useQuery({
    queryKey: ["staff_assignments", "staff", staffId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("staff_assignments")
        .select(`
          *,
          role:roles(id, name, permissions),
          building:buildings(id, name)
        `)
        .eq("staff_id", staffId)
        .order("created_at", { ascending: false });

      if (error) {
        console.error("useStaffAssignmentsByStaff error:", error);
        return [];
      }

      return data || [];
    },
    enabled: !!staffId,
  });
};

export const useCreateStaffAssignment = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (assignment: Omit<StaffAssignmentInsert, "user_id">) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) throw new Error("User not authenticated");

      const { data, error } = await supabase
        .from("staff_assignments")
        .insert({ ...assignment, user_id: user.id })
        .select()
        .single();

      if (error) {
        if (error.code === "23505") {
          toast.error("Nhân viên đã được gán cho toà nhà này");
        } else {
          toast.error("Không thể gán nhân viên");
        }
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["staff_assignments"] });
      toast.success("Nhân viên đã được gán thành công");
    },
    onError: (error) => {
      console.error("Error creating staff assignment:", error);
    },
  });
};

export const useUpdateStaffAssignment = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: StaffAssignmentUpdate }) => {
      const { data, error } = await supabase
        .from("staff_assignments")
        .update(updates)
        .eq("id", id)
        .select()
        .single();

      if (error) {
        if (error.code === "23505") {
          toast.error("Nhân viên đã được gán cho toà nhà này");
        } else {
          toast.error("Không thể cập nhật phân quyền");
        }
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["staff_assignments"] });
      toast.success("Phân quyền đã được cập nhật thành công");
    },
    onError: (error) => {
      console.error("Error updating staff assignment:", error);
    },
  });
};

export const useDeleteStaffAssignment = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase
        .from("staff_assignments")
        .delete()
        .eq("id", id)
        .select()
        .single();

      if (error) {
        toast.error("Không thể xóa phân quyền");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["staff_assignments"] });
      toast.success("Phân quyền đã được xóa thành công");
    },
    onError: (error) => {
      console.error("Error deleting staff assignment:", error);
    },
  });
};
