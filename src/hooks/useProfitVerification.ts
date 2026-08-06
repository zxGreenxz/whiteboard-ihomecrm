import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  calculateNonKqkdAmounts,
  requireProfitVerificationRpcData,
} from "@/lib/profitVerification";
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
  noBookIncome: number;
  noBookExpense: number;
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
        supabase.rpc("get_income_expense_layer_stats", {
          ...statsArgs,
          p_approval: "UNAPPROVED",
        }),
        // Tổng mọi khoản APPROVED (total_amount, tách lớp). Luôn tải để cảnh báo
        // phiếu đã duyệt nhưng chưa chọn sổ ở cả hai chế độ KQKD.
        supabase.rpc("get_income_expense_layer_stats", {
          ...statsArgs,
          p_approval: "APPROVED",
        }),
        // Tổng KQKD (kqkd_amount, mọi phiếu APPROVED bất kể lớp/sổ).
        pnlOnly
          ? supabase.rpc("get_income_expense_layer_stats", {
              ...statsArgs,
              p_approval: "APPROVED",
              p_kqkd_only: true,
            })
          : Promise.resolve({ data: null, error: null }),
        // Engine chia cổ đông — chỉ đối chiếu được ở chế độ DỒN TÍCH + chỉ-KQKD
        // (fa_* luôn accrual + KQKD item-level).
        accrualMode && pnlOnly
          ? supabase.rpc("fa_monthly_pnl_accrual", {
              p_start_date: startDate,
              p_end_date: endDate,
              p_building_ids: bIds,
            })
          : Promise.resolve({ data: null, error: null }),
        // Đã thu của hoá đơn KỲ NÀY (billing_month) — mọi thời điểm thu.
        supabase.rpc("get_invoice_statistics_v2", {
          p_billing_month: ym,
          p_building_ids: bIds,
        }),
      ]);

      const one = (label: string, res: any) => {
        const data = requireProfitVerificationRpcData<any>(label, res);
        const row = Array.isArray(data) ? data[0] : data;
        if (row == null) {
          throw new Error(`UNAVAILABLE: RPC ${label} không trả dòng tổng hợp`);
        }
        return row;
      };

      const draft = one("thống kê phiếu nháp", draftRes);
      const all = one("thống kê phiếu đã duyệt", allRes);
      const kqkd = pnlOnly ? one("thống kê KQKD", kqkdRes) : null;

      let nonKqkdIncome = 0;
      let nonKqkdExpense = 0;
      if (kqkd) {
        // Tổng mọi khoản gồm cả PENDING theo từng chiều. Phiếu APPROVED chưa chọn
        // sổ vẫn nằm trong báo cáo KQKD; chỉ lớp sổ quỹ của nó là chưa xác định.
        const nonKqkd = calculateNonKqkdAmounts(all, kqkd);
        nonKqkdIncome = nonKqkd.income;
        nonKqkdExpense = nonKqkd.expense;
      }

      let fa: ProfitVerificationData["fa"] = null;
      if (accrualMode && pnlOnly) {
        const faRows = requireProfitVerificationRpcData<any[]>(
          "engine chia cổ đông",
          faRes,
        );
        if (!Array.isArray(faRows)) {
          throw new Error("UNAVAILABLE: RPC engine chia cổ đông trả sai định dạng");
        }
        const byBuilding = new Map<string, { income: number; expense: number }>();
        let income = 0;
        let expense = 0;
        for (const row of faRows) {
          const inc = Number(row.revenue) || 0;
          const exp = Number(row.expense) || 0;
          income += inc;
          expense += exp;
          byBuilding.set(row.building_name ?? "—", { income: inc, expense: exp });
        }
        fa = { income, expense, byBuilding };
      }

      const inv = one("thống kê hoá đơn", invRes);

      return {
        draftCount: Number(draft?.pending_count) || 0,
        draftTotal: Number(draft?.pending_total) || 0,
        nonKqkdIncome,
        nonKqkdExpense,
        noBookCount: Number(all?.pending_count) || 0,
        noBookTotal: Number(all?.pending_total) || 0,
        noBookIncome: Number(all?.pending_income) || 0,
        noBookExpense: Number(all?.pending_expense) || 0,
        fa,
        invoicePaid: inv ? Number(inv.total_paid) || 0 : null,
      };
    },
  });
}
