// ĐỢT A — Huỷ PHIẾU THU: một cửa duy nhất, huỷ ở đâu cũng được.
//
// Trước đợt này, huỷ một phiếu thu ở trang Thu chi phải đi qua thang 6 bậc của
// useCancelIncomeExpense (forfeit → flex → reverse → canonical → decide_owned →
// compat). Phiếu thu do luồng hệ thống sinh ra bị từ chối ở MỌI bậc và người
// dùng nhận nguyên văn tiếng Anh của Postgres
// ("owned by system flow INVOICE_COLLECTION_V5").
//
// Nay server có `cancel_income_voucher_v1` tự rẽ nhánh (đợt thu hoá đơn V5 /
// cặp bỏ cọc / phiếu thường) và tự liên kết hoá đơn để mở lại nợ. Client chỉ
// còn gọi MỘT lần. Thang cũ giữ nguyên cho phiếu CHI — hai đường tách hẳn
// nhau theo yêu cầu của chủ.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { periodBlockMessage } from "@/lib/cashbookClosing";

/** Cách server sẽ huỷ phiếu — quyết định câu hỏi xác nhận ở UI. */
export type IncomeCancelMode = "MANUAL" | "COLLECTION" | "FORFEIT_PAIR";

export type IncomeCancelBlockCode =
  | "NOT_INCOME"
  | "DELETED"
  | "ALREADY_CANCELLED"
  | "NOT_OWNER"
  | "CASHBOOK_CLOSED"
  | "HANDOVER_LOCKED"
  | "PROFIT_LOCKED"
  | "LIFO_ORDER"
  | "CREDIT_SPENT"
  | "IS_REVERSAL"
  | "UNKNOWN";

export interface IncomeCancelEligibility {
  id: string;
  eligible: boolean;
  mode: IncomeCancelMode | null;
  reason_code: IncomeCancelBlockCode | null;
  /** Mã phiếu phải huỷ trước — chỉ có nghĩa với LIFO_ORDER. */
  blocking_voucher_code: string | null;
}

const BLOCK_TEXT: Record<IncomeCancelBlockCode, string> = {
  NOT_INCOME: "Đây là phiếu chi — huỷ ở luồng phiếu chi",
  DELETED: "Phiếu đã bị xoá khỏi hệ thống",
  ALREADY_CANCELLED: "Phiếu đã huỷ trước đó",
  NOT_OWNER:
    "Chỉ người đã thu khoản này hoặc chủ tổ chức mới huỷ được",
  CASHBOOK_CLOSED: "Sổ quỹ của phiếu đã chốt & bàn giao — kỳ đó khoá vĩnh viễn",
  HANDOVER_LOCKED:
    "Phiếu nằm trong phiên bàn giao đã xác nhận — phải huỷ phiên đó trước",
  PROFIT_LOCKED:
    "Tháng của phiếu đã chốt & chia lợi nhuận cho cổ đông — lập phiếu điều chỉnh ở tháng hiện tại",
  LIFO_ORDER: "Hoá đơn còn khoản thu mới hơn phải huỷ trước",
  CREDIT_SPENT:
    "Tiền thừa của lần thu này đã được cấn sang hoá đơn khác — gỡ khoản đã cấn trước",
  IS_REVERSAL: "Đây là bút toán đối ứng — huỷ phiếu gốc thay vì huỷ phiếu này",
  UNKNOWN: "Không huỷ được phiếu này",
};

export const incomeCancelBlockText = (
  row: IncomeCancelEligibility | null | undefined,
): string => {
  const code = row?.reason_code ?? "UNKNOWN";
  const base = BLOCK_TEXT[code] ?? BLOCK_TEXT.UNKNOWN;
  if (code === "LIFO_ORDER" && row?.blocking_voucher_code) {
    return `Phải huỷ phiếu ${row.blocking_voucher_code} trước — hệ thống gỡ khoản thu theo thứ tự ngược thời gian`;
  }
  return base;
};

export interface IncomeCancelGate {
  canCancel: boolean;
  mode: IncomeCancelMode | null;
  /** Câu giải thích cho tooltip; null = không có gì phải nói. */
  reason: string | null;
}

/**
 * Dịch một dòng can_cancel_income_voucher_v1 thành trạng thái nút Huỷ.
 *
 * `undefined` = server không trả dòng nào (phiếu của tổ chức khác) hoặc query
 * còn chạy. Mặc định LẠC QUAN rồi để writer từ chối — khoá nhầm lúc mạng chậm
 * khó chịu hơn là bấm rồi thấy lỗi.
 */
export const incomeCancelGate = (
  row: IncomeCancelEligibility | null | undefined,
): IncomeCancelGate => {
  if (!row) return { canCancel: true, mode: null, reason: null };
  if (row.eligible) return { canCancel: true, mode: row.mode, reason: null };
  return { canCancel: false, mode: row.mode, reason: incomeCancelBlockText(row) };
};

