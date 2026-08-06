import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { isIeLifecycleFallbackSignal } from "@/lib/canonicalFallback";
import { periodBlockMessage } from "@/lib/cashbookClosing";
import { todayISO } from '@/lib/collect';

type RpcError = { code?: string | null; message?: string | null };
type RpcResult = { error: RpcError | null };

// GOTCHA: KHÔNG gán tách `supabase.rpc` ra biến (mất `this` → "reading 'rest'").
// Luôn gọi qua member expression để giữ binding.
const callUnregisteredRpc = (
  name: string,
  args: Record<string, unknown>,
): Promise<RpcResult> =>
  (supabase.rpc as unknown as (
    n: string,
    a: Record<string, unknown>,
  ) => Promise<RpcResult>)(name, args);

const errorMessage = (error: unknown, fallback: string) => {
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message?: unknown }).message || fallback);
  }
  return fallback;
};

const isTerminationForfeitRpcUnavailable = (error: RpcError) => {
  if (error.code === "PGRST202") return true;
  if (error.code !== "42883") return false;

  const message = (error.message ?? "").toLowerCase();
  return (
    message.includes("set_termination_forfeit_status_v1") &&
    message.includes("does not exist")
  );
};

const TERMINATION_FORFEIT_SYSTEM_SOURCES = new Set([
  "termination.forfeit_revenue",
  "termination.forfeit_offset",
]);
const TERMINATION_FORFEIT_LEGACY_MARKER = "[CẤN CỌC BỎ CỌC";

const isConfidentlyOrdinaryVoucher = async (id: string) => {
  const { data, error } = await supabase
    .from("income_expenses")
    .select("system_source, notes")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return false;

  const row = data as { system_source?: unknown; notes?: unknown };
  if (!("system_source" in row) || !("notes" in row)) return false;
  const rawSystemSource = row.system_source;
  const rawNotes = row.notes;
  if (rawSystemSource !== null && typeof rawSystemSource !== "string") {
    return false;
  }
  if (rawNotes !== null && typeof rawNotes !== "string") return false;
  const systemSource = typeof rawSystemSource === "string" ? rawSystemSource : "";
  const notes = typeof rawNotes === "string" ? rawNotes : "";

  return !(
    TERMINATION_FORFEIT_SYSTEM_SOURCES.has(systemSource) ||
    notes.startsWith(TERMINATION_FORFEIT_LEGACY_MARKER)
  );
};

const TERMINATION_FORFEIT_QUERY_KEYS = [
  ["invoices"],
  ["invoices-legacy"],
  ["invoice"],
  ["invoice-history"],
  ["invoice-vouchers"],
  ["invoice-statistics"],
  ["invoice-totals-by-ids"],
  ["first-invoice-details"],
  ["invoice-collectors"],
  ["unpaid-invoices"],
  ["ie-related-invoice"],
  ["room-latest-invoice"],
  ["payments"],
  ["payments-summary"],
  ["invoice-payments-summary"],
  ["dashboard-summary"],
  ["dashboard-alerts"],
  ["recent-activities"],
  ["deposit-dashboard"],
  ["cash-book"],
  ["cash-book-summary"],
  ["cash-flow-by-day"],
  ["settlement-report"],
  ["financial-analysis"],
  ["reports"],
  ["monthly-building-profit"],
  ["profit-verification"],
] as const;

const invalidateTerminationForfeitQueries = (
  queryClient: ReturnType<typeof useQueryClient>,
) => {
  for (const queryKey of TERMINATION_FORFEIT_QUERY_KEYS) {
    queryClient.invalidateQueries({ queryKey });
  }
};

const trySetTerminationForfeitStatus = async (
  id: string,
  status: "APPROVED" | "UNAPPROVED" | "CANCELLED",
) => {
  const { error } = await callUnregisteredRpc(
    "set_termination_forfeit_status_v1",
    { p_voucher_id: id, p_status: status },
  );
  if (!error) return true;
  if (isTerminationForfeitRpcUnavailable(error)) {
    if (await isConfidentlyOrdinaryVoucher(id)) return false;
    throw error;
  }
  if (
    error.code === "55000" &&
    error.message?.includes("not a termination forfeit pair")
  ) {
    return false;
  }
  throw error;
};

