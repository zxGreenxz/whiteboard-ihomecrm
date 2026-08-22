import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { fetchAllRows } from "@/lib/supabaseFetchAll";

/**
 * Hạn PHẢI KÝ HỢP ĐỒNG của phiếu cọc giữ chỗ
 * (bảng `reservation_hold_deadlines`, migration 20260822010000).
 *
 * ĐỌC thẳng bảng dưới RLS; GHI bắt buộc qua `set_reservation_hold_deadline_v1`
 * — chỉ hàm đó mới kiểm được quyền TOÀ NHÀ của phiếu, thứ RLS không nhìn thấy
 * (policy chỉ biết `organization_id` của chính dòng hạn).
 *
 * KHÔNG có dòng ⇒ phiếu CHƯA đặt hạn. Đó KHÔNG phải "quá hạn" — xem bất biến
 * trong `buildDepositWorkQueue`: 23/24 phiếu đang chạy trên prod (đo
 * 21/08/2026) không có hạn nào, suy bừa sẽ tô đỏ cả sổ cọc thật.
 */

/** Bản đồ id phiếu → hạn "YYYY-MM-DD". */
export type HoldDeadlineMap = Readonly<Record<string, string>>;

export const HOLD_DEADLINE_KEY = ["reservation-hold-deadlines"] as const;

export function useReservationHoldDeadlines() {
  return useQuery({
    queryKey: HOLD_DEADLINE_KEY,
    queryFn: async (): Promise<HoldDeadlineMap> => {
      // PAGED: mỗi phiếu giữ chỗ một dòng, tích luỹ mãi theo thời gian.
      const rows = await fetchAllRows<{ income_expense_id: string; hold_until: string }>(
        (from, to) =>
          supabase
            .from("reservation_hold_deadlines")
            .select("income_expense_id, hold_until")
            .order("income_expense_id", { ascending: true })
            .range(from, to),
        { label: "deposits.holdDeadlines" },
      );
      // FAIL-CLOSED: đọc hỏng thì THROW. Trả {} sẽ làm mọi phiếu trông như
      // "chưa đặt hạn" và nhóm "quá hạn làm hợp đồng" biến mất im lặng — đúng
      // cái nhóm sinh ra để không ai bỏ quên phòng.
      if (rows === null) throw new Error("Lỗi tải hạn làm hợp đồng của phiếu giữ chỗ");
      const map: Record<string, string> = {};
      for (const r of rows) map[r.income_expense_id] = r.hold_until;
      return map;
    },
  });
}

export interface SetHoldDeadlineInput {
  incomeExpenseId: string;
  /** null = xoá hạn. */
  holdUntil: string | null;
}

export function useSetReservationHoldDeadline() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ incomeExpenseId, holdUntil }: SetHoldDeadlineInput) => {
      // `p_hold_until` khai `DEFAULT NULL` nên bộ sinh kiểu cho ra
      // `string | undefined`, không nhận `null`. Bỏ HẲN khoá là cách đúng ở đây
      // (xem `rpcNullable`: helper đó cố ý KHÔNG dành cho tham số có DEFAULT) —
      // và ngữ nghĩa trùng khít: default của hàm là NULL, mà NULL nghĩa là XOÁ
      // hạn. Không có đường nào để "bỏ qua" khác với "xoá", nên không mất gì.
      const { data, error } = await supabase.rpc("set_reservation_hold_deadline_v1", {
        p_income_expense_id: incomeExpenseId,
        p_hold_until: holdUntil ?? undefined,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (_d, vars) => {
      queryClient.invalidateQueries({ queryKey: HOLD_DEADLINE_KEY });
      toast.success(
        vars.holdUntil ? "Đã cập nhật hạn làm hợp đồng" : "Đã bỏ hạn làm hợp đồng",
      );
    },
    onError: (error: Error) => {
      toast.error(error.message || "Không đặt được hạn làm hợp đồng");
    },
  });
}
