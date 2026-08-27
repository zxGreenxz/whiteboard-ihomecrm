// Đổi cờ "tính vào kết quả kinh doanh" của phiếu DOANH THU BỎ CỌC.
//
// VÌ SAO PHẢI CÓ CỬA RIÊNG, KHÔNG DÙNG useUpdateIncomeExpense:
//   Cặp bút toán bỏ cọc được canh bởi trigger guard_termination_forfeit_voucher_v1,
//   và trigger đó KHÔNG nhìn user — nó chỉ hỏi transaction hiện tại đã gọi
//   app_private.begin_accounting_chain_write_v1() chưa. RPC sửa phiếu thường
//   (ie_compat_update_pending_v2) không gọi hàm đó, nên super admin bấm Lưu
//   cũng nhận đúng câu "Bút toán bỏ cọc chỉ được tạo hoặc sửa bởi writer thanh
//   lý" như mọi người khác. Cột business_result_accounting còn nằm trong
//   v_money_keys của RPC đó nên phiếu đã duyệt dính thêm rào "trục tiền".
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
  ["shareholder-profit"],
  ["profit-verification"],
  ["dashboard-stats"],
  ["revenue-chart"],
] as const;

export const useSetForfeitVoucherKqkd = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: SetForfeitKqkdInput) => {
      const { data, error } = await supabase.rpc("set_forfeit_voucher_kqkd_v1", {
        p_voucher: input.voucherId,
        p_kqkd: input.kqkd,
        p_reason: input.reason,
      });
      if (error) {
        const msg = error.message ?? "";
        // Server viết sẵn câu tiếng Việt; periodBlockMessage chỉ bóc tiền tố
        // máy-đọc ([PROFIT_LOCKED]…) thành câu người đọc.
        toast.error(
          periodBlockMessage(msg) ?? msg ?? "Không đổi được hạch toán KQKD",
        );
        throw error;
      }
      return data as unknown as SetForfeitKqkdResult;
    },
    onSuccess: (data, variables) => {
      for (const key of INVALIDATE_KEYS) {
        queryClient.invalidateQueries({ queryKey: key as unknown as string[] });
      }
      if (data?.changed === false) {
        toast.success("Phiếu đã ở đúng trạng thái hạch toán này từ trước");
        return;
      }
      toast.success(
        variables.kqkd
          ? "Đã chuyển phiếu bỏ cọc vào kết quả kinh doanh"
          : "Đã loại phiếu bỏ cọc khỏi kết quả kinh doanh",
      );
    },
    onError: (error) => {
      console.error("Error setting forfeit voucher KQKD flag:", error);
    },
  });
};
