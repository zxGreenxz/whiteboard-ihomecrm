import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { isIeLifecycleFallbackSignal } from "@/lib/canonicalFallback";

// Duyệt phiếu thu/chi (UNAPPROVED → APPROVED). Dùng khi đã thực thanh toán
// phiếu nháp (vd phiếu chi hoa hồng tạo cùng hợp đồng).
// Canonical approve_income_expense_v1 (phiếu flow-owned) trước; phiếu legacy
// nhận tín hiệu 'chưa thuộc luồng canonical' → dùng approve_voucher như cũ.
export const useApproveVoucher = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const canonical = await (supabase.rpc as any)("approve_income_expense_v1", {
        p_voucher_id: id,
      });
      if (!canonical.error) return;
      if (!isIeLifecycleFallbackSignal(canonical.error)) {
        toast.error(canonical.error.message || "Không thể duyệt phiếu");
        throw canonical.error;
      }

      const { error } = await (supabase as any).rpc("approve_voucher", {
        voucher_id: id,
      });
      if (error) {
        toast.error(error.message || "Không thể duyệt phiếu");
        throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      toast.success("Phiếu đã được duyệt");
    },
    onError: (error) => {
      console.error("Error approving voucher:", error);
    },
  });
};

// Huỷ duyệt phiếu thu/chi (APPROVED → UNAPPROVED, về lại Nháp). Chỉ super admin
// (hoặc người tạo) — RPC unapprove_voucher tự kiểm quyền (user_id = auth.uid()
// OR is_super_admin()). Dùng khi cần sửa lại phiếu đã ghi nhận.
export const useUnapproveVoucher = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase as any).rpc("unapprove_voucher", {
        voucher_id: id,
      });
      if (error) {
        // Phiếu canonical bị đóng băng vòng đời (Phương án A): không quay về
        // Nháp được — hướng dẫn Huỷ + Tạo bản sao thay vì lỗi kỹ thuật khó hiểu.
        const frozen = (error.message ?? "").includes("frozen");
        toast.error(
          frozen
            ? "Phiếu canonical không thể huỷ duyệt — hãy Huỷ phiếu rồi bấm Tạo bản sao"
            : error.message || "Không thể huỷ duyệt phiếu",
        );
        throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      toast.success("Đã chuyển phiếu về Nháp");
    },
    onError: (error) => {
      console.error("Error unapproving voucher:", error);
    },
  });
};

// Huỷ phiếu thu/chi: đổi trạng thái sang CANCELLED. Nếu là phiếu INCOME mirror
// từ thanh toán hoá đơn (có payment_id), cũng xoá payment row tương ứng để
// trigger recompute invoice paid_amount/status (qua trigger DB).
export const useCancelIncomeExpense = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      // Canonical cancel (phiếu flow-owned): transition + audit hash-chain
      // server-side, KHÔNG đụng payments (phiếu canonical không gắn payment).
      // Phiếu legacy → tín hiệu fallback → giữ nguyên đường cũ bên dưới.
      const canonical = await (supabase.rpc as any)("cancel_income_expense_v1", {
        p_voucher_id: id,
        p_reason: null,
      });
      if (!canonical.error) return;
      if (!isIeLifecycleFallbackSignal(canonical.error)) {
        toast.error(canonical.error.message || "Không thể huỷ phiếu thu/chi");
        throw canonical.error;
      }

      const { data: voucher, error: fetchErr } = await supabase
        .from("income_expenses")
        .select("id, type, payment_id, approval_status")
        .eq("id", id)
        .maybeSingle() as any;
      if (fetchErr) {
        toast.error(fetchErr.message || "Không thể đọc phiếu");
        throw fetchErr;
      }

      const { error } = await supabase
        .from("income_expenses")
        .update({ approval_status: "CANCELLED" })
        .eq("id", id);
      if (error) {
        toast.error(error.message || "Không thể huỷ phiếu thu/chi");
        throw error;
      }

      if (voucher?.type === "INCOME" && voucher?.payment_id) {
        const { error: payErr } = await supabase
          .from("payments")
          .delete()
          .eq("id", voucher.payment_id);
        if (payErr) {
          toast.error(payErr.message || "Không thể rollback thanh toán hoá đơn");
          throw payErr;
        }
      }

      // Ghi nhật ký thao tác HUỶ (best-effort — không chặn nếu log lỗi).
      // T3 audit-monopoly: RPC log chỉ nhận NOTE/CANCELLED_NOTE/MANUAL_LOG —
      // client không được tự dập sự kiện lifecycle 'CANCELLED' (chỉ transition
      // engine được ghi). CANCELLED_NOTE là alias chuẩn cho huỷ-đường-legacy.
      await (supabase as any).rpc("log_income_expense_action", {
        p_id: id,
        p_action: "CANCELLED_NOTE",
        p_note: null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      queryClient.invalidateQueries({ queryKey: ["invoice"] });
      queryClient.invalidateQueries({ queryKey: ["payments"] });
      queryClient.invalidateQueries({ queryKey: ["invoice-statistics"] });
      // Huỷ phiếu điện/nước từ Thu chi phải làm mới màn "Đóng điện nước" ngay
      // trên thiết bị thao tác (đối xứng usePayUtilityBill.onSuccess). Hub
      // realtime lo cross-client; đây lo tức thì cho client hiện tại.
      queryClient.invalidateQueries({ queryKey: ["utility-payments"] });
      toast.success("Phiếu đã được HUỶ");
    },
    onError: (error) => {
      console.error("Error cancelling income expense:", error);
    },
  });
};

