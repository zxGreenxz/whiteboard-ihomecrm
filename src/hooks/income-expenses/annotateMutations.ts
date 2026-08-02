// Đợt 2 — bổ sung ảnh chứng từ / ghi chú cho phiếu thu chi ở MỌI trạng thái.
//
// Thay cho `update_income_expense_quick` (chỉ người tạo dùng được, không ghi
// nhật ký, và cho đổi cả `account_id` — vốn là đường làm tiền rời sổ qua cầu
// a85). RPC mới chỉ đụng attachments + notes, hợp nhất ảnh phía server nên hai
// người cùng dán không đè mất của nhau, và luôn ghi một dòng nhật ký.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { periodBlockMessage } from "@/lib/cashbookClosing";

export interface AnnotateIncomeExpenseInput {
  voucherId: string;
  addAttachments?: string[];
  removeAttachments?: string[];
  /** null = không đụng ghi chú. Chuỗi rỗng = xoá trắng ghi chú. */
  notes?: string | null;
  noteMode?: "REPLACE" | "APPEND";
}

const INVALIDATE_KEYS = [
  ["income-expenses"],
  ["income-expense-batches"],
  ["voucher-detail"],
  ["ie-history"],
  ["utility-payments"],
  ["period-fee-status"],
] as const;

export const useAnnotateIncomeExpense = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: AnnotateIncomeExpenseInput) => {
      const { data, error } = await (supabase.rpc as any)(
        "annotate_income_expense_v1",
        {
          p_voucher: input.voucherId,
          p_add_attachments: input.addAttachments?.length
            ? input.addAttachments
            : null,
          p_remove_attachments: input.removeAttachments?.length
            ? input.removeAttachments
            : null,
          p_notes: input.notes ?? null,
          p_note_mode: input.noteMode ?? "REPLACE",
          p_idempotency_key: null,
        },
      );
      if (error) {
        // Kỳ đã đóng (Đợt 3) — nói rõ vì sao thay vì ném P0001 thô.
        const blocked = periodBlockMessage(error.message);
        toast.error(blocked ?? error.message ?? "Không lưu được chứng từ/ghi chú");
        throw error;
      }
      return data as { id: string; changed: boolean };
    },
    onSuccess: (result) => {
      for (const key of INVALIDATE_KEYS) {
        queryClient.invalidateQueries({ queryKey: key });
      }
      toast.success(
        result?.changed === false
          ? "Không có gì thay đổi"
          : "Đã lưu chứng từ / ghi chú",
      );
    },
    onError: (error) => {
      console.error("Error annotating income expense:", error);
    },
  });
};
