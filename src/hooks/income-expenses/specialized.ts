import {persistentFinancialWorkflow} from '@/lib/persistentFinancialWorkflow';
import {FinancialWorkflowError} from '@/lib/financialWorkflow';
import { readCreatedVoucherReceipt, type CreatedVoucherReceipt } from "@/lib/createdVoucherReceipt";
import { createdVoucherFeedback } from "@/lib/voucherFeedback";
import { profitLedgerErrorMessage } from "@/lib/profitLedger/errors";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { rpcNullable } from "@/lib/rpcNullable";
import { formatVND } from "@/lib/utils";
import { withBusyRetry } from "@/lib/profitLedger/busyRetry";
import { readManagerSalaryPayoutResult } from "@/lib/profitLedger/actionReaders";
import { invalidateProfitLedgerQueries } from "@/hooks/profit-ledger/useProfitLedgerMutations";
import { toast } from "sonner";
import type { CreateManagerSalaryPayoutInput } from "./types";

// Chi lợi nhuận cổ đông KHÔNG còn ở đây: từ Đợt 2 (sổ tổng) web lập phiếu bằng
// shareholder_profit_ledger_payout_v1 (hooks/profit-ledger). distribute_shareholder_profit_v1
// chỉ còn scripts/test-accounting-chain.mjs gọi — thu hồi ở Đợt 3.

export interface ManagerSalaryPayoutReceipt extends CreatedVoucherReceipt {
  /** Số lương điều hành còn lại TRƯỚC phiếu này — chỉ có khi sổ tổng chạy thật; route khác ⇒ null. */
  balance_before: number | null;
}

export const useCreateManagerSalaryPayout = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateManagerSalaryPayoutInput): Promise<ManagerSalaryPayoutReceipt> => {
      const user = await getSessionUser();
      if (!user) throw new Error("User not authenticated");

      if(!input.organizationId)throw new FinancialWorkflowError('Chưa xác định được tổ chức của sổ quỹ. Tải lại sổ quỹ trước khi lập phiếu.','failure',[]);
      return persistentFinancialWorkflow('profit-payout').run('manager:'+input.manager_id,'lập phiếu chi lương điều hành',async progress=>{
      // Kẹt khoá chéo (40P01) ⇒ gửi lại CÙNG khoá: lệnh idempotent, giao dịch bị huỷ không để lại gì.
      // Băm chống gửi trùng của lệnh này KHÔNG gồm ghi chú: sửa ghi chú phải là lượt bấm mới (khoá mới).
      const { data, error } = await withBusyRetry(() => supabase.rpc(
        "manager_salary_payout_v1",
        {
          p_manager_id: input.manager_id,
          p_amount: input.amount,
          p_account_id: input.account_id,
          p_voucher_date: input.voucher_date,
          // `p_note text` bắt buộc-nhưng-nhận-NULL.
          p_note: rpcNullable(input.note ?? null),
          p_idempotency_key: progress.requestKey,
        },
      ));

      if (error) {
        throw error;
      }
      // Biên nhận mới có khoá `voucher_id` (= manager_salary_voucher_id) và, khi sổ tổng chạy thật,
      // `balance_before`. Lệch hợp đồng ⇒ TypeError ⇒ "chưa rõ kết quả", khoá gửi lại.
      const result = readManagerSalaryPayoutResult(data, input.manager_id);
      const receipt=await readCreatedVoucherReceipt({ voucher_id: result.voucher_id });
      progress.completed.push({id:receipt.id,label:'Phiếu chi lương đã tạo'});
      return { ...receipt, balance_before: result.balance_before };
      },undefined,input.organizationId);
    },
    onSuccess: (receipt, input) => {
      queryClient.invalidateQueries({ queryKey: ["manager-salary-payouts"] });
      invalidateProfitLedgerQueries(queryClient);
      const feedback=createdVoucherFeedback(receipt);
      const remaining = receipt.balance_before === null ? '' : ` Lương điều hành còn lại sau phiếu này: ${formatVND(receipt.balance_before - input.amount)}.`;
      toast[feedback.kind](feedback.message + remaining);
    },
    onError: (error) => {
      invalidateProfitLedgerQueries(queryClient);
      // Vượt số còn lại / sổ tổng đóng băng / tháng đã chốt… có câu riêng; mã lạ rơi về câu chung.
      toast.error(profitLedgerErrorMessage(error,"manager_payout").message);
    },
  });
};
