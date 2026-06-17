import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { allocateAmountByMonth } from "@/lib/accrualAllocation";
import { monthToStartDate, monthToEndDate } from "@/lib/monthPeriod";
import type { IncomeExpenseFilters } from "@/hooks/useIncomeExpenses";

/**
 * Báo cáo P&L của 1 tháng theo KỲ PHÂN BỔ (accrual):
 *  - Hạng mục có kỳ áp dụng [start, end] nhiều tháng → số tiền được CHIA ĐỀU ra
 *    các tháng; báo cáo tháng YM chỉ lấy phần thuộc tháng YM.
 *  - Hạng mục KHÔNG có kỳ (null) → ghi nhận TRỌN vào tháng của voucher_date.
 *
 * Khác với báo cáo theo voucher_date: một hạng mục lập phiếu tháng 3 nhưng kỳ
 * Jan–Mar vẫn đóng góp cho báo cáo tháng 1, tháng 2.
 *
 * Phân loại Thu/Chi lấy từ voucher.type (item không có cột type riêng) — nhất
 * quán với useIncomeExpenseStats. Tổng các phần qua mọi tháng của mọi item ==
 * tổng total_amount của voucher (vì Σ item.amount == voucher.total_amount).
 */

export interface AccrualReportRow {
  itemId: string;
  voucherId: string;
  voucherName: string;
  buildingName: string | null;
  roomName: string | null;
  typeName: string;
  category: string | null;
  /** Kỳ áp dụng (ngày DB), để hiển thị; null nếu item không gán kỳ. */
  startDate: string | null;
  endDate: string | null;
  /** Phần ghi nhận cho tháng đang xem. 1 trong 2 = số tiền, cái kia 0. */
  income: number;
  expense: number;
  countsInBusinessResult: boolean;
  /** Hoá đơn nguồn (phiếu thu sinh từ thanh toán HĐ) — gộp khoản thu cùng HĐ. */
  invoiceId: string | null;
}

export interface AccrualReportResult {
  totalIncome: number;
  totalExpense: number;
  difference: number;
  rows: AccrualReportRow[];
}

type AccrualFilters = Pick<
  IncomeExpenseFilters,
  | "building_id"
  | "building_ids"
  | "room_id"
  | "room_ids"
  | "type"
  | "approval_status"
  | "business_result_only"
>;

const EMPTY: AccrualReportResult = {
  totalIncome: 0,
  totalExpense: 0,
  difference: 0,
  rows: [],
};

// PostgREST trả tối đa 1000 dòng/trang → fetch-all phải phân trang theo `.range`.
const PARENT_PAGE = 1000;

// Lọc kỳ ở CẤP ITEM qua embedded inner-join (income_expense_items!inner) thay vì
// gom voucher_id rồi `.in("id", [hàng trăm UUID])` — cách cũ làm URL GET chục KB
// → PostgREST 400 → báo cáo rỗng oan (xem useIncomeExpenses.ts:124-128). `!inner`
// loại phiếu không có item khớp & mảng items[] chỉ chứa item khớp kỳ. Embed luôn
// tên+nhóm loại để khỏi query income_expense_types riêng.
const ACCRUAL_SELECT = `
  id, name, type, voucher_date, counts_in_business_result, building_id, room_id, invoice_id,
  building:buildings!income_expenses_building_id_fkey ( id, name ),
  room:rooms!income_expenses_room_id_fkey ( id, name ),
  items:income_expense_items!inner (
    id, income_expense_type_id, amount, quantity, unit_price, start_date, end_date,
    income_expense_type:income_expense_types!income_expense_items_income_expense_type_id_fkey ( id, name, category )
  )
`;

/**
 * @param month 'YYYY-MM' tháng cần xem báo cáo accrual.
 */