// Khôi phục phiếu thu/chi đã huỷ (CANCELLED → APPROVED). CHỈ super admin —
// RPC restore_income_expense tự kiểm quyền (is_super_admin). Với phiếu THU theo
// hoá đơn đã mất payment khi huỷ, RPC tạo lại payment (chặn trùng) để hoá đơn
// trở lại đã thu. Thao tác được ghi vào nhật ký (income_expense_audit_log).
export const useRestoreIncomeExpense = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase as any).rpc("restore_income_expense", {
        p_id: id,
      });
      if (error) {
        // Phiếu canonical đã huỷ là terminal (Phương án A) → dùng Tạo bản sao.
        const frozen = (error.message ?? "").includes("frozen");
        toast.error(
          frozen
            ? "Phiếu canonical đã huỷ không khôi phục được — hãy bấm Tạo bản sao để lập phiếu mới"
            : error.message || "Không thể khôi phục phiếu",
        );
        throw error;
      }
    },
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      queryClient.invalidateQueries({ queryKey: ["invoice"] });
      queryClient.invalidateQueries({ queryKey: ["payments"] });
      queryClient.invalidateQueries({ queryKey: ["invoice-statistics"] });
      queryClient.invalidateQueries({ queryKey: ["ie-history", id] });
      toast.success("Đã khôi phục phiếu");
    },
    onError: (error) => {
      console.error("Error restoring income expense:", error);
    },
  });
};

// Đánh dấu "đã kiểm" / bỏ kiểm phiếu thu/chi. Toggle theo trạng thái hiện tại
// (RPC tự xử lý logic + check quyền). Note rỗng → lưu NULL.
export const useVerifyIncomeExpense = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; note: string | null }) => {
      // Canonical verify (phiếu flow-owned, token-wrapped); legacy fallback.
      const canonical = await (supabase.rpc as any)("verify_income_expense_v1", {
        p_id: input.id,
        p_note: input.note,
      });
      if (!canonical.error) return;
      if (!isIeLifecycleFallbackSignal(canonical.error)) {
        toast.error(canonical.error.message || "Không thể đánh dấu đã kiểm");
        throw canonical.error;
      }

      const { error } = await (supabase as any).rpc("verify_income_expense", {
        p_id: input.id,
        p_note: input.note,
      });
      if (error) {
        toast.error(error.message || "Không thể đánh dấu đã kiểm");
        throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["income-expense-batches"] });
      toast.success("Đã cập nhật trạng thái kiểm");
    },
    onError: (error) => {
      console.error("Error verifying income expense:", error);
    },
  });
};
