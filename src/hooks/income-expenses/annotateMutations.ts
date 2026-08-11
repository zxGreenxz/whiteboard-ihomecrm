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
  // Tên key của màn chi tiết phiếu là `voucher-with-batch` (xem useVoucherDetail).
  // Trước 11/08/2026 mọi nơi ở đây bắn vào `voucher-detail` — một key KHÔNG query
  // nào dùng, nên `invalidateQueries` im lặng không khớp ai và màn chi tiết giữ
  // dữ liệu cũ sau khi sửa. Chỉ hub realtime bắn đúng key, nên lỗi bị che sau
  // 800ms debounce của hub và trông như "hơi chậm" thay vì "không cập nhật".
  ["voucher-with-batch"],
  ["ie-history"],
  ["utility-payments"],
  ["period-fee-status"],
] as const;

export const useAnnotateIncomeExpense = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: AnnotateIncomeExpenseInput) => {
      // Không cast: `annotate_income_expense_v1` đã có trong generated types, nên
      // compiler kiểm được cả tên RPC lẫn tên tham số. Cast `as any` ở đây là di
      // sản từ thời types.ts chưa mô tả hàm này — giữ lại chỉ để lại một chỗ mà
      // gõ sai `p_voucher` vẫn biên dịch sạch.
      const { data, error } = await supabase.rpc(
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
