import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

// (Workflow Duyệt/Bỏ duyệt đã bị loại bỏ — phiếu mặc định APPROVED khi tạo,
//  Huỷ thì set CANCELLED qua useCancelIncomeExpense.)

// Dừng lặp lại cho 1 phiếu GỐC: giữ nguyên phiếu + các phiếu con đã sinh,
// chỉ ngừng sinh phiếu con tương lai.
//
// PHẢI ĐI RPC, KHÔNG ĐƯỢC .from().update() — đây là chỗ đã hỏng thật.
//   Migration 20260723070000 REVOKE UPDATE của `authenticated` trên
//   income_expenses; nhánh direct-DML cũ ở đây bị bỏ sót khỏi đợt dọn caller,
//   nên nút này trả 403 "permission denied for table income_expenses" suốt từ
//   23/07 tới lúc người dùng báo (27/08/2026). Lỗi kiểu này không có gì trong
//   repo bắt được ngoài gate check-money-table-dml — TypeScript không có gì để
//   nói, vì lời gọi hoàn toàn hợp lệ về kiểu.
export const useStopRecurring = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("ie_stop_recurring_v1", { p_id: id });
      if (error) {
        toast.error(error.message || "Không thể dừng lặp lại");
        throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      toast.success("Đã dừng lặp lại cho phiếu này");
    },
  });
};

// Sinh các phiếu lặp lại tới hôm nay (RPC).
export const useGenerateRecurringVouchers = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      // RBAC v2: không cần p_user_id; v2 tự lookup các owner caller được phép.
      const { data, error } = await supabase.rpc("generate_recurring_vouchers_v2");
      if (error) {
        toast.error(error.message || "Không thể sinh phiếu lặp lại");
        throw error;
      }
      return (data ?? []) as Array<{ parent_id: string; child_id: string; voucher_date: string }>;
    },
    onSuccess: (rows) => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      toast.success(
        rows.length === 0
          ? "Không có phiếu lặp lại đến hạn"
          : `Đã sinh ${rows.length} phiếu lặp lại`
      );
    },
  });
};
