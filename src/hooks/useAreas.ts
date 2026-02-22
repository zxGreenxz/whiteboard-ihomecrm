import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
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
          buildings:buildings(count)
        `)
        .is("deleted_at", null)
        .order("created_at", { ascending: false });

      if (error) {
        console.error('useAreas error:', error);
        return [];
      }

      return (data || []).map(area => ({
        ...area,
        buildings_count: area.buildings?.[0]?.count || 0
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
      const {
        data: { user },
      } = await supabase.auth.getUser();

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

// Soft delete area
export const useDeleteArea = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      // First check if area has buildings
      const { data: buildings, error: checkError } = await supabase
        .from("buildings")
        .select("id")
        .eq("area_id", id)
        .is("deleted_at", null);

      if (checkError) {
        toast.error("Không thể kiểm tra khu vực");
        throw checkError;
      }

      if (buildings && buildings.length > 0) {
        toast.error(
          `Không thể xóa khu vực đang có ${buildings.length} tòa nhà`
        );
        throw new Error("Area has buildings");
      }

      // Soft delete
      const { error } = await supabase
        .from("areas")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id);

      if (error) {
        toast.error("Không thể xóa khu vực");
        throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["areas"] });
      toast.success("Khu vực đã được xóa thành công");
    },
    onError: (error) => {
      console.error("Error deleting area:", error);
    },
  });
};
