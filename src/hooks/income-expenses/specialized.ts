import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { toast } from "sonner";
import type {
  CreateProfitDistributionInput,
  CreateManagerSalaryPayoutInput,
} from "./types";

export const useCreateProfitDistribution = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateProfitDistributionInput) => {
      const user = await getSessionUser();
      if (!user) throw new Error("User not authenticated");

      const { data, error } = await (supabase.rpc as any)(
        "distribute_shareholder_profit_v1",
        {
          p_shareholder_id: input.shareholder_id,
          p_amount: input.amount,
          p_account_id: input.account_id,
          p_voucher_date: input.voucher_date,
          p_note: input.note ?? null,
          p_idempotency_key: `profit-dist-${crypto.randomUUID()}`,
        },
      );

      // Money writers fail closed: permission, frozen and rollout errors must
      // never fall back to direct client inserts.
      if (error) {
        toast.error(error.message || "Không thể tạo phiếu chia lợi nhuận");
        throw error;
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      queryClient.invalidateQueries({ queryKey: ["shareholder-distributions"] });
      toast.success("Đã ghi phiếu chia lợi nhuận");
    },
    onError: (error) => {
      console.error("Error creating profit distribution:", error);
    },
  });
};

export const useCreateManagerSalaryPayout = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateManagerSalaryPayoutInput) => {
      const user = await getSessionUser();
      if (!user) throw new Error("User not authenticated");

      const { data, error } = await (supabase.rpc as any)(
        "manager_salary_payout_v1",
        {
          p_manager_id: input.manager_id,
          p_amount: input.amount,
          p_account_id: input.account_id,
          p_voucher_date: input.voucher_date,
          p_note: input.note ?? null,
          p_idempotency_key: `mgr-payout-${crypto.randomUUID()}`,
        },
      );

      if (error) {
        toast.error(error.message || "Không thể tạo phiếu lương điều hành");
        throw error;
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      queryClient.invalidateQueries({ queryKey: ["manager-salary-payouts"] });
      toast.success("Đã ghi phiếu lương điều hành");
    },
    onError: (error) => {
      console.error("Error creating manager salary payout:", error);
    },
  });
};
