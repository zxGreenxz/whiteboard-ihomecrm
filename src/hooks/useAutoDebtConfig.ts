import { friendlyError } from "@/lib/friendlyError";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
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
        throw error;
      }

      if (!Array.isArray(data)) throw new TypeError("Invalid category list response");
      return data;
    },
  });
};

export const useCreateAutoDebtConfig = (options?: {inlineError?:boolean}) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (config: Omit<AutoDebtConfigInsert, "user_id">) => {
      const user = await getSessionUser();

      if (!user) throw new Error("User not authenticated");

      const { data, error } = await supabase
        .from("auto_debt_config")
        .insert({ ...config, user_id: user.id })
        .select()
        .single();

      if (error) throw error;
      if (!data || typeof data.id !== "string" || !data.id) throw new TypeError("Unconfirmed category result");

      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["auto_debt_config"] });
      toast.success(`Đã tạo cấu hình gạch nợ ${data.bank_account}.`);
    },
    onError: (error) => {
      if (options?.inlineError) return;
      console.error("Error creating auto debt config:", error);
      const feedback = friendlyError(error, "Chưa tạo được cấu hình gạch nợ", { operation: "tạo cấu hình gạch nợ" });
      toast.error(feedback.title, { description: feedback.description });
    },
  });
};

export const useUpdateAutoDebtConfig = (options?: {inlineError?:boolean}) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: AutoDebtConfigUpdate }) => {
      const { data, error } = await supabase
        .from("auto_debt_config")
        .update(updates)
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;
      if (!data || data.id !== id) throw new TypeError("Unconfirmed category result");

      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["auto_debt_config"] });
      toast.success(`Đã lưu thay đổi cấu hình gạch nợ ${data.bank_account}.`);
    },
    onError: (error) => {
      if (options?.inlineError) return;
      console.error("Error updating auto debt config:", error);
      const feedback = friendlyError(error, "Chưa lưu thay đổi được cấu hình gạch nợ", { operation: "lưu thay đổi cấu hình gạch nợ" });
      toast.error(feedback.title, { description: feedback.description });
    },
  });
};

export const useDeleteAutoDebtConfig = (options?: {inlineError?:boolean}) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase
        .from("auto_debt_config")
        .delete()
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;
      if (!data || data.id !== id) throw new TypeError("Unconfirmed category result");

      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["auto_debt_config"] });
      toast.success(`Đã xóa cấu hình gạch nợ ${data.bank_account}.`);
    },
    onError: (error) => {
      if (options?.inlineError) return;
      console.error("Error deleting auto debt config:", error);
      const feedback = friendlyError(error, "Chưa xóa được cấu hình gạch nợ", { operation: "xóa cấu hình gạch nợ" });
      toast.error(feedback.title, { description: feedback.description });
    },
  });
};