/** Hỏi server phiếu thu nào huỷ được, để không bày nút rồi mới báo lỗi. */
export const useIncomeCancelEligibility = (ids: string[]) =>
  useQuery({
    queryKey: ["income-cancel-eligibility", [...ids].sort().join(",")],
    enabled: ids.length > 0,
    staleTime: 30_000,
    queryFn: async (): Promise<Record<string, IncomeCancelEligibility>> => {
      const { data, error } = await (supabase.rpc as any)(
        "can_cancel_income_voucher_v1",
        { p_ids: ids },
      );
      if (error) throw new Error(error.message);
      const map: Record<string, IncomeCancelEligibility> = {};
      for (const row of (data ?? []) as IncomeCancelEligibility[]) map[row.id] = row;
      return map;
    },
  });

// ── Quyết định dùng cửa nào ──────────────────────────────────────────────
// Mọi màn hình hỏi CHUNG hàm này thay vì tự đoán theo type, để đường THU và
// đường CHI không bao giờ lệch nhau giữa nút bấm và writer thật sự chạy.

export interface VoucherCancelDecision {
  /** Nút Huỷ có bấm được không. */
  canCancel: boolean;
  /** Câu giải thích cho tooltip; null = không có gì phải nói. */
  reason: string | null;
  /** true = phiếu THU → cancel_income_voucher_v1 (một cửa). */
  useIncomeDoor: boolean;
  /** Chỉ có nghĩa khi !useIncomeDoor: đi writer linh hoạt (CAS 2 version). */
  useFlexWriter: boolean;
  /** Chỉ có nghĩa khi useIncomeDoor: huỷ cả đợt thu / cả cặp bỏ cọc? */
  mode: IncomeCancelMode | null;
}

export const voucherCancelDecision = (args: {
  type?: string | null;
  income?: IncomeCancelEligibility;
  /** Kết quả flexCancelGate() cho phiếu CHI — truyền vào để khỏi import chéo. */
  flexGate?: { canCancel: boolean; useFlexWriter: boolean; reason: string | null };
}): VoucherCancelDecision => {
  if (args.type === "INCOME") {
    const gate = incomeCancelGate(args.income);
    return {
      canCancel: gate.canCancel,
      reason: gate.reason,
      useIncomeDoor: true,
      useFlexWriter: false,
      mode: gate.mode,
    };
  }
  const flex = args.flexGate ?? { canCancel: true, useFlexWriter: false, reason: null };
  return {
    canCancel: flex.canCancel,
    reason: flex.reason,
    useIncomeDoor: false,
    useFlexWriter: flex.useFlexWriter,
    mode: null,
  };
};

export interface CancelIncomeVoucherInput {
  voucherId: string;
  /** Server bắt buộc ≥ 8 ký tự để còn đối soát về sau. */
  reason: string;
}

interface CancelIncomeVoucherResult {
  id: string;
  changed: boolean;
  mode?: IncomeCancelMode;
  cancellation_kind?: string;
  collection_id?: string;
}

/** Danh sách cache phải làm mới sau khi tiền rời sổ quỹ. */
const INVALIDATE_KEYS = [
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
  ["income-cancel-eligibility"],
  ["flex-cancel-eligibility"],
  ["voucher-cancellation"],
  ["voucher-change-log"],
  // Huỷ phiếu thu mở lại nợ hoá đơn → mọi màn hình công nợ phải đổi theo.
  ["invoices"],
  ["invoice-statistics"],
  ["payments"],
  ["utility-payments"],
  ["contracts"],
] as const;

export const useCancelIncomeVoucher = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CancelIncomeVoucherInput) => {
      const { data, error } = await (supabase.rpc as any)(
        "cancel_income_voucher_v1",
        { p_voucher: input.voucherId, p_reason: input.reason },
      );
      if (error) {
        const msg = error.message ?? "";
        toast.error(periodBlockMessage(msg) ?? msg ?? "Không huỷ được phiếu thu");
        throw error;
      }
      return data as CancelIncomeVoucherResult;
    },
    onSuccess: (data) => {
      for (const key of INVALIDATE_KEYS) {
        queryClient.invalidateQueries({ queryKey: key as unknown as string[] });
      }
      if (data?.changed === false) {
        toast.success("Phiếu đã ở trạng thái Đã huỷ từ trước");
        return;
      }
      if (data?.mode === "COLLECTION") {
        toast.success("Đã huỷ khoản thu — hoá đơn đã mở lại nợ");
        return;
      }
      if (data?.mode === "FORFEIT_PAIR") {
        toast.success("Đã huỷ cả cặp phiếu cấn cọc bỏ cọc");
        return;
      }
      toast.success(
        data?.cancellation_kind === "CANCELLED_AFTER_POSTING"
          ? "Phiếu thu đã được HUỶ — tiền đã trừ khỏi sổ quỹ"
          : "Phiếu thu đã được HUỶ",
      );
    },
    onError: (error) => {
      console.error("Error cancelling income voucher:", error);
    },
  });
};