// Duyệt phiếu thu/chi (UNAPPROVED → APPROVED). Dùng khi đã thực thanh toán
// phiếu nháp (vd phiếu chi hoa hồng tạo cùng hợp đồng).
// Canonical approve_income_expense_v1 (phiếu flow-owned) trước; phiếu legacy
// nhận tín hiệu 'chưa thuộc luồng canonical' → dùng approve_voucher như cũ.
export const useApproveVoucher = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      try {
        if (await trySetTerminationForfeitStatus(id, "APPROVED")) return true;
      } catch (error: unknown) {
        toast.error(errorMessage(error, "Không thể duyệt phiếu"));
        throw error;
      }

      const canonical = await supabase.rpc("approve_income_expense_v1", {
        p_voucher_id: id,
      });
      if (!canonical.error) return false;
      if (!isIeLifecycleFallbackSignal(canonical.error)) {
        toast.error(canonical.error.message || "Không thể duyệt phiếu");
        throw canonical.error;
      }

      const { error } = await supabase.rpc("approve_voucher", {
        voucher_id: id,
      });
      if (error) {
        toast.error(error.message || "Không thể duyệt phiếu");
        throw error;
      }
      return false;
    },
    onSuccess: (isTerminationForfeit) => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      if (isTerminationForfeit) {
        invalidateTerminationForfeitQueries(queryClient);
      }
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
      try {
        if (await trySetTerminationForfeitStatus(id, "UNAPPROVED")) return true;
      } catch (error: unknown) {
        toast.error(errorMessage(error, "Không thể huỷ duyệt phiếu"));
        throw error;
      }

      const { error } = await supabase.rpc("unapprove_voucher", {
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
      return false;
    },
    onSuccess: (isTerminationForfeit) => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      if (isTerminationForfeit) {
        invalidateTerminationForfeitQueries(queryClient);
      }
      toast.success("Đã chuyển phiếu về Chờ duyệt");
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
    // Nhận id thuần (mọi caller cũ) hoặc {id, reason} — reason ghi vào bút toán
    // hoàn tác khi huỷ phiếu ĐÃ GHI SỔ (plan: huỷ sau-chi phải có bằng chứng).
    mutationFn: async (input: string | { id: string; reason?: string | null }) => {
      const id = typeof input === "string" ? input : input.id;
      const reason = typeof input === "string" ? null : (input.reason ?? null);
      try {
        if (await trySetTerminationForfeitStatus(id, "CANCELLED")) return true;
      } catch (error: unknown) {
        toast.error(errorMessage(error, "Không thể huỷ phiếu thu/chi"));
        throw error;
      }

      // Đợt 4 — NHÁNH LINH HOẠT ĐỨNG TRƯỚC. Một transaction: đảo bút toán +
      // đóng phiếu + ghi dấu vết, KHÔNG sinh phiếu đối ứng.
      //
      // Không cần hỏi cờ chế độ ở client: cứ thử, server tự từ chối bằng
      // [STRICT_MODE] (org đang bật Chuẩn kế toán) hoặc [NOT_MANUAL] (phiếu
      // thuộc luồng khác) và mình rơi xuống thang cũ. Nhờ vậy cờ cũ trong cache
      // client không bao giờ làm sai hành vi.
      //
      // Chỉ thử khi có lý do đủ dài — writer bắt buộc ≥8 ký tự để còn đối soát.
      if (reason && reason.trim().length >= 8) {
        const flex = await supabase.rpc("cancel_income_expense_flex_v1", {
          p_voucher: id,
          p_reason: reason.trim(),
          p_expected_approval_version: null,
          p_expected_posting_version: null,
        });
        if (!flex.error) return false;
        const flexMsg = flex.error.message ?? "";
        const canFallBack =
          flexMsg.includes("[STRICT_MODE]") || flexMsg.includes("[NOT_MANUAL]");
        if (!canFallBack) {
          toast.error(periodBlockMessage(flexMsg) ?? flexMsg ?? "Không thể huỷ phiếu thu/chi");
          throw flex.error;
        }
      }

      const { data: voucher, error: fetchErr } = await (supabase
        .from("income_expenses") as any)
        .select("id, type, payment_id, approval_status, account_id, posting_status")
        .eq("id", id)
        .maybeSingle();
      if (fetchErr) {
        toast.error(fetchErr.message || "Không thể đọc phiếu");
        throw fetchErr;
      }

      // Finance V2 §2.2: phiếu ĐÃ GHI SỔ không huỷ trực tiếp — HOÀN TÁC trước
      // (posting event REVERSAL trả tiền về sổ, giữ dấu vết) rồi mới huỷ.
      // posting_status chưa vào generated types → đọc qua cast.
      const postingStatus = (voucher as { posting_status?: string | null })
        ?.posting_status;
      if (postingStatus === "POSTED") {
        const rev = await supabase.rpc(
          "reverse_posted_income_expense_v2",
          {
            p_voucher: id,
            p_cashbook: voucher?.account_id ?? null,
            p_posted_on: todayISO(),
            p_reason: reason || "Hoàn tác để huỷ phiếu",
            p_idempotency_key: `cancel-rev-${id}-${Date.now()}`,
          },
        );
        if (rev.error) {
          toast.error(
            rev.error.message ||
              "Không thể hoàn tác tiền của phiếu đã ghi sổ — chưa huỷ được",
          );
          throw rev.error;
        }
      }

      // Canonical cancel (phiếu flow-owned): transition + audit hash-chain
      // server-side, KHÔNG đụng payments (phiếu canonical không gắn payment).
      // Phiếu legacy → tín hiệu fallback → giữ nguyên đường cũ bên dưới.
      const canonical = await supabase.rpc("cancel_income_expense_v1", {
        p_voucher_id: id,
        p_reason: reason,
      });
      if (!canonical.error) return false;
      // 7ac: phiếu do FLOW HỆ THỐNG sở hữu (vd Hoàn tiền hoá đơn) — cancel v1
      // từ chối 'owned by system flow'; huỷ qua dispatcher §8 (release
      // reservation atomic), KHÔNG rơi xuống compat.
      if (/owned by system flow/i.test(canonical.error.message ?? "")) {
        const owned = await supabase.rpc(
          "decide_owned_income_expense_v2",
          {
            p_voucher: id,
            p_decision: "cancel",
            p_reason: reason,
            p_idempotency_key: `owned-cancel-${id}-${Date.now()}`,
          },
        );
        if (owned.error) {
          toast.error(owned.error.message || "Không thể huỷ phiếu thu/chi");
          throw owned.error;
        }
        return false;
      }
      // Phiếu đã duyệt/đã hoàn tác: cancel v1 từ chối (chỉ nhận pending của
      // maker) — KHÔNG phải lỗi chặn, rơi xuống compat cancel (tự cấp token).
      const approvedShape =
        voucher?.approval_status === "APPROVED" ||
        postingStatus === "POSTED" ||
        postingStatus === "REVERSED";
      if (!isIeLifecycleFallbackSignal(canonical.error) && !approvedShape) {
        toast.error(canonical.error.message || "Không thể huỷ phiếu thu/chi");
        throw canonical.error;
      }

      // Stage-7 drain: huỷ phiếu legacy qua RPC ie_compat_cancel_v2 (client hết
      // UPDATE trực tiếp income_expenses). Phiếu đã POSTED (ghi sổ V2) bị server
      // từ chối 55000 — dùng reversal thay vì huỷ trực tiếp.
      const { error } = await callUnregisteredRpc("ie_compat_cancel_v2", {
        p_ids: [id],
        p_reason: reason,
      });
      if (error) {
        // 7ac: phiếu do FLOW HỆ THỐNG sở hữu (vd Hoàn tiền hoá đơn) — cả cancel
        // v1 lẫn compat đều từ chối; huỷ qua dispatcher §8 (release reservation).
        if (/owned by system flow/i.test(error.message ?? "")) {
          const owned = await supabase.rpc(
            "decide_owned_income_expense_v2",
            {
              p_voucher: id,
              p_decision: "cancel",
              p_reason: reason,
              p_idempotency_key: `owned-cancel-${id}-${Date.now()}`,
            },
          );
          if (owned.error) {
            toast.error(owned.error.message || "Không thể huỷ phiếu thu/chi");
            throw owned.error;
          }
          return false;
        }
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
      await supabase.rpc("log_income_expense_action", {
        p_id: id,
        p_action: "CANCELLED_NOTE",
        p_note: null,
      });
      return false;
    },
    onSuccess: (isTerminationForfeit) => {
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
      if (isTerminationForfeit) {
        invalidateTerminationForfeitQueries(queryClient);
      }
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
      const { error } = await supabase.rpc("restore_income_expense", {
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
      const canonical = await supabase.rpc("verify_income_expense_v1", {
        p_id: input.id,
        p_note: input.note,
      });
      if (!canonical.error) return;
      if (!isIeLifecycleFallbackSignal(canonical.error)) {
        toast.error(canonical.error.message || "Không thể đánh dấu đã kiểm");
        throw canonical.error;
      }

      const { error } = await supabase.rpc("verify_income_expense", {
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
