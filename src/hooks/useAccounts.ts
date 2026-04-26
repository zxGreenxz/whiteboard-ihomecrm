import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

// --- Types ---

export type AccountType = "cash" | "bank" | "ewallet";

export interface Account {
  id: string;
  user_id: string;
  code: string;
  name: string;
  type: AccountType;
  bank_name: string | null;
  account_number: string | null;
  bank_account_holder: string | null;
  branch: string | null;
  description: string | null;
  is_default: boolean;
  initial_amount: number;
  initial_date: string;        // YYYY-MM-DD
  lock_date: string | null;    // YYYY-MM-DD
  created_at: string;
  updated_at: string;
}

export interface AccountWithBalance extends Account {
  current_amount: number;      // tồn quỹ
}

export interface AccountFormValues {
  name: string;
  type: AccountType;
  bank_name?: string | null;
  account_number?: string | null;
  bank_account_holder?: string | null;
  branch?: string | null;
  description?: string | null;
  initial_amount: number;
  initial_date: string;
  is_default?: boolean;
}

const TYPE_LABEL: Record<AccountType, string> = {
  cash: "Tiền mặt",
  bank: "Ngân hàng",
  ewallet: "Ví điện tử",
};

export const accountTypeLabel = (t: AccountType) => TYPE_LABEL[t];

// --- Query: select-list (dùng trong filter & form thu chi) ---
export const useAccounts = () => {
  return useQuery({
    queryKey: ["accounts"],
    queryFn: async () => {
      const { data, error } = await (supabase
        .from("accounts" as any)
        .select("*") as any)
        .is("deleted_at", null)
        .order("name", { ascending: true });

      if (error) {
        toast.error("Không thể tải danh sách sổ quỹ");
        throw error;
      }

      return (data || []) as Account[];
    },
  });
};

// --- Query: list with balance (cho trang Cashbooks) ---
export const useAccountsWithBalance = (params?: {
  searchQuery?: string;
  page?: number;
  pageSize?: number;
}) => {
  const page = params?.page ?? 1;
  const pageSize = params?.pageSize ?? 10;
  const searchQuery = params?.searchQuery?.trim() ?? "";

  return useQuery({
    queryKey: ["accounts-with-balance", page, pageSize, searchQuery],
    queryFn: async (): Promise<{
      data: AccountWithBalance[];
      totalCount: number;
    }> => {
      let query = supabase
        .from("accounts_with_balance" as any)
        .select("*", { count: "exact" });

      if (searchQuery) {
        // search trên name + code
        query = query.or(
          `name.ilike.%${searchQuery}%,code.ilike.%${searchQuery}%`
        );
      }

      const from = (page - 1) * pageSize;
      const to = from + pageSize - 1;

      const { data, error, count } = await query
        .order("created_at", { ascending: false })
        .range(from, to);

      if (error) {
        console.error("useAccountsWithBalance error", error);
        toast.error("Không thể tải danh sách sổ quỹ");
        return { data: [], totalCount: 0 };
      }

      const rows = (data || []) as any[];
      const mapped: AccountWithBalance[] = rows.map((r) => ({
        ...r,
        initial_amount: Number(r.initial_amount) || 0,
        current_amount: Number(r.current_amount) || 0,
      }));

      return { data: mapped, totalCount: count ?? 0 };
    },
  });
};

// --- Mutations ---

export const useCreateAccount = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (values: AccountFormValues) => {
      const { data: authData } = await supabase.auth.getUser();
      if (!authData.user) throw new Error("User not authenticated");

      const payload: any = {
        user_id: authData.user.id,
        name: values.name,
        type: values.type,
        bank_name: values.bank_name ?? null,
        account_number: values.account_number ?? null,
        bank_account_holder: values.bank_account_holder ?? null,
        branch: values.branch ?? null,
        description: values.description ?? null,
        initial_amount: values.initial_amount,
        initial_date: values.initial_date,
        is_default: values.is_default ?? false,
      };

      const { data, error } = await supabase
        .from("accounts" as any)
        .insert(payload)
        .select()
        .single();

      if (error) {
        toast.error(error.message || "Không thể tạo sổ quỹ");
        throw error;
      }
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      toast.success("Thông tin đã được cập nhật lưu trữ thành công");
    },
  });
};

export const useUpdateAccount = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; values: AccountFormValues }) => {
      const { error } = await supabase
        .from("accounts" as any)
        .update({
          name: input.values.name,
          type: input.values.type,
          bank_name: input.values.bank_name ?? null,
          account_number: input.values.account_number ?? null,
          bank_account_holder: input.values.bank_account_holder ?? null,
          branch: input.values.branch ?? null,
          description: input.values.description ?? null,
          initial_amount: input.values.initial_amount,
          initial_date: input.values.initial_date,
          is_default: input.values.is_default ?? false,
        })
        .eq("id", input.id);

      if (error) {
        toast.error(error.message || "Không thể cập nhật sổ quỹ");
        throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      toast.success("Thông tin đã được cập nhật lưu trữ thành công");
    },
  });
};

export const useDeleteAccount = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("accounts" as any)
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id);

      if (error) {
        toast.error(error.message || "Không thể xoá sổ quỹ");
        throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      toast.success("Dữ liệu đã được XOÁ thành công");
    },
  });
};

export const useLockAccount = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; lock_date: string }) => {
      const { error } = await supabase
        .from("accounts" as any)
        .update({ lock_date: input.lock_date })
        .eq("id", input.id);
      if (error) {
        toast.error(error.message || "Không thể khoá sổ");
        throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      toast.success("Đã khoá sổ thành công");
    },
  });
};

export const useUnlockAccount = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("accounts" as any)
        .update({ lock_date: null })
        .eq("id", id);
      if (error) {
        toast.error(error.message || "Không thể mở khoá sổ");
        throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      toast.success("Đã mở khoá sổ thành công");
    },
  });
};
