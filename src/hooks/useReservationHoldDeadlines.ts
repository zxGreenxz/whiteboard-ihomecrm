import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { fetchAllRows } from "@/lib/supabaseFetchAll";

/**
 * Kỳ hạn của phiếu cọc giữ chỗ — bảng `reservation_hold_deadlines`
 * (migration 20260822010000, mở rộng ở 20260822120000).
 *
 * HAI MỐC, HAI RỦI RO KHÁC NHAU — đừng gộp khi hiển thị:
 *   holdUntil     hạn phải KÝ HỢP ĐỒNG   → quá hạn là nguy cơ mất PHÒNG (của chủ)
 *   topupDueDate  hạn phải BỔ SUNG CỌC   → quá hạn là nguy cơ mất TIỀN (của khách)
 * `depositTarget` là số cọc phải đủ; thiếu nó thì không kết luận được "đã đủ chưa".
 *
 * ĐỌC thẳng bảng dưới RLS; GHI bắt buộc qua `set_reservation_hold_terms_v1` —
 * chỉ hàm đó mới kiểm được quyền TOÀ NHÀ của phiếu, thứ RLS không nhìn thấy
 * (policy chỉ biết `organization_id` của chính dòng kỳ hạn).
 *
 * KHÔNG có dòng ⇒ phiếu CHƯA đặt kỳ hạn nào. Đó KHÔNG phải "quá hạn" — xem bất
 * biến trong `buildDepositWorkQueue`.
 */

export interface ReservationHoldTerms {
  holdUntil: string | null;
  topupDueDate: string | null;
  depositTarget: number | null;
}

/** Bản đồ id phiếu → kỳ hạn. */
export type HoldTermsMap = Readonly<Record<string, ReservationHoldTerms>>;

export const HOLD_DEADLINE_KEY = ["reservation-hold-deadlines"] as const;

export function useReservationHoldDeadlines() {
  return useQuery({
    queryKey: HOLD_DEADLINE_KEY,
    queryFn: async (): Promise<HoldTermsMap> => {
      // PAGED: mỗi phiếu giữ chỗ một dòng, tích luỹ mãi theo thời gian.
      const rows = await fetchAllRows<{
        income_expense_id: string;
        hold_until: string | null;
        topup_due_date: string | null;
        deposit_target: number | null;
      }>(
        (from, to) =>
          supabase
            .from("reservation_hold_deadlines")
            .select("income_expense_id, hold_until, topup_due_date, deposit_target")
            .order("income_expense_id", { ascending: true })
            .range(from, to),
        { label: "deposits.holdDeadlines" },
      );
      // FAIL-CLOSED: đọc hỏng thì THROW. Trả {} sẽ làm mọi phiếu trông như
      // "chưa đặt hạn" và hai nhóm gấp nhất biến mất im lặng — đúng cái nhóm
      // sinh ra để không ai bỏ quên phòng hay để khách mất cọc oan.
      if (rows === null) throw new Error("Lỗi tải kỳ hạn của phiếu giữ chỗ");
      const map: Record<string, ReservationHoldTerms> = {};
      for (const r of rows) {
        map[r.income_expense_id] = {
          holdUntil: r.hold_until,
          topupDueDate: r.topup_due_date,
          depositTarget: r.deposit_target === null ? null : Number(r.deposit_target),
        };
      }
      return map;
    },
  });
}

export interface SetHoldTermsInput {
  incomeExpenseId: string;
  holdUntil: string | null;
  topupDueDate: string | null;
  depositTarget: number | null;
}

export function useSetReservationHoldTerms() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: SetHoldTermsInput) => {
      // Ba tham số đều khai `DEFAULT NULL` nên bộ sinh kiểu cho ra
      // `T | undefined`, không nhận `null`. Bỏ HẲN khoá là cách đúng ở đây
      // (xem `rpcNullable`: helper đó cố ý KHÔNG dành cho tham số có DEFAULT),
      // và ngữ nghĩa trùng khít: default của hàm là NULL, mà bỏ hết ba trường
      // nghĩa là XOÁ kỳ hạn — đúng thứ ta muốn khi truyền null.
      const { data, error } = await supabase.rpc("set_reservation_hold_terms_v1", {
        p_income_expense_id: input.incomeExpenseId,
        p_hold_until: input.holdUntil ?? undefined,
        p_topup_due_date: input.topupDueDate ?? undefined,
        p_deposit_target: input.depositTarget ?? undefined,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (_d, vars) => {
      queryClient.invalidateQueries({ queryKey: HOLD_DEADLINE_KEY });
      const conKyHan =
        vars.holdUntil !== null || vars.topupDueDate !== null || vars.depositTarget !== null;
      toast.success(conKyHan ? "Đã cập nhật kỳ hạn phiếu cọc" : "Đã bỏ kỳ hạn phiếu cọc");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Không đặt được kỳ hạn phiếu cọc");
    },
  });
}
