// Đợt 4 — huỷ phiếu MỘT NHÁT ở chế độ linh hoạt.
//
// Hiệu ứng sổ cái giống hệt đường hai bước cũ (Hoàn tác rồi Huỷ) nhưng gộp vào
// một transaction, bắt buộc có lý do, và KHÔNG sinh phiếu đối ứng — đúng yêu
// cầu "hủy trực tiếp như cũ, trừ thẳng khỏi sổ quỹ, đổi lại ghi rõ mốc thời
// gian tạo/duyệt/huỷ và lý do".

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { periodBlockMessage } from "@/lib/cashbookClosing";

// Đo trên prod 30/07/2026 (pg_get_functiondef public.can_flex_cancel_v1): reader
// trả đúng 11 mã dưới đây. Thứ tự kiểm của server cũng là thứ tự ưu tiên:
// DELETED → ALREADY_CANCELLED → STRICT_MODE → RESTRICTED → NO_ACTIVE_POSTING →
// NO_PERMISSION → NOT_CUSTODIAN → (NOT_MANUAL | CASHBOOK_CLOSED |
// HANDOVER_LOCKED | PROFIT_LOCKED | UNKNOWN).
export type FlexCancelBlockCode =
  | "STRICT_MODE"
  | "NOT_MANUAL"
  | "CASHBOOK_CLOSED"
  | "HANDOVER_LOCKED"
  | "PROFIT_LOCKED"
  | "DELETED"
  | "ALREADY_CANCELLED"
  | "RESTRICTED"
  | "NO_ACTIVE_POSTING"
  | "NO_PERMISSION"
  | "NOT_CUSTODIAN"
  | "UNKNOWN";

export interface FlexCancelEligibility {
  id: string;
  eligible: boolean;
  reason_code: FlexCancelBlockCode | null;
}

/** Vì sao nút Huỷ nhanh không dùng được cho phiếu này. */
export const FLEX_CANCEL_BLOCK_TEXT: Record<FlexCancelBlockCode, string> = {
  STRICT_MODE: "Tổ chức đang bật Chuẩn kế toán — dùng Hoàn tác rồi Huỷ",
  NOT_MANUAL: "Phiếu do luồng khác quản lý — huỷ ở màn hình nguồn",
  CASHBOOK_CLOSED: "Sổ quỹ đã chốt & bàn giao",
  HANDOVER_LOCKED: "Đang trong phiên bàn giao",
  PROFIT_LOCKED: "Tháng đã chốt lợi nhuận",
  DELETED: "Phiếu đã bị xoá khỏi hệ thống",
  ALREADY_CANCELLED: "Phiếu đã huỷ trước đó",
  RESTRICTED: "Phiếu có hạng mục hạn chế — bạn không được phép đụng vào",
  NO_ACTIVE_POSTING:
    "Phiếu ghi Đã chi nhưng không tìm thấy bút toán gốc — báo quản trị trước khi huỷ",
  NO_PERMISSION: "Bạn không có quyền huỷ phiếu thu chi ở toà này",
  NOT_CUSTODIAN: "Bạn không phải Người giữ sổ của sổ quỹ trên phiếu",
  UNKNOWN: "Không huỷ nhanh được",
};

// Hai mã này KHÔNG phải "cấm huỷ", chỉ là "đường huỷ nhanh không áp dụng":
// statusMutations.useCancelIncomeExpense bắt đúng hai chuỗi [STRICT_MODE] /
// [NOT_MANUAL] rồi rơi xuống thang tương thích cũ. Giữ nút bật để không cắt
// mất đường đi còn sống — mờ nút ở đây là chặn oan.
export const FLEX_CANCEL_FALLBACK_CODES: ReadonlySet<FlexCancelBlockCode> =
  new Set<FlexCancelBlockCode>(["STRICT_MODE", "NOT_MANUAL"]);

export const flexCancelBlockText = (
  code: FlexCancelBlockCode | null | undefined,
): string => FLEX_CANCEL_BLOCK_TEXT[code ?? "UNKNOWN"] ?? FLEX_CANCEL_BLOCK_TEXT.UNKNOWN;

export interface FlexCancelGate {
  /** Nút Huỷ có bấm được không. */
  canCancel: boolean;
  /** true = đi cancel_income_expense_flex_v1 (CAS hai version); false = thang cũ. */
  useFlexWriter: boolean;
  /** Câu giải thích cho tooltip / hộp thoại; null = không có gì phải nói. */
  reason: string | null;
}

/**
 * Dịch một dòng can_flex_cancel_v1 thành trạng thái nút Huỷ.
 *
 * `undefined` = server KHÔNG trả dòng nào cho id này (không thuộc tổ chức, phiếu
 * đã biến mất) hoặc query còn đang chạy. Trường hợp đó KHÔNG mờ nút: mặc định
 * lạc quan rồi để writer từ chối, còn hơn khoá nhầm lúc mạng chậm.
 */
export const flexCancelGate = (
  row: FlexCancelEligibility | null | undefined,
): FlexCancelGate => {
  if (!row) return { canCancel: true, useFlexWriter: false, reason: null };
  if (row.eligible) return { canCancel: true, useFlexWriter: true, reason: null };

  const code = row.reason_code ?? "UNKNOWN";
  const text = flexCancelBlockText(code);
  if (FLEX_CANCEL_FALLBACK_CODES.has(code)) {
    return {
      canCancel: true,
      useFlexWriter: false,
      reason: `${text} — hệ thống sẽ thử đường huỷ cũ`,
    };
  }
  return { canCancel: false, useFlexWriter: false, reason: text };
};

