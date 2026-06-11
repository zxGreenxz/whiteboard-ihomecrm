import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import type { Database, Json } from "@/integrations/supabase/types";
import { toast } from "sonner";

type Role = Database["public"]["Tables"]["roles"]["Row"];
type RoleInsert = Database["public"]["Tables"]["roles"]["Insert"];
type RoleUpdate = Database["public"]["Tables"]["roles"]["Update"];

export const useRoles = () => {
  return useQuery({
    queryKey: ["roles"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("roles")
        .select("*")
        .order("name", { ascending: true });

      if (error) {
        console.error("useRoles error:", error);
        return [];
      }

      return data || [];
    },
  });
};

export const useRole = (id: string) => {
  return useQuery({
    queryKey: ["roles", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("roles")
        .select("*")
        .eq("id", id)
        .single();

      if (error) {
        console.error("useRole error:", error);
        return null;
      }

      return data;
    },
    enabled: !!id,
  });
};

export const useCreateRole = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (role: Omit<RoleInsert, "user_id">) => {
      const user = await getSessionUser();

      if (!user) throw new Error("User not authenticated");

      const { data, error } = await supabase
        .from("roles")
        .insert({ ...role, user_id: user.id })
        .select()
        .single();

      if (error) {
        toast.error("Không thể tạo vai trò");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["roles"] });
      toast.success("Vai trò đã được tạo thành công");
    },
    onError: (error) => {
      console.error("Error creating role:", error);
    },
  });
};

export const useUpdateRole = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: RoleUpdate }) => {
      const { data, error } = await supabase
        .from("roles")
        .update(updates)
        .eq("id", id)
        .select()
        .single();

      if (error) {
        toast.error("Không thể cập nhật vai trò");
        throw error;
      }

      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["roles"] });
      queryClient.invalidateQueries({ queryKey: ["roles", data.id] });
      toast.success("Vai trò đã được cập nhật thành công");
    },
    onError: (error) => {
      console.error("Error updating role:", error);
    },
  });
};

export const useDeleteRole = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      // Check if role is assigned to any staff
      const { data: assignments, error: checkError } = await supabase
        .from("staff_assignments")
        .select("id")
        .eq("role_id", id);

      if (checkError) {
        toast.error("Không thể kiểm tra vai trò");
        throw checkError;
      }

      if (assignments && assignments.length > 0) {
        toast.error(`Không thể xóa vai trò đang được gán cho ${assignments.length} nhân viên`);
        throw new Error("Role is in use");
      }

      const { data, error } = await supabase
        .from("roles")
        .delete()
        .eq("id", id)
        .select()
        .single();

      if (error) {
        toast.error("Không thể xóa vai trò");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["roles"] });
      toast.success("Vai trò đã được xóa thành công");
    },
    onError: (error) => {
      console.error("Error deleting role:", error);
    },
  });
};
