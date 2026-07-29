// Đợt 6 — Chốt sổ & bàn giao quỹ, hai bên xác nhận.
//
// ĐẶT TÊN theo trục "chốt sổ / closure", CỐ Ý KHÔNG dùng chữ "bàn giao" ở tên
// hàm/khoá cache: repo này đã có ba thứ khác mang chữ đó — `cash_handovers`
// (bàn giao THEO PHIẾU, 7 phiên đang chạy), `asset_handovers` (bàn giao tài
// sản) và `cashbooks.manage_custody` (giao/nhận quyền giữ sổ). Trộn thêm nghĩa
// thứ tư vào là người đọc code lẫn người dùng đều nhầm.
//
// Tương tự, mã lỗi mới là [CLOSURE_*]; [CASHBOOK_CLOSED] giữ nguyên nghĩa "kỳ
// đã khoá" mà src/lib/cashbookClosing.ts đã dịch sẵn từ Đợt 3.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export interface ClosingBlocker {
  code: string;
  blocking: boolean;
  detail: string;
  count_n: number;
}

export interface PendingClosure {
  request_id: string;
  cashbook_id: string;
  cashbook_name: string;
  closed_through: string;
  counted_balance: number;
  system_balance: number;
  difference: number;
  note: string | null;
  created_at: string;
  proposed_by: string;
  proposed_by_name: string | null;
  confirmer_user_id: string;
  confirmer_name: string | null;
  is_mine_to_confirm: boolean;
}

export interface ConfirmedClosure {
  closure_id: number;
  cashbook_id: string;
  cashbook_name: string;
  closed_through: string;
  counted_balance: number;
  system_balance: number;
  difference: number;
  basis: string;
  confirmed_at: string;
  proposed_by_name: string | null;
  confirmed_by_name: string | null;
}

/** Mọi thứ đọc được đều đổi sau một lần chốt — gom một chỗ để khỏi sót. */
const CLOSING_KEYS = [
  ["cashbook-closings"],
  ["cashbook-closing-blockers"],
  ["accounts-with-balance"],
  ["accounts"],
  ["cash-book-summary"],
  ["cash-flow-by-day"],
  ["settlement-report"],
  ["income-expenses"],
];

function invalidateAll(qc: ReturnType<typeof useQueryClient>) {
  for (const key of CLOSING_KEYS) qc.invalidateQueries({ queryKey: key });
}

/** Còn vướng gì trước khi chốt. blocking=false là nhắc nhở, không chặn. */
export const useClosingBlockers = (cashbookId: string | null | undefined) =>
  useQuery({
    queryKey: ["cashbook-closing-blockers", cashbookId],
    enabled: !!cashbookId,
    // Không cache lâu: người dùng vừa đi duyệt phiếu xong quay lại là phải thấy sạch.
    staleTime: 0,
    queryFn: async (): Promise<ClosingBlocker[]> => {
      const { data, error } = await (supabase.rpc as any)("cashbook_closing_blockers_v1", {
        p_cashbook: cashbookId,
      });
      if (error) throw new Error(error.message);
      return (data ?? []) as ClosingBlocker[];
    },
  });

/** Số dư theo posting-truth tới một ngày — CÙNG cơ sở với con số sẽ đóng băng. */
export const useCashbookBalanceAsOf = (
  cashbookId: string | null | undefined,
  asOf?: string | null,
) =>
  useQuery({
    queryKey: ["cashbook-balance-as-of", cashbookId, asOf ?? null],
    enabled: !!cashbookId,
    staleTime: 0,
    queryFn: async (): Promise<number | null> => {
      const { data, error } = await (supabase.rpc as any)("cashbook_balance_as_of_v1", {
        p_cashbook: cashbookId,
        p_as_of: asOf ?? null,
      });
      if (error) throw new Error(error.message);
      return data === null || data === undefined ? null : Number(data);
    },
  });

export const useCashbookClosings = (cashbookId?: string | null) =>
  useQuery({
    queryKey: ["cashbook-closings", cashbookId ?? null],
    queryFn: async (): Promise<{ pending: PendingClosure[]; closures: ConfirmedClosure[] }> => {
      const { data, error } = await (supabase.rpc as any)("list_cashbook_closings_v1", {
        p_cashbook: cashbookId ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? { pending: [], closures: [] }) as {
        pending: PendingClosure[];
        closures: ConfirmedClosure[];
      };
    },
  });

/**
 * Ai đủ tư cách NHẬN bàn giao sổ này (đã loại chính mình).
 * Hỏi server chứ không lọc ở client: quyền phụ thuộc cạnh phạm vi theo TỪNG SỔ,
 * client không có đủ dữ liệu để suy ra.
 */
export const useCashbookCloseConfirmers = (cashbookId: string | null | undefined) =>
  useQuery({
    queryKey: ["cashbook-close-confirmers", cashbookId],
    enabled: !!cashbookId,
    staleTime: 60_000,
    queryFn: async (): Promise<Array<{ user_id: string; full_name: string | null }>> => {
      const { data, error } = await (supabase.rpc as any)("cashbook_close_confirmers_v1", {
        p_cashbook: cashbookId,
      });
      if (error) throw new Error(error.message);
      return (data ?? []) as Array<{ user_id: string; full_name: string | null }>;
    },
  });

export interface ProposeClosingInput {
  cashbookId: string;
  countedBalance: number;
  confirmerUserId: string;
  note?: string | null;
}

export const useProposeCashbookClosing = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ProposeClosingInput) => {
      const { data, error } = await (supabase.rpc as any)("propose_cashbook_closing_v1", {
        p_cashbook: input.cashbookId,
        p_counted_balance: input.countedBalance,
        p_confirmer: input.confirmerUserId,
        p_note: input.note ?? null,
      });
      if (error) throw new Error(error.message);
      return data as { request_id: string; difference: number };
    },
    onSuccess: (res) => {
      invalidateAll(qc);
      toast.success(
        Number(res?.difference) === 0
          ? "Đã gửi đề nghị chốt sổ — số đếm khớp sổ. Chờ bên nhận xác nhận."
          : "Đã gửi đề nghị chốt sổ. Chờ bên nhận xác nhận.",
      );
    },
    onError: (e: Error) => toast.error(e.message || "Không gửi được đề nghị chốt sổ"),
  });
};

export const useConfirmCashbookClosing = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { requestId: string; countedBalance: number }) => {
      const { data, error } = await (supabase.rpc as any)("confirm_cashbook_closing_v1", {
        p_request: input.requestId,
        p_counted_balance: input.countedBalance,
      });
      if (error) throw new Error(error.message);
      return data as { closure_id: number; closed_through: string };
    },
    onSuccess: (res) => {
      invalidateAll(qc);
      toast.success(`Đã chốt sổ tới ${res?.closed_through}. Kỳ này khoá vĩnh viễn.`);
    },
    onError: (e: Error) => toast.error(e.message || "Không xác nhận được"),
  });
};

export const useCancelCashbookClosing = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { requestId: string; reason: string }) => {
      const { data, error } = await (supabase.rpc as any)("cancel_cashbook_closing_v1", {
        p_request: input.requestId,
        p_reason: input.reason,
      });
      if (error) throw new Error(error.message);
      return data;
    },
    onSuccess: () => {
      invalidateAll(qc);
      toast.success("Đã huỷ đề nghị chốt sổ");
    },
    onError: (e: Error) => toast.error(e.message || "Không huỷ được đề nghị"),
  });
};
