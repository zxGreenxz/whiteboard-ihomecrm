import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { toast } from "sonner";

export interface PersonalTransaction {
  id: string;
  user_id: string;
  type: "INCOME" | "EXPENSE";
  amount: number;
  description: string | null;
  txn_date: string; // YYYY-MM-DD
  category: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface PersonalTransactionFormValues {
  type: "INCOME" | "EXPENSE";
  amount: number;
  txn_date: string;
  category?: string | null;
  description?: string | null;
}

// Danh sách giao dịch ví cá nhân của chính user (RLS own-only).
export const usePersonalTransactions = () => {
  return useQuery({
    queryKey: ["personal-transactions"],
    queryFn: async () => {
      const { data, error } = await (supabase
        .from("personal_transactions" as any)
        .select("*") as any)
        .is("deleted_at", null)
        .order("txn_date", { ascending: false })
        .order("created_at", { ascending: false });
      if (error) {
        toast.error("Không thể tải ví cá nhân");
        throw error;
      }
      return ((data || []) as any[]).map((r) => ({
        ...r,
        amount: Number(r.amount) || 0,
      })) as PersonalTransaction[];
    },
  });
};

export const useCreatePersonalTransaction = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (values: PersonalTransactionFormValues) => {
      const auth = { user: await getSessionUser() };
      if (!auth.user) throw new Error("User not authenticated");
      const { data, error } = await supabase
        .from("personal_transactions" as any)
        .insert({
          user_id: auth.user.id,
          type: values.type,
          amount: values.amount,
          txn_date: values.txn_date,
          category: values.category ?? null,
          description: values.description ?? null,
        })
        .select()
        .single();
      if (error) {
        toast.error(error.message || "Không thể thêm khoản");
        throw error;
      }
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["personal-transactions"] });
      toast.success("Đã thêm khoản");
    },
  });
};

export const useUpdatePersonalTransaction = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; values: PersonalTransactionFormValues }) => {
      const { error } = await supabase
        .from("personal_transactions" as any)
        .update({
          type: input.values.type,
          amount: input.values.amount,
          txn_date: input.values.txn_date,
          category: input.values.category ?? null,
          description: input.values.description ?? null,
        })
        .eq("id", input.id);
      if (error) {
        toast.error(error.message || "Không thể cập nhật khoản");
        throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["personal-transactions"] });
      toast.success("Đã cập nhật khoản");
    },
  });
};

export const useDeletePersonalTransaction = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("personal_transactions" as any)
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id);
      if (error) {
        toast.error(error.message || "Không thể xoá khoản");
        throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["personal-transactions"] });
      toast.success("Đã xoá khoản");
    },
  });
};
