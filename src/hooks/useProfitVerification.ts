import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { VOUCHER_SOURCES } from "@/lib/voucherSources";

/**
 * B5 (thống nhất tài chính 04/07): dữ liệu cho thanh KIỂM CHỨNG trang
 * Phân bổ lợi nhuận — trả lời "tổng này có đủ/thiếu gì không" bằng số liệu
 * server-side (RPC aggregate, không dính cap 1000 của PostgREST):
 *
 *  - drafts:   phiếu NHÁP trong kỳ (bị loại vì trang chỉ tính APPROVED).
 *  - nonKqkd:  phần tiền KHÔNG hạch toán KQKD (item cọc, phiếu override,
 *              bút toán nội bộ…) = tổng-mọi-khoản − tổng-KQKD. Chỉ có nghĩa
 *              khi trang đang bật "chỉ KQKD" (pnlOnly).
 *  - fa:       đối chiếu engine chia cổ đông fa_monthly_pnl_accrual (SQL)
 *              với engine accrual client — lệch ≠ 0 là báo động đỏ.
 *  - invoice:  tiền ĐÃ THU của hoá đơn kỳ này (get_invoice_statistics_v2) —
 *              thông tin đối chiếu dòng tiền, lệch với doanh thu ghi nhận
 *              là BÌNH THƯỜNG (thu trước/sau kỳ, khoản ngoài hoá đơn).
 */

const INTERNAL_SOURCES = Object.entries(VOUCHER_SOURCES)
  .filter(([, m]) => m.internal)
  .map(([k]) => k);

export interface ProfitVerificationData {
  draftCount: number;
  draftTotal: number;
  /** Phần không-KQKD theo chiều thu/chi (0 khi tắt pnlOnly). */
  nonKqkdIncome: number;
  nonKqkdExpense: number;
  /** Phiếu APPROVED nhưng CHƯA CHỌN SỔ — không phân được lớp, nêu riêng. */
  noBookCount: number;
  noBookTotal: number;
  /** Tổng engine SQL fa_monthly_pnl_accrual (null = không chạy/không áp dụng). */
  fa: { income: number; expense: number; byBuilding: Map<string, { income: number; expense: number }> } | null;
  /** Đã thu thực tế của hoá đơn kỳ (mọi thời điểm thu). */
  invoicePaid: number | null;
}

export function useProfitVerification(opts: {
  ym: string; // 'YYYY-MM'
  startDate: string;
  endDate: string;
  buildingIds?: string[];
  pnlOnly: boolean;
  accrualMode: boolean;
  enabled?: boolean;
}) {
  const { ym, startDate, endDate, buildingIds, pnlOnly, accrualMode, enabled = true } = opts;
  const bIds = buildingIds?.length ? buildingIds : null;

  return useQuery({
    queryKey: ["profit-verification", ym, bIds, pnlOnly, accrualMode],
    enabled: enabled && !!ym,
    staleTime: 60_000,
    queryFn: async (): Promise<ProfitVerificationData> => {
      const statsArgs = {
        p_building_ids: bIds,
        p_start_date: startDate,
        p_end_date: endDate,
        p_internal_sources: INTERNAL_SOURCES,
      };

      const [draftRes, allRes, kqkdRes, faRes, invRes] = await Promise.all([
        // Phiếu nháp trong kỳ (mọi phiếu UNAPPROVED → rơi vào pending của RPC).
        (supabase.rpc as any)("get_income_expense_layer_stats", {
          ...statsArgs,
          p_approval: "UNAPPROVED",
        }),
        // Tổng mọi khoản APPROVED (total_amount, tách lớp).
        pnlOnly
          ? (supabase.rpc as any)("get_income_expense_layer_stats", {
              ...statsArgs,
              p_approval: "APPROVED",
            })
          : Promise.resolve({ data: null, error: null }),
        // Tổng KQKD (kqkd_amount, mọi phiếu APPROVED bất kể lớp/sổ).
        pnlOnly
          ? (supabase.rpc as any)("get_income_expense_layer_stats", {
              ...statsArgs,
              p_approval: "APPROVED",
              p_kqkd_only: true,
            })
          : Promise.resolve({ data: null, error: null }),
        // Engine chia cổ đông — chỉ đối chiếu được ở chế độ DỒN TÍCH + chỉ-KQKD
        // (fa_* luôn accrual + KQKD item-level).
        accrualMode && pnlOnly
          ? (supabase.rpc as any)("fa_monthly_pnl_accrual", {
              p_start_date: startDate,
              p_end_date: endDate,
              p_building_ids: bIds,
            })
          : Promise.resolve({ data: null, error: null }),
        // Đã thu của hoá đơn KỲ NÀY (billing_month) — mọi thời điểm thu.
        (supabase.rpc as any)("get_invoice_statistics_v2", {
          p_billing_month: ym,
          p_building_ids: bIds,
        }),
      ]);

      for (const r of [draftRes, allRes, kqkdRes, faRes, invRes]) {
        if (r?.error) console.error("useProfitVerification:", r.error);
      }

      const one = (res: any) =>
        Array.isArray(res?.data) ? res.data[0] : res?.data ?? null;

      const draft = one(draftRes);
      const all = one(allRes);
      const kqkd = one(kqkdRes);

      let nonKqkdIncome = 0;
      let nonKqkdExpense = 0;
      if (all && kqkd) {
        // Tổng mọi khoản = CASH + INTERNAL (pending = chưa chọn sổ, nêu riêng).
        const allIncome = (Number(all.cash_income) || 0) + (Number(all.internal_income) || 0);
        const allExpense = (Number(all.cash_expense) || 0) + (Number(all.internal_expense) || 0);
        nonKqkdIncome = Math.max(0, allIncome - (Number(kqkd.cash_income) || 0));
        nonKqkdExpense = Math.max(0, allExpense - (Number(kqkd.cash_expense) || 0));
      }

      let fa: ProfitVerificationData["fa"] = null;
      if (faRes?.data && Array.isArray(faRes.data)) {
        const byBuilding = new Map<string, { income: number; expense: number }>();
        let income = 0;
        let expense = 0;
        for (const row of faRes.data as any[]) {
          const inc = Number(row.revenue) || 0;
          const exp = Number(row.expense) || 0;
          income += inc;
          expense += exp;
          byBuilding.set(row.building_name ?? "—", { income: inc, expense: exp });
        }
        fa = { income, expense, byBuilding };
      }

      const inv = one(invRes);

      return {
        draftCount: Number(draft?.pending_count) || 0,
        draftTotal: Number(draft?.pending_total) || 0,
        nonKqkdIncome,
        nonKqkdExpense,
        noBookCount: Number(all?.pending_count) || 0,
        noBookTotal: Number(all?.pending_total) || 0,
        fa,
        invoicePaid: inv ? Number(inv.total_paid) || 0 : null,
      };
    },
  });
}
