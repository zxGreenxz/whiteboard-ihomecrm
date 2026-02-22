import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { toast } from "sonner";

type AutoDebtConfig = Database["public"]["Tables"]["auto_debt_config"]["Row"];
type AutoDebtConfigInsert = Database["public"]["Tables"]["auto_debt_config"]["Insert"];
type AutoDebtConfigUpdate = Database["public"]["Tables"]["auto_debt_config"]["Update"];

export const useAutoDebtConfigs = (buildingId?: string) => {
  return useQuery({
    queryKey: ["auto_debt_config", buildingId],
    queryFn: async () => {
      let query = supabase
        .from("auto_debt_config")
        .select("*")
        .order("created_at", { ascending: false });

      if (buildingId) {
        query = query.eq("building_id", buildingId);
      }

      const { data, error } = await query;

      if (error) {
        console.error("useAutoDebtConfigs error:", error);
        return [];
      }

      return data || [];
    },
  });
};

export const useCreateAutoDebtConfig = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (config: Omit<AutoDebtConfigInsert, "user_id">) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) throw new Error("User not authenticated");

      const { data, error } = await supabase
        .from("auto_debt_config")
        .insert({ ...config, user_id: user.id })
        .select()
        .single();

      if (error) {
        toast.error("Không thể tạo cấu hình gạch nợ tự động");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["auto_debt_config"] });
      toast.success("Cấu hình gạch nợ tự động đã được tạo thành công");
    },
    onError: (error) => {
      console.error("Error creating auto debt config:", error);
    },
  });
};

export const useUpdateAutoDebtConfig = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: AutoDebtConfigUpdate }) => {
      const { data, error } = await supabase
        .from("auto_debt_config")
        .update(updates)
        .eq("id", id)
        .select()
        .single();

      if (error) {
        toast.error("Không thể cập nhật cấu hình gạch nợ tự động");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["auto_debt_config"] });
      toast.success("Cấu hình gạch nợ tự động đã được cập nhật thành công");
    },
    onError: (error) => {
      console.error("Error updating auto debt config:", error);
    },
  });
};

export const useDeleteAutoDebtConfig = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase
        .from("auto_debt_config")
        .delete()
        .eq("id", id)
        .select()
        .single();

      if (error) {
        toast.error("Không thể xóa cấu hình gạch nợ tự động");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["auto_debt_config"] });
      toast.success("Cấu hình gạch nợ tự động đã được xóa thành công");
    },
    onError: (error) => {
      console.error("Error deleting auto debt config:", error);
    },
  });
};
