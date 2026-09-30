import { friendlyError } from "@/lib/friendlyError";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
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
        throw error;
      }

      if (!Array.isArray(data)) throw new TypeError("Invalid category list response");
      return data;
    },
  });
};

export const useCreateAssetWarehouse = (options?: {inlineError?:boolean}) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (warehouse: Omit<AssetWarehouseInsert, "user_id">) => {
      const user = await getSessionUser();

      if (!user) throw new Error("User not authenticated");

      const { data, error } = await supabase
        .from("asset_warehouses")
        .insert({ ...warehouse, user_id: user.id })
        .select()
        .single();

      if (error) throw error;
      if (!data || typeof data.id !== "string" || !data.id) throw new TypeError("Unconfirmed category result");

      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["asset_warehouses"] });
      toast.success(`Đã tạo kho tài sản ${data.name}.`);
    },
    onError: (error) => {
      if (options?.inlineError) return;
      console.error("Error creating asset warehouse:", error);
      const feedback = friendlyError(error, "Chưa tạo được kho tài sản", { operation: "tạo kho tài sản" });
      toast.error(feedback.title, { description: feedback.description });
    },
  });
};

export const useUpdateAssetWarehouse = (options?: {inlineError?:boolean}) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: AssetWarehouseUpdate }) => {
      const { data, error } = await supabase
        .from("asset_warehouses")
        .update(updates)
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;
      if (!data || data.id !== id) throw new TypeError("Unconfirmed category result");

      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["asset_warehouses"] });
      toast.success(`Đã lưu thay đổi kho tài sản ${data.name}.`);
    },
    onError: (error) => {
      if (options?.inlineError) return;
      console.error("Error updating asset warehouse:", error);
      const feedback = friendlyError(error, "Chưa lưu thay đổi được kho tài sản", { operation: "lưu thay đổi kho tài sản" });
      toast.error(feedback.title, { description: feedback.description });
    },
  });
};

export const useDeleteAssetWarehouse = (options?: {inlineError?:boolean}) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase
        .from("asset_warehouses")
        .delete()
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;
      if (!data || data.id !== id) throw new TypeError("Unconfirmed category result");

      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["asset_warehouses"] });
      toast.success(`Đã xóa kho tài sản ${data.name}.`);
    },
    onError: (error) => {
      if (options?.inlineError) return;
      console.error("Error deleting asset warehouse:", error);
      const feedback = friendlyError(error, "Chưa xóa được kho tài sản", { operation: "xóa kho tài sản" });
      toast.error(feedback.title, { description: feedback.description });
    },
  });
};
