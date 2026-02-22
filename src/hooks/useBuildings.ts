import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { toast } from "sonner";

type Building = Database["public"]["Tables"]["buildings"]["Row"];
type BuildingInsert = Database["public"]["Tables"]["buildings"]["Insert"];
type BuildingUpdate = Database["public"]["Tables"]["buildings"]["Update"];

// Fetch all buildings with area info
export const useBuildings = () => {
  return useQuery({
    queryKey: ["buildings"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("buildings")
        .select(`
          *,
          area:areas(id, name, code),
          rooms:rooms(count)
        `)
        .is("deleted_at", null)
        .order("created_at", { ascending: false });

      if (error) {
        console.error('useBuildings error:', error);
        return [];
      }

      // Transform data to include rooms count
      return (data || []).map(building => ({
        ...building,
        rooms_count: building.rooms?.[0]?.count || 0
      }));
    },
  });
};

// Fetch single building by ID
export const useBuilding = (id: string) => {
  return useQuery({
    queryKey: ["buildings", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("buildings")
        .select(`
          *,
          area:areas(id, name, code)
        `)
        .eq("id", id)
        .is("deleted_at", null)
        .single();

      if (error) {
        console.error('useBuilding error:', error);
        return null;
      }

      return data;
    },
    enabled: !!id,
  });
};

// Create new building
export const useCreateBuilding = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (building: Omit<BuildingInsert, "user_id">) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        throw new Error("User not authenticated");
      }

      const { data, error } = await supabase
        .from("buildings")
        .insert({
          ...building,
          user_id: user.id,
        })
        .select()
        .single();

      if (error) {
        if (error.code === "23505") {
          toast.error("Mã tòa nhà đã tồn tại");
        } else if (error.code === "23503") {
          toast.error("Dữ liệu liên kết không tồn tại");
        } else {
          toast.error("Không thể tạo tòa nhà");
        }
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["buildings"] });
      queryClient.invalidateQueries({ queryKey: ["areas"] }); // Update buildings count in areas
      toast.success("Tòa nhà đã được tạo thành công");
    },
    onError: (error) => {
      console.error("Error creating building:", error);
    },
  });
};

// Update existing building
export const useUpdateBuilding = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      updates,
    }: {
      id: string;
      updates: BuildingUpdate;
    }) => {
      const { data, error } = await supabase
        .from("buildings")
        .update(updates)
        .eq("id", id)
        .select()
        .single();

      if (error) {
        if (error.code === "23505") {
          toast.error("Mã tòa nhà đã tồn tại");
        } else if (error.code === "23503") {
          toast.error("Dữ liệu liên kết không tồn tại");
        } else {
          toast.error("Không thể cập nhật tòa nhà");
        }
        throw error;
      }

      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["buildings"] });
      queryClient.invalidateQueries({ queryKey: ["buildings", data.id] });
      queryClient.invalidateQueries({ queryKey: ["areas"] });
      toast.success("Tòa nhà đã được cập nhật thành công");
    },
    onError: (error) => {
      console.error("Error updating building:", error);
    },
  });
};

// Soft delete building
export const useDeleteBuilding = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      // First check if building has rooms
      const { data: rooms, error: checkError } = await supabase
        .from("rooms")
        .select("id")
        .eq("building_id", id)
        .is("deleted_at", null);

      if (checkError) {
        toast.error("Không thể kiểm tra tòa nhà");
        throw checkError;
      }

      if (rooms && rooms.length > 0) {
        toast.error(
          `Không thể xóa tòa nhà đang có ${rooms.length} căn hộ`
        );
        throw new Error("Building has rooms");
      }

      // Soft delete
      const { data, error } = await supabase
        .from("buildings")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id)
        .select()
        .single();

      if (error) {
        toast.error("Không thể xóa tòa nhà");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["buildings"] });
      queryClient.invalidateQueries({ queryKey: ["areas"] });
      toast.success("Tòa nhà đã được xóa thành công");
    },
    onError: (error) => {
      console.error("Error deleting building:", error);
    },
  });
};
