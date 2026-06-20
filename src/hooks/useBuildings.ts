import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import type { Database } from "@/integrations/supabase/types";
import type { BuildingStatus, BuildingWithRelations } from "@/types/building";
import { STALE_SLOW } from "./queryStale";
import { toast } from "sonner";

type Building = Database["public"]["Tables"]["buildings"]["Row"];
type BuildingInsert = Database["public"]["Tables"]["buildings"]["Insert"];
type BuildingUpdate = Database["public"]["Tables"]["buildings"]["Update"];

// Fetch all buildings with areas (N-N qua area_buildings) and non-deleted rooms count.
// Mặc định ẩn tòa ảo (is_virtual=true) — chỉ form thu/chi mới truyền { includeVirtual: true }
// để cho phép chọn mục "Chung" (tòa ảo đại diện chi phí không thuộc tòa thật).
// queryFn tách thành buildingsQueryOptions để prefetch (HomeLauncher) dùng chung
// đúng queryKey/queryFn với hook → prefetch trúng cache.
export const buildingsQueryOptions = (options?: { includeVirtual?: boolean }) => {
  const includeVirtual = options?.includeVirtual ?? false;
  return {
    queryKey: ["buildings", { includeVirtual }] as const,
    staleTime: STALE_SLOW,
    queryFn: async () => {
      let q = (supabase
        .from("buildings")
        .select(`
          *,
          area_links:area_buildings(area_id, area:areas(id, name, code)),
          rooms:rooms(count)
        `) as any)
        .is("deleted_at", null)
        .is("rooms.deleted_at", null);
      if (!includeVirtual) {
        q = q.eq("is_virtual", false);
      }
      const { data, error } = await q.order("created_at", { ascending: false });

      if (error) {
        console.error('useBuildings error:', error);
        return [];
      }

      // Transform: rooms count + bung membership khu vực thành area_ids/areas
      return ((data || []) as any[]).map(building => ({
        ...building,
        rooms_count: building.rooms?.[0]?.count || 0,
        area_ids: (building.area_links || []).map((l: any) => l.area_id),
        areas: (building.area_links || []).map((l: any) => l.area).filter(Boolean),
      }));
    },
  };
};

export const useBuildings = (options?: { includeVirtual?: boolean }) => {
  return useQuery(buildingsQueryOptions(options));
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
          area_links:area_buildings(area_id, area:areas(id, name, code))
        `)
        .eq("id", id)
        .is("deleted_at", null)
        .single();

      if (error) {
        console.error('useBuilding error:', error);
        return null;
      }

      return data
        ? {
            ...data,
            area_ids: (data.area_links || []).map((l: any) => l.area_id),
            areas: (data.area_links || []).map((l: any) => l.area).filter(Boolean),
          }
        : null;
    },
    enabled: !!id,
  });
};

// Create new building
export const useCreateBuilding = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (building: Omit<BuildingInsert, "user_id">) => {
      const user = await getSessionUser();

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
      const { error } = await supabase
        .from("buildings")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id);

      if (error) {
        toast.error("Không thể xóa tòa nhà");
        throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["buildings"] });
      toast.success("Tòa nhà đã được xóa thành công");
    },
    onError: (error) => {
      console.error("Error deleting building:", error);
    },
  });
};


// Toggle building status with optimistic update
export const useUpdateBuildingStatus = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      status,
    }: {
      id: string;
      status: BuildingStatus;
    }) => {
      const { data, error } = await supabase
        .from("buildings")
        .update({ status })
        .eq("id", id)
        .select()
        .single();

      if (error) {
        toast.error("Không thể cập nhật trạng thái tòa nhà");
        throw error;
      }

      return data;
    },
    onMutate: async ({ id, status }) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: ["buildings"] });

      // Snapshot previous value
      const previousBuildings = queryClient.getQueryData<BuildingWithRelations[]>(["buildings"]);

      // Optimistically update the cache
      queryClient.setQueryData<BuildingWithRelations[]>(["buildings"], (old) =>
        old?.map((b) => (b.id === id ? { ...b, status } : b))
      );

      return { previousBuildings };
    },
    onError: (_error, _variables, context) => {
      // Revert on error
      if (context?.previousBuildings) {
        queryClient.setQueryData(["buildings"], context.previousBuildings);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["buildings"] });
    },
    onSuccess: () => {
      toast.success("Trạng thái tòa nhà đã được cập nhật thành công");
    },
  });
};
