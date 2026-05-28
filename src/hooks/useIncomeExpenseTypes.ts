import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

// --- Types ---

export interface IncomeExpenseType {
  id: string;
  user_id: string;
  name: string;
  type: "income" | "expense";
  category: string | null;
  description: string | null;
  is_default: boolean;
  // Cờ "đây có phải loại Tiền cọc" — bật → ảnh hưởng contracts.deposit_paid
  // và stats "Cọc đã thu". Set DB-side, FE chỉ đọc.
  is_deposit: boolean;
  created_at: string;
  updated_at: string;
}

// --- Query Hooks ---

export const useIncomeExpenseTypes = (filterType?: "income" | "expense") => {
  return useQuery({
    queryKey: ["income-expense-types", filterType],
    queryFn: async (): Promise<IncomeExpenseType[]> => {
      // RLS đã mở cho mọi user authenticated (migration 20260511000002),
      // nên không filter theo user_id ở đây. Nhiều user đã được seed cùng
      // tên ("Hoa hồng môi giới", "Thưởng nóng Sale", ...) → dedup
      // client-side theo (lower(name), type), ưu tiên row của user hiện
      // tại để pencil/sửa thao tác đúng record của họ.
      const {
        data: { user },
      } = await supabase.auth.getUser();
      const currentUserId = user?.id ?? null;

      let query = supabase
        .from("income_expense_types" as any)
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

      const rows = (data ?? []) as unknown as IncomeExpenseType[];

      const ownershipRank = (r: IncomeExpenseType) =>
        currentUserId && r.user_id === currentUserId ? 0 : 1;
      const sorted = [...rows].sort((a, b) => {
        const diff = ownershipRank(a) - ownershipRank(b);
        if (diff !== 0) return diff;
        return (a.created_at ?? "").localeCompare(b.created_at ?? "");
      });

      const seen = new Map<string, IncomeExpenseType>();
      for (const row of sorted) {
        const key = `${row.type}::${row.name.trim().toLowerCase()}`;
        if (!seen.has(key)) seen.set(key, row);
      }

      return Array.from(seen.values()).sort((a, b) =>
        a.name.localeCompare(b.name, "vi", { sensitivity: "base" })
      );
    },
  });
};

/**
 * Distinct, non-null categories cho user hiện tại (lọc theo type nếu truyền).
 * Dùng cho combobox gom nhóm trong form Thêm/Sửa loại thu chi.
 */
export const useIncomeExpenseTypeCategories = (
  filterType?: "income" | "expense"
) => {
  return useQuery({
    queryKey: ["income-expense-type-categories", filterType],
    queryFn: async (): Promise<string[]> => {
      // Categories cũng dùng chung — không filter theo user_id (xem hook
      // useIncomeExpenseTypes phía trên).
      let query = supabase
        .from("income_expense_types" as any)
        .select("category")
        .not("category", "is", null);

      if (filterType) {
        query = query.eq("type", filterType);
      }

      const { data, error } = await query;
      if (error) {
        console.error("useIncomeExpenseTypeCategories error:", error);
        return [];
      }

      const set = new Set<string>();
      for (const row of (data ?? []) as Array<{ category: string | null }>) {
        const c = (row.category ?? "").trim();
        if (c) set.add(c);
      }
      return Array.from(set).sort((a, b) =>
        a.localeCompare(b, "vi", { sensitivity: "base" })
      );
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
      category?: string | null;
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
          category: input.category ?? null,
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
      queryClient.invalidateQueries({
        queryKey: ["income-expense-type-categories"],
      });
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
        category?: string | null;
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
      queryClient.invalidateQueries({
        queryKey: ["income-expense-type-categories"],
      });
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
      queryClient.invalidateQueries({
        queryKey: ["income-expense-type-categories"],
      });
      toast.success("Loại thu chi đã được XOÁ thành công");
    },
    onError: (error) => {
      console.error("Error deleting income expense type:", error);
    },
  });
};
