import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { toast } from "sonner";

type IncomeExpenseType = Database["public"]["Tables"]["income_expense_types"]["Row"];
type IncomeExpenseTypeInsert = Database["public"]["Tables"]["income_expense_types"]["Insert"];
type IncomeExpenseTypeUpdate = Database["public"]["Tables"]["income_expense_types"]["Update"];

export const useIncomeExpenseTypes = (filterType?: "income" | "expense") => {
  return useQuery({
    queryKey: ["income_expense_types", filterType],
    queryFn: async () => {
      let query = supabase
        .from("income_expense_types")
        .select("*")
        .order("name", { ascending: true });

      if (filterType) {
        query = query.eq("type", filterType);
      }

      const { data, error } = await query;

      if (error) {
        console.error("useIncomeExpenseTypes error:", error);
        return [];
      }

      return data || [];
    },
  });
};

export const useCreateIncomeExpenseType = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (item: Omit<IncomeExpenseTypeInsert, "user_id">) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) throw new Error("User not authenticated");

      const { data, error } = await supabase
        .from("income_expense_types")
        .insert({ ...item, user_id: user.id })
        .select()
        .single();

      if (error) {
        toast.error("Không thể tạo loại thu chi");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["income_expense_types"] });
      toast.success("Loại thu chi đã được tạo thành công");
    },
    onError: (error) => {
      console.error("Error creating income expense type:", error);
    },
  });
};

export const useUpdateIncomeExpenseType = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: IncomeExpenseTypeUpdate }) => {
      const { data, error } = await supabase
        .from("income_expense_types")
        .update(updates)
        .eq("id", id)
        .select()
        .single();

      if (error) {
        toast.error("Không thể cập nhật loại thu chi");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["income_expense_types"] });
      toast.success("Loại thu chi đã được cập nhật thành công");
    },
    onError: (error) => {
      console.error("Error updating income expense type:", error);
    },
  });
};

export const useDeleteIncomeExpenseType = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase
        .from("income_expense_types")
        .delete()
        .eq("id", id)
        .select()
        .single();

      if (error) {
        toast.error("Không thể xóa loại thu chi");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["income_expense_types"] });
      toast.success("Loại thu chi đã được xóa thành công");
    },
    onError: (error) => {
      console.error("Error deleting income expense type:", error);
    },
  });
};
