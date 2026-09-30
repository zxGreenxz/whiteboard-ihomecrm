import {persistentFinancialWorkflow} from '@/lib/persistentFinancialWorkflow';
import {FinancialWorkflowError,workflowErrorMessage} from '@/lib/financialWorkflow';
import { voucherFailureMessage } from "@/lib/voucherFeedback";
// Đổi cờ "tính vào kết quả kinh doanh" của phiếu DOANH THU BỎ CỌC.
//
// VÌ SAO PHẢI CÓ CỬA RIÊNG, KHÔNG DÙNG ĐƯỜNG SỬA PHIẾU THƯỜNG:
//   Cặp bút toán bỏ cọc được canh bởi trigger guard_termination_forfeit_voucher_v1,
//   và trigger đó KHÔNG nhìn user — nó chỉ hỏi transaction hiện tại đã gọi
//   app_private.begin_accounting_chain_write_v1() chưa. Đường sửa phiếu thường
//   (revise_pending_income_expense_v1, trước đó ie_compat_update_pending_v2)
//   không gọi hàm đó, lại chỉ nhận phiếu Chờ duyệt — trong khi cặp bỏ cọc
//   thường đã duyệt.
//
//   set_forfeit_voucher_kqkd_v1 mở đúng năng lực writer đó, đổi ĐÚNG một cột,
//   rồi tự kiểm lại cặp phiếu trong cùng transaction trước khi commit.
//
// KHÔNG đụng số tiền, không đụng chân đối ứng, không đụng dòng tiền: cặp bỏ cọc
// chạy trên sổ ẢO nên không có bút toán tiền nào. Thứ đổi là báo cáo lợi nhuận.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { periodBlockMessage } from "@/lib/cashbookClosing";

// Phần kiểm hợp lệ sống ở lib (test được không cần react-query, và chỉ có một
// nơi để sửa khi ngưỡng ở server đổi). Re-export để nơi gọi khỏi import hai chỗ.
export {
  FORFEIT_KQKD_REASON_MIN,
  forfeitKqkdReasonValid,
} from "@/lib/financeV2VoucherState";

export interface SetForfeitKqkdInput {
  voucherId: string;
  /** true = tính vào lợi nhuận · false = ép loại khỏi lợi nhuận. */
  kqkd: boolean;
  reason: string;
}

export interface SetForfeitKqkdResult {
  id: string;
  changed: boolean;
  business_result_accounting: boolean | null;
  kqkd_amount: number | string | null;
  total_amount?: number | string | null;
}

/**
 * Đổi cờ KQKD chỉ chạm BÁO CÁO LỢI NHUẬN, không chạm số dư sổ quỹ — nên danh
 * sách này cố ý KHÔNG có các key tiền mặt (accounts-with-balance, cash-flow…):
 * làm mới chúng chỉ tốn request và khiến người đọc tưởng tiền vừa đổi.
 */
const INVALIDATE_KEYS = [
  ["income-expenses"],
  ["ie-history"],
  ["voucher-change-log"],
  ["financial-analysis"],
  ["business-performance"],
  ["profit-verification"],
  // Lợi nhuận đem chia đổi theo — đây là hệ quả nặng nhất của việc gạt cờ.
  ["monthly-building-profit"],
  ["profit-close-preview"],
  ["profit-close-state"],
  // Dashboard: KPI "Doanh thu tháng này" + biểu đồ 12 tháng.
  ["dashboard-summary"],
  ["revenue-chart"],
] as const;

export const useSetForfeitVoucherKqkd = () => {
  const workflow=persistentFinancialWorkflow("voucher-kqkd",{scope:"actor"});
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: SetForfeitKqkdInput) => workflow.run(input.voucherId,'đổi cách hạch toán phiếu',async progress=>{
      const { data, error } = await supabase.rpc("set_forfeit_voucher_kqkd_v1", {
        p_voucher: input.voucherId,
        p_kqkd: input.kqkd,
        p_reason: input.reason,
      });
      if (error) {
        const msg = error.message ?? "";
        // Server viết sẵn câu tiếng Việt; periodBlockMessage chỉ bóc tiền tố
        // máy-đọc ([PROFIT_LOCKED]…) thành câu người đọc.

        throw error;
      }
      const receipt=data as unknown as SetForfeitKqkdResult|null;
      if(receipt?.id!==input.voucherId || typeof receipt.changed!=='boolean')throw new TypeError('Chưa xác nhận kết quả đổi hạch toán của đúng phiếu.');
      progress.completed.push({id:input.voucherId,label:`Đã nhận kết quả cập nhật cách hạch toán phiếu ${input.voucherId}`});
      if(receipt.changed && receipt.business_result_accounting!==input.kqkd)throw new TypeError('Chưa xác nhận được cách tính phiếu vào kết quả kinh doanh.');
      return receipt;
    }),
    onSuccess: (data, variables) => {
      for (const key of INVALIDATE_KEYS) {
        queryClient.invalidateQueries({ queryKey: key as unknown as string[] });
      }
      if (data?.changed === false) {
        toast.info("Phiếu đã ở đúng trạng thái hạch toán này từ trước. Không có thay đổi mới.");
        return;
      }
      if (typeof data.business_result_accounting !== "boolean") {
        toast.warning("Đã cập nhật phiếu nhưng chưa xác nhận được cách tính vào kết quả kinh doanh. Hãy tải lại phiếu để kiểm tra.");
        return;
      }
      toast.success(
        data.business_result_accounting === true
          ? "Đã chuyển phiếu bỏ cọc vào kết quả kinh doanh"
          : "Đã loại phiếu bỏ cọc khỏi kết quả kinh doanh",
      );
    },
    onError: (error) => {
      toast.error(error instanceof FinancialWorkflowError?workflowErrorMessage(error,"đổi cách hạch toán phiếu"):voucherFailureMessage(error,"đổi cách hạch toán phiếu"));
      console.error("Error setting forfeit voucher KQKD flag:", error);
    },
  });
};
