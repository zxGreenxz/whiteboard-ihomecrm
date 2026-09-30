import {persistentFinancialWorkflow} from '@/lib/persistentFinancialWorkflow';
import {FinancialWorkflowError} from '@/lib/financialWorkflow';
import { readCreatedVoucherReceipt } from "@/lib/createdVoucherReceipt";
import { createdVoucherFeedback, voucherFailureMessage } from "@/lib/voucherFeedback";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { rpcNullable } from "@/lib/rpcNullable";
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

      if(!input.organizationId)throw new FinancialWorkflowError('Chưa xác định được tổ chức của sổ quỹ. Tải lại sổ quỹ trước khi lập phiếu.','failure',[]);
      return persistentFinancialWorkflow('profit-payout').run('shareholder:'+input.shareholder_id,'lập phiếu chi lợi nhuận',async progress=>{
      const { data, error } = await supabase.rpc(
        "distribute_shareholder_profit_v1",
        {
          p_shareholder_id: input.shareholder_id,
          p_amount: input.amount,
          p_account_id: input.account_id,
          p_voucher_date: input.voucher_date,
          // `p_note text` KHÔNG có DEFAULT ⇒ bắt buộc truyền, nhưng vẫn nhận
          // NULL (phiếu không ghi chú). Bộ sinh không diễn đạt được điều đó.
          p_note: rpcNullable(input.note ?? null),
          p_idempotency_key: progress.requestKey,
        },
      );

      // Money writers fail closed: permission, frozen and rollout errors must
      // never fall back to direct client inserts.
      if (error) {
        throw error;
      }
      const receipt=await readCreatedVoucherReceipt(data);
      progress.completed.push({id:receipt.id,label:'Phiếu chi lợi nhuận đã tạo'});
      return receipt;
      },undefined,input.organizationId);
    },
    onSuccess: (receipt) => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      queryClient.invalidateQueries({ queryKey: ["shareholder-distributions"] });
      const feedback=createdVoucherFeedback(receipt); toast[feedback.kind](feedback.message);
    },
    onError: (error) => {
      toast.error(voucherFailureMessage(error,"lập phiếu chi lợi nhuận"));
    },
  });
};

export const useCreateManagerSalaryPayout = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateManagerSalaryPayoutInput) => {
      const user = await getSessionUser();
      if (!user) throw new Error("User not authenticated");

      if(!input.organizationId)throw new FinancialWorkflowError('Chưa xác định được tổ chức của sổ quỹ. Tải lại sổ quỹ trước khi lập phiếu.','failure',[]);
      return persistentFinancialWorkflow('profit-payout').run('manager:'+input.manager_id,'lập phiếu chi lương điều hành',async progress=>{
      const { data, error } = await supabase.rpc(
        "manager_salary_payout_v1",
        {
          p_manager_id: input.manager_id,
          p_amount: input.amount,
          p_account_id: input.account_id,
          p_voucher_date: input.voucher_date,
          // `p_note text` bắt buộc-nhưng-nhận-NULL, như trên.
          p_note: rpcNullable(input.note ?? null),
          p_idempotency_key: progress.requestKey,
        },
      );

      if (error) {
        throw error;
      }
      const receipt=await readCreatedVoucherReceipt(data);
      progress.completed.push({id:receipt.id,label:'Phiếu chi lương đã tạo'});
      return receipt;
      },undefined,input.organizationId);
    },
    onSuccess: (receipt) => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      queryClient.invalidateQueries({ queryKey: ["manager-salary-payouts"] });
      const feedback=createdVoucherFeedback(receipt); toast[feedback.kind](feedback.message);
    },
    onError: (error) => {
      toast.error(voucherFailureMessage(error,"lập phiếu chi lương điều hành"));
    },
  });
};
