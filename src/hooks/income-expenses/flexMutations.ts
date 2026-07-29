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

export type FlexCancelBlockCode =
  | "STRICT_MODE"
  | "NOT_MANUAL"
  | "CASHBOOK_CLOSED"
  | "HANDOVER_LOCKED"
  | "PROFIT_LOCKED"
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
  UNKNOWN: "Không huỷ nhanh được",
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
        toast.error(periodBlockMessage(msg) ?? msg ?? "Không huỷ được phiếu");
        throw error;
      }
      return data as { id: string; changed: boolean; cancellation_kind: string };
    },
    onSuccess: () => {
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
      ]) {
        queryClient.invalidateQueries({ queryKey: key });
      }
      toast.success("Phiếu đã được HUỶ — tiền đã trừ khỏi sổ quỹ");
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
