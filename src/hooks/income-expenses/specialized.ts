import {persistentFinancialWorkflow} from '@/lib/persistentFinancialWorkflow';
import {FinancialAlreadyRecordedError,FinancialWorkflowError} from '@/lib/financialWorkflow';
import {formatPendingTime,payloadFingerprint} from '@/lib/financialPending';
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

// Chi lợi nhuận cổ đông KHÔNG còn ở đây: web lập phiếu qua hooks/profit-ledger — từ 18/11/2026 là
// shareholder_profit_advance_v1 (tạm ứng) và shareholder_profit_settle_v1 (chủ chốt chi theo tháng);
// lệnh nhập tay shareholder_profit_ledger_payout_v1 của Đợt 2 web không còn gọi.
// distribute_shareholder_profit_v1 chỉ còn scripts/test-accounting-chain.mjs gọi — thu hồi ở Đợt 3.

export interface ManagerSalaryPayoutReceipt extends CreatedVoucherReceipt {
  /** Số lương điều hành còn lại TRƯỚC phiếu này — chỉ có khi sổ tổng chạy thật; route khác ⇒ null. */
  balance_before: number | null;
}

/**
 * `deferFeedback`: hộp tự báo theo trạng thái thật của CẢ lượt (lập phiếu rồi Duyệt và Chi ngay — 19/11/2026),
 * không toast "đã tạo phiếu, chờ duyệt" / lỗi riêng của bước lập.
 */
export const useCreateManagerSalaryPayout = (options: { deferFeedback?: boolean } = {}) => {
  const queryClient = useQueryClient();
  const { deferFeedback = false } = options;

  return useMutation({
    mutationFn: async (input: CreateManagerSalaryPayoutInput): Promise<ManagerSalaryPayoutReceipt> => {
      const user = await getSessionUser();
      if (!user) throw new Error("User not authenticated");

      if(!input.organizationId)throw new FinancialWorkflowError('Chưa xác định được tổ chức của sổ quỹ. Tải lại sổ quỹ trước khi lập phiếu.','failure',[]);
      // Cách B (đợt 6): manager_salary_payout_v1 (production 25/11/2026) khoá công ty TRƯỚC khi tra mã yêu cầu; cùng mã cùng
      // nội dung ⇒ trả phiếu cũ, khác nội dung (quản lý, số tiền, sổ quỹ, ngày chi) ⇒ 23505. Ghi chú không nằm trong phần
      // máy chủ so, nên lượt đối chiếu không được đổi ghi chú.
      const hashedPrint=payloadFingerprint([input.manager_id,input.amount,input.account_id,input.voucher_date]);
      const notePart=payloadFingerprint([input.note??null]);
      let resend=false;
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
        // Gửi lại cùng mã mà máy chủ báo khác nội dung: mã đó đã được dùng, tức lần trước đã lập phiếu.
        if (resend && String((error as { code?: unknown }).code ?? '') === '23505') throw new FinancialAlreadyRecordedError('Phiếu chi lương điều hành đã được lập ở lần gửi trước (nội dung lúc đó khác nội dung đang gửi). Mở danh sách phiếu để kiểm tra trước khi lập thêm.');
        throw error;
      }
      // Biên nhận mới có khoá `voucher_id` (= manager_salary_voucher_id) và, khi sổ tổng chạy thật,
      // `balance_before`. Lệch hợp đồng ⇒ TypeError ⇒ "chưa rõ kết quả"; lần bấm sau gửi lại cùng mã.
      const result = readManagerSalaryPayoutResult(data, input.manager_id);
      // Đọc lại không ném (lỗi đọc trả biên nhận tối thiểu): phiếu đã lập thì dấu được gỡ.
      const receipt=await readCreatedVoucherReceipt({ voucher_id: result.voucher_id });
      return { ...receipt, balance_before: result.balance_before };
      },async pending=>{
        // Dấu mang mã phiếu (bản trước ghi mã rồi mới kết thúc dở): giữ dấu, không gửi, không lập phiếu khác; sau 2 phút người
        // dùng tự xem phiếu đó và gỡ qua hộp cảnh báo.
        if(pending.completedIds.length)return null;
        resend=true;
        return {outcome:'not-written',serverDedupesRequestKey:true};
      },input.organizationId,{
        meta:{hashed:hashedPrint,rest:notePart},
        priorMismatch:pending=>pending.meta?.hashed===hashedPrint&&pending.meta?.rest!==notePart
          ?`Lần lập phiếu chi lương điều hành trước (gửi lúc ${formatPendingTime(pending.startedAt)}) chưa rõ kết quả. Máy chủ trả lại đúng phiếu của lần đó mà không xét ghi chú, nên giữ nguyên ghi chú như lần trước rồi bấm lại để đối chiếu; cần đổi thì kiểm tra danh sách phiếu trước.`
          :null,
      });
    },
    onSuccess: (receipt, input) => {
      queryClient.invalidateQueries({ queryKey: ["manager-salary-payouts"] });
      invalidateProfitLedgerQueries(queryClient);
      if (deferFeedback) return;
      const feedback=createdVoucherFeedback(receipt);
      const remaining = receipt.balance_before === null ? '' : ` Lương điều hành còn lại sau phiếu này: ${formatVND(receipt.balance_before - input.amount)}.`;
      toast[feedback.kind](feedback.message + remaining);
    },
    onError: (error) => {
      invalidateProfitLedgerQueries(queryClient);
      if (deferFeedback) return;
      // Vượt số còn lại / sổ tổng đóng băng / tháng đã chốt… có câu riêng; mã lạ rơi về câu chung.
      toast.error(profitLedgerErrorMessage(error,"manager_payout").message);
    },
  });
};