export const useAccrualMonthReport = (
  month: string,
  filters: AccrualFilters,
  opts?: { businessResultOnly?: boolean }
) => {
  const businessResultOnly = opts?.businessResultOnly ?? false;
  return useQuery({
    queryKey: [
      "income-expenses",
      "accrual-month",
      month,
      filters.building_id,
      filters.building_ids,
      filters.room_id,
      filters.room_ids,
      filters.type,
      filters.approval_status,
      businessResultOnly,
    ],
    queryFn: async (): Promise<AccrualReportResult> => {
      if (!month) return EMPTY;
      const firstOfMonth = monthToStartDate(month); // 'YYYY-MM-01'
      const lastOfMonth = monthToEndDate(month); // ngày cuối tháng

      // Lọc kỳ ở embedded item: kỳ giao tháng YM HOẶC item null-period (nhận lại
      // theo voucher_date ở bước transform). `!inner` ⇒ ràng buộc luôn phiếu cha.
      const periodOr =
        `and(start_date.lte.${lastOfMonth},end_date.gte.${firstOfMonth}),` +
        `and(start_date.is.null,end_date.is.null)`;

      // Query builder là thenable DÙNG-MỘT-LẦN → dựng mới mỗi trang. KHÔNG lọc
      // voucher_date (kỳ áp dụng có thể nằm ngoài tháng lập phiếu).
      const buildQuery = (from: number, to: number) => {
        let q = supabase
          .from("income_expenses" as any)
          .select(ACCRUAL_SELECT)
          .is("deleted_at", null)
          .or(periodOr, { referencedTable: "items" });

        if (filters.building_ids?.length) {
          // building_ids: mảng toà từ BuildingMultiSelect — không round-trip.
          q = q.in("building_id", filters.building_ids);
        }
        if (filters.building_id) q = q.eq("building_id", filters.building_id);
        if (filters.room_ids?.length) {
          q = q.in("room_id", filters.room_ids);
        } else if (filters.room_id) {
          q = q.eq("room_id", filters.room_id);
        }
        if (filters.type) q = q.eq("type", filters.type);
        if (filters.approval_status === "ALL_ACTIVE") {
          q = q.in("approval_status", ["APPROVED", "UNAPPROVED"]);
        } else if (filters.approval_status) {
          q = q.eq("approval_status", filters.approval_status);
        }
        if (businessResultOnly) q = q.eq("counts_in_business_result", true);

        // Tiebreaker `id` để phân trang không sót/trùng ở ranh giới trang.
        return q
          .order("voucher_date", { ascending: false })
          .order("id", { ascending: true })
          .range(from, to);
      };

      // Fetch-all: lặp từng trang 1000 tới khi trang ngắn hơn PARENT_PAGE.
      const vouchers: any[] = [];
      for (let from = 0; ; from += PARENT_PAGE) {
        const { data, error } = await buildQuery(from, from + PARENT_PAGE - 1);
        if (error) {
          console.error("useAccrualMonthReport error:", error);
          return EMPTY;
        }
        const pageRows = (data ?? []) as any[];
        vouchers.push(...pageRows);
        if (pageRows.length < PARENT_PAGE) break;
      }
      if (vouchers.length === 0) return EMPTY;

      // Transform: phân bổ từng item vào tháng YM (client-side).
      let totalIncome = 0;
      let totalExpense = 0;
      const rows: AccrualReportRow[] = [];

      for (const voucher of vouchers) {
        const isIncome = voucher.type === "INCOME";
        const vMonth = (voucher.voucher_date ?? "").slice(0, 7);
        for (const it of (voucher.items ?? []) as any[]) {
          const amount = Number(it.amount);
          const itemAmount = Number.isFinite(amount)
            ? amount
            : Number(it.quantity) * Number(it.unit_price) || 0;

          let portion = 0;
          if (it.start_date && it.end_date) {
            const alloc = allocateAmountByMonth(itemAmount, it.start_date, it.end_date);
            portion = alloc.find((p) => p.month === month)?.amount ?? 0;
          } else {
            // Null-period: ghi nhận trọn vào tháng của voucher_date.
            portion = vMonth === month ? itemAmount : 0;
          }
          if (portion === 0) continue;

          if (isIncome) totalIncome += portion;
          else totalExpense += portion;

          const t = it.income_expense_type;
          rows.push({
            itemId: it.id,
            voucherId: voucher.id,
            voucherName: voucher.name ?? "",
            buildingName: voucher.building?.name ?? null,
            roomName: voucher.room?.name ?? null,
            typeName: t?.name ?? "",
            category: t?.category ?? null,
            startDate: it.start_date ?? null,
            endDate: it.end_date ?? null,
            income: isIncome ? portion : 0,
            expense: isIncome ? 0 : portion,
            countsInBusinessResult: voucher.counts_in_business_result ?? false,
            invoiceId: voucher.invoice_id ?? null,
          });
        }
      }

      return {
        totalIncome,
        totalExpense,
        difference: totalIncome - totalExpense,
        rows,
      };
    },
  });
};