/** Hỏi server phiếu nào huỷ nhanh được, để không bày nút rồi mới báo lỗi. */
export const useFlexCancelEligibility = (ids: string[]) =>
  useQuery({
    queryKey: ["flex-cancel-eligibility", [...ids].sort().join(",")],
    enabled: ids.length > 0,
    staleTime: 30_000,
    queryFn: async (): Promise<Record<string, FlexCancelEligibility>> => {
      const { data, error } = await (supabase.rpc as any)("can_flex_cancel_v1", {
        p_ids: ids,
      });
      if (error) throw new Error(error.message);
      const map: Record<string, FlexCancelEligibility> = {};
      for (const row of (data ?? []) as FlexCancelEligibility[]) map[row.id] = row;
      return map;
    },
  });

export interface FlexCancelInput {
  voucherId: string;
  reason: string;
  expectedApprovalVersion?: number | null;
  expectedPostingVersion?: number | null;
}

export const useCancelVoucherFlex = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: FlexCancelInput) => {
      const { data, error } = await (supabase.rpc as any)(
        "cancel_income_expense_flex_v1",
        {
          p_voucher: input.voucherId,
          p_reason: input.reason,
          p_expected_approval_version: input.expectedApprovalVersion ?? null,
          p_expected_posting_version: input.expectedPostingVersion ?? null,
        },
      );
      if (error) {
        const msg = error.message ?? "";
        if (msg.includes("[STRICT_MODE]")) {
          // Cờ chế độ phía client đã cũ — kéo lại rồi mới báo.
          queryClient.invalidateQueries({ queryKey: ["finance-v2-routes"] });
        }
        // 40001 = CAS chặn: người khác vừa đụng phiếu. Kéo lại danh sách để lần
        // bấm sau cầm đúng version, nếu không người dùng bấm mãi vẫn 40001.
        if (error.code === "40001") {
          queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
          queryClient.invalidateQueries({ queryKey: ["flex-cancel-eligibility"] });
        }
        toast.error(periodBlockMessage(msg) ?? msg ?? "Không huỷ được phiếu");
        throw error;
      }
      return data as { id: string; changed: boolean; cancellation_kind: string };
    },
    onSuccess: (data) => {
      for (const key of [
        ["income-expenses"],
        ["income-expense-batches"],
        ["accounts-with-balance"],
        ["cash-book"],
        ["cash-book-summary"],
        ["cash-flow-by-day"],
        ["voucher-detail"],
        ["ie-history"],
        ["settlement-report"],
        ["financial-analysis"],
        ["flex-cancel-eligibility"],
        ["voucher-cancellation"],
        ["voucher-change-log"],
      ]) {
        queryClient.invalidateQueries({ queryKey: key });
      }
      if (data?.changed === false) {
        toast.success("Phiếu đã ở trạng thái Đã huỷ từ trước");
        return;
      }
      toast.success(
        data?.cancellation_kind === "CANCELLED_AFTER_POSTING"
          ? "Phiếu đã được HUỶ — tiền đã trừ khỏi sổ quỹ"
          : "Phiếu đã được HUỶ",
      );
    },
    onError: (error) => {
      console.error("Error flex-cancelling voucher:", error);
    },
  });
};

export interface VoucherCancellation {
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancelled_by_name: string | null;
  cancel_reason: string | null;
  cancellation_kind: string | null;
  created_at: string | null;
  approved_at: string | null;
  amount: number | null;
}

/** Mốc lập / duyệt / huỷ + lý do, để đối soát lại khi cần. */
export const useVoucherCancellation = (voucherId: string | null | undefined) =>
  useQuery({
    queryKey: ["voucher-cancellation", voucherId],
    enabled: !!voucherId,
    queryFn: async (): Promise<VoucherCancellation | null> => {
      const { data, error } = await (supabase.rpc as any)(
        "get_voucher_cancellation_v1",
        { p_voucher: voucherId },
      );
      if (error) throw new Error(error.message);
      return (data ?? null) as VoucherCancellation | null;
    },
  });

// ── Nhật ký thay đổi (giá trị TRƯỚC / SAU) ──────────────────────────────────
// Nguồn: app_private.income_expense_change_log, trigger z99_ie_change_log
// (income_expenses: UPDATE + DELETE) và z99_ie_items_change_log
// (income_expense_items: INSERT + UPDATE + DELETE). Trigger đã lọc sẵn cột
// nhiễu (updated_at, *_version, hash…) nên dòng nào lên là dòng có nghĩa.

export type VoucherChangeScope = "VOUCHER" | "ITEM";
export type VoucherChangeOp = "INSERT" | "UPDATE" | "DELETE";

export interface VoucherChangeLogEntry {
  at: string;
  actor_id: string | null;
  actor_name: string | null;
  scope: VoucherChangeScope | string;
  op: VoucherChangeOp | string;
  /** Cột đã đổi; INSERT là ['*created*'], DELETE là ['*deleted*']. */
  cols: string[] | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/** Nhật ký trước/sau của mọi lần sửa/huỷ phiếu (mới nhất trước). */
export const useVoucherChangeLog = (voucherId: string | null | undefined) =>
  useQuery({
    queryKey: ["voucher-change-log", voucherId],
    enabled: !!voucherId,
    queryFn: async (): Promise<VoucherChangeLogEntry[]> => {
      const { data, error } = await (supabase.rpc as any)(
        "get_voucher_change_log_v1",
        { p_voucher: voucherId },
      );
      if (error) throw new Error(error.message);
      return (data ?? []) as VoucherChangeLogEntry[];
    },
  });
