import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

// --- Types ---

export interface IncomeExpenseTemplate {
  id: string;
  user_id: string;
  code: string;
  name: string;
  description: string | null;
  template_file_url: string | null;
  is_default: boolean;
  is_income_template: boolean;
  field_mappings: Record<string, string> | null;
  created_at: string;
  updated_at: string;
}

// --- Query Hooks ---

export const useIncomeExpenseTemplates = (filterIsIncome?: boolean) => {
  return useQuery({
    queryKey: ["income-expense-templates", filterIsIncome],
    queryFn: async (): Promise<IncomeExpenseTemplate[]> => {
      let query = supabase
        .from("income_expense_templates" as any)
        .select("*")
        .is("deleted_at", null)
        .order("name", { ascending: true });

      if (filterIsIncome !== undefined) {
        query = query.eq("is_income_template", filterIsIncome);
      }

      const { data, error } = await query;

      if (error) {
        console.error("useIncomeExpenseTemplates error:", error);
        return [];
      }

      return (data || []) as unknown as IncomeExpenseTemplate[];
    },
  });
};

// --- Mutation Hooks ---

export const useCreateIncomeExpenseTemplate = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      name: string;
      description?: string | null;
      template_file_url?: string | null;
      is_default?: boolean;
      is_income_template?: boolean;
      field_mappings?: Record<string, string> | null;
    }) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) throw new Error("User not authenticated");

      const { data, error } = await supabase
        .from("income_expense_templates" as any)
        .insert({
          user_id: user.id,
          name: input.name,
          description: input.description ?? null,
          template_file_url: input.template_file_url ?? null,
          is_default: input.is_default ?? false,
          is_income_template: input.is_income_template ?? false,
          field_mappings: input.field_mappings ?? null,
        })
        .select()
        .single();

      if (error) {
        toast.error(error.message || "Không thể tạo mẫu in thu chi");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["income-expense-templates"] });
      toast.success("Mẫu in thu chi đã được TẠO thành công");
    },
    onError: (error) => {
      console.error("Error creating income expense template:", error);
    },
  });
};

export const useUpdateIncomeExpenseTemplate = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      updates,
    }: {
      id: string;
      updates: {
        name?: string;
        description?: string | null;
        template_file_url?: string | null;
        is_default?: boolean;
        is_income_template?: boolean;
        field_mappings?: Record<string, string> | null;
      };
    }) => {
      const { data, error } = await supabase
        .from("income_expense_templates" as any)
        .update(updates)
        .eq("id", id)
        .select()
        .single();

      if (error) {
        toast.error(error.message || "Không thể cập nhật mẫu in thu chi");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["income-expense-templates"] });
      toast.success("Mẫu in thu chi đã được CẬP NHẬT thành công");
    },
    onError: (error) => {
      console.error("Error updating income expense template:", error);
    },
  });
};

export const useDeleteIncomeExpenseTemplate = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("income_expense_templates" as any)
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id);

      if (error) {
        toast.error(error.message || "Không thể xoá mẫu in thu chi");
        throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["income-expense-templates"] });
      toast.success("Mẫu in thu chi đã được XOÁ thành công");
    },
    onError: (error) => {
      console.error("Error deleting income expense template:", error);
    },
  });
};

export const useToggleDefaultTemplate = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      is_default,
      is_income_template,
    }: {
      id: string;
      is_default: boolean;
      is_income_template: boolean;
    }) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) throw new Error("User not authenticated");

      // If setting as default, first unset all other defaults of the same type
      if (is_default) {
        const { error: unsetError } = await supabase
          .from("income_expense_templates" as any)
          .update({ is_default: false })
          .eq("user_id", user.id)
          .eq("is_income_template", is_income_template)
          .is("deleted_at", null);

        if (unsetError) {
          toast.error(unsetError.message || "Không thể cập nhật mẫu mặc định");
          throw unsetError;
        }
      }

      // Set the target template's default status
      const { data, error } = await supabase
        .from("income_expense_templates" as any)
        .update({ is_default })
        .eq("id", id)
        .select()
        .single();

      if (error) {
        toast.error(error.message || "Không thể cập nhật mẫu mặc định");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["income-expense-templates"] });
    },
    onError: (error) => {
      console.error("Error toggling default template:", error);
    },
  });
};
