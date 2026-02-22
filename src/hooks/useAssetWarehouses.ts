import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { toast } from "sonner";

type AssetWarehouse = Database["public"]["Tables"]["asset_warehouses"]["Row"];
type AssetWarehouseInsert = Database["public"]["Tables"]["asset_warehouses"]["Insert"];
type AssetWarehouseUpdate = Database["public"]["Tables"]["asset_warehouses"]["Update"];

export const useAssetWarehouses = (buildingId?: string) => {
  return useQuery({
    queryKey: ["asset_warehouses", buildingId],
    queryFn: async () => {
      let query = supabase
        .from("asset_warehouses")
        .select("*")
        .order("name", { ascending: true });

      if (buildingId) {
        query = query.eq("building_id", buildingId);
      }

      const { data, error } = await query;

      if (error) {
        console.error("useAssetWarehouses error:", error);
        return [];
      }

      return data || [];
    },
  });
};

export const useCreateAssetWarehouse = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (warehouse: Omit<AssetWarehouseInsert, "user_id">) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) throw new Error("User not authenticated");

      const { data, error } = await supabase
        .from("asset_warehouses")
        .insert({ ...warehouse, user_id: user.id })
        .select()
        .single();

      if (error) {
        toast.error("Không thể tạo kho tài sản");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["asset_warehouses"] });
      toast.success("Kho tài sản đã được tạo thành công");
    },
    onError: (error) => {
      console.error("Error creating asset warehouse:", error);
    },
  });
};

export const useUpdateAssetWarehouse = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: AssetWarehouseUpdate }) => {
      const { data, error } = await supabase
        .from("asset_warehouses")
        .update(updates)
        .eq("id", id)
        .select()
        .single();

      if (error) {
        toast.error("Không thể cập nhật kho tài sản");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["asset_warehouses"] });
      toast.success("Kho tài sản đã được cập nhật thành công");
    },
    onError: (error) => {
      console.error("Error updating asset warehouse:", error);
    },
  });
};

export const useDeleteAssetWarehouse = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase
        .from("asset_warehouses")
        .delete()
        .eq("id", id)
        .select()
        .single();

      if (error) {
        toast.error("Không thể xóa kho tài sản");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["asset_warehouses"] });
      toast.success("Kho tài sản đã được xóa thành công");
    },
    onError: (error) => {
      console.error("Error deleting asset warehouse:", error);
    },
  });
};
