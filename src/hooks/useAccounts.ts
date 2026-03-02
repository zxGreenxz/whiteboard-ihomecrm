import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { Account } from "@/hooks/useIncomeExpenses";

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
        toast.error("Không thể tải danh sách tài khoản");
        throw error;
      }

      return (data || []) as Account[];
    },
  });
};
