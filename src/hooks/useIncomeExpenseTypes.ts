import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

// --- Types ---

export interface IncomeExpenseType {
  id: string;
  user_id: string;
  name: string;
  type: "income" | "expense";
  description: string | null;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

// --- Query Hooks ---

export const useIncomeExpenseTypes = (filterType?: "income" | "expense") => {
  return useQuery({
    queryKey: ["income-expense-types", filterType],
    queryFn: async (): Promise<IncomeExpenseType[]> => {
      // Filter by current user explicitly. RLS policies (super_admin, staff
      // visibility) would otherwise return rows from multiple owners, causing
      // identically-named seeded types (e.g. "Hoa hồng môi giới") to appear
      // as duplicates in the picker UI.
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return [];

      let query = supabase
        .from("income_expense_types" as any)
        .select("*")
        .eq("user_id", user.id)
        .order("name", { ascending: true });

      if (filterType) {
        query = query.eq("type", filterType);
      }

      const { data, error } = await query;

      if (error) {
        console.error("useIncomeExpenseTypes error:", error);
        return [];
      }

      return (data || []) as unknown as IncomeExpenseType[];
    },
  });
};

// --- Mutation Hooks ---

export const useCreateIncomeExpenseType = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      name: string;
      type: "income" | "expense";
      description?: string | null;
      is_default?: boolean;
    }) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) throw new Error("User not authenticated");

      const { data, error } = await supabase
        .from("income_expense_types" as any)
        .insert({
          user_id: user.id,
          name: input.name,
          type: input.type,
          description: input.description ?? null,
          is_default: input.is_default ?? false,
        })
        .select()
        .single();

      if (error) {
        toast.error(error.message || "Không thể tạo loại thu chi");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["income-expense-types"] });
      toast.success("Loại thu chi đã được TẠO thành công");
    },
    onError: (error) => {
      console.error("Error creating income expense type:", error);
    },
  });
};

export const useUpdateIncomeExpenseType = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      updates,
    }: {
      id: string;
      updates: {
        name?: string;
        type?: "income" | "expense";
        description?: string | null;
        is_default?: boolean;
      };
    }) => {
      const { data, error } = await supabase
        .from("income_expense_types" as any)
        .update(updates)
        .eq("id", id)
        .select()
        .single();

      if (error) {
        toast.error(error.message || "Không thể cập nhật loại thu chi");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["income-expense-types"] });
      toast.success("Loại thu chi đã được CẬP NHẬT thành công");
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
      // Check if type is being used by income_expense_items
      const { data: usageCheck, error: usageError } = await supabase
        .from("income_expense_items" as any)
        .select("id")
        .eq("income_expense_type_id", id)
        .limit(1);

      if (usageError) {
        console.error("Error checking type usage:", usageError);
        throw usageError;
      }

      if (usageCheck && usageCheck.length > 0) {
        toast.error(
          "Không thể xoá loại thu chi đang được sử dụng bởi phiếu thu/chi"
        );
        throw new Error(
          "Không thể xoá loại thu chi đang được sử dụng bởi phiếu thu/chi"
        );
      }

      const { error } = await supabase
        .from("income_expense_types" as any)
        .delete()
        .eq("id", id);

      if (error) {
        toast.error(error.message || "Không thể xoá loại thu chi");
        throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["income-expense-types"] });
      toast.success("Loại thu chi đã được XOÁ thành công");
    },
    onError: (error) => {
      console.error("Error deleting income expense type:", error);
    },
  });
};
