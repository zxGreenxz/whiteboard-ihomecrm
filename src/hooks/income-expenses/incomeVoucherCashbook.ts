// ĐỢT C — Đổi sổ quỹ của PHIẾU THU đã ghi sổ.
//
// Trước đợt này ô "Sổ quỹ" đã bị gỡ khỏi hộp thoại sửa nhanh, vì đường cũ
// (update_income_expense_quick) UPDATE thẳng `account_id` mà không kiểm gì:
// cầu auto-posting a85 sẽ đảo bút toán ở sổ cũ và ghi ở sổ mới — tiền rời két
// người khác, không ai duyệt, không dòng nhật ký nào.
//
// Nay có RPC `move_income_voucher_cashbook_v1` làm đúng việc đó nhưng có kiểm
// quyền (sổ đi phải GIỮ, sổ đến GIỮ hoặc BIẾT), kiểm ba khoá thời gian, bắt
// buộc lý do, và tự kiểm hậu điều kiện tiền đã rời hẳn sổ cũ.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { periodBlockMessage } from "@/lib/cashbookClosing";

export interface CashbookAccessRow {
  cashbook_id: string;
  /** RPC trả sẵn TÊN sổ — bắt buộc dùng, xem cảnh báo dưới. */
  cashbook_name: string | null;
  possession_kind: "CUSTODIAN" | "KNOWER" | "OPERATOR";
  since?: string | null;
}

/**
 * Sổ quỹ người dùng GIỮ hoặc BIẾT — đúng tập mà server cho phép làm sổ ĐẾN.
 * `enabled` để không gọi khi hộp thoại chưa mở.
 *
 * GOTCHA (đo trên prod 01/08/2026): ĐỪNG giao danh sách này với `useAccounts()`
 * để lấy tên. `useAccounts()` đọc thẳng `public.accounts` qua RLS, và RLS đó
 * hẹp hơn possession rất nhiều — tài khoản chủ nhà DEMO giữ 5 sổ nhưng chỉ
 * NHÌN được 1 qua bảng accounts. Giao hai danh sách làm dropdown đổi sổ quỹ
 * rỗng gần hết. RPC này đã trả sẵn `cashbook_name`, dùng thẳng.
 */
export const useMyCashbookAccess = (enabled = true) =>
  useQuery({
    queryKey: ["my-cashbook-access-v2"],
    enabled,
    staleTime: 60_000,
    queryFn: async (): Promise<CashbookAccessRow[]> => {
      const { data, error } = await supabase.rpc(
        "list_my_cashbook_access_v2",
      );
      if (error) throw new Error(error.message);
      return (data ?? []) as CashbookAccessRow[];
    },
  });

export interface MoveCashbookInput {
  voucherId: string;
  newAccountId: string;
  /** Server bắt buộc ≥ 8 ký tự. */
  reason: string;
}

interface MoveCashbookResult {
  id: string;
  changed: boolean;
  from_account_name: string | null;
  to_account_name: string | null;
}

export const useMoveIncomeVoucherCashbook = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: MoveCashbookInput) => {
      const { data, error } = await supabase.rpc(
        "move_income_voucher_cashbook_v1",
        {
          p_voucher: input.voucherId,
          p_new_account: input.newAccountId,
          p_reason: input.reason,
        },
      );
      if (error) {
        const msg = error.message ?? "";
        toast.error(periodBlockMessage(msg) ?? msg ?? "Không đổi được sổ quỹ");
        throw error;
      }
      return data as unknown as MoveCashbookResult;
    },
    onSuccess: (data) => {
      // Tiền vừa chuyển giữa hai sổ — mọi màn hình tồn quỹ phải tính lại.
      for (const key of [
        ["income-expenses"],
        ["accounts-with-balance"],
        ["cash-book-summary"],
        ["cash-flow-by-day"],
        ["voucher-with-batch"],
        ["voucher-change-log"],
        ["financial-analysis"],
      ]) {
        queryClient.invalidateQueries({ queryKey: key });
      }
      toast.success(
        data?.from_account_name && data?.to_account_name
          ? `Đã chuyển phiếu sang sổ "${data.to_account_name}" (rút khỏi "${data.from_account_name}")`
          : "Đã đổi sổ quỹ của phiếu",
      );
    },
    onError: (error) => {
      console.error("Error moving income voucher cashbook:", error);
    },
  });
};
