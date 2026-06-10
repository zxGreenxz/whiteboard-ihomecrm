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

      // 1) Item ứng viên: kỳ giao tháng YM (cả 2 ngày non-null) HOẶC item null-period.
      //    Item null-period sẽ được lọc lại theo voucher_date ở bước ghép.
      const { data: itemsData, error: itemsErr } = await supabase
        .from("income_expense_items" as any)
        .select(
          "id, income_expense_id, income_expense_type_id, amount, quantity, unit_price, start_date, end_date"
        )
        .or(
          `and(start_date.lte.${lastOfMonth},end_date.gte.${firstOfMonth}),and(start_date.is.null,end_date.is.null)`
        );
      if (itemsErr) {
        console.error("useAccrualMonthReport items error:", itemsErr);
        return EMPTY;
      }
      const candidateItems = (itemsData ?? []) as any[];
      if (candidateItems.length === 0) return EMPTY;

      const voucherIds = Array.from(
        new Set(candidateItems.map((it) => it.income_expense_id))
      );

      // 2) Vouchers cha (+ filter tĩnh, KHÔNG lọc voucher_date vì kỳ có thể ngoài tháng).
      let vQuery = supabase
        .from("income_expenses" as any)
        .select(
          `
          id, name, type, voucher_date, counts_in_business_result, building_id, room_id,
          building:buildings!income_expenses_building_id_fkey ( id, name ),
          room:rooms!income_expenses_room_id_fkey ( id, name )
        `
        )
        .is("deleted_at", null)
        .in("id", voucherIds);

      if (filters.building_ids?.length) {
        // building_ids: mảng toà từ BuildingMultiSelect — không round-trip.
        vQuery = vQuery.in("building_id", filters.building_ids);
      }
      if (filters.building_id) vQuery = vQuery.eq("building_id", filters.building_id);
      if (filters.room_ids?.length) {
        vQuery = vQuery.in("room_id", filters.room_ids);
      } else if (filters.room_id) {
        vQuery = vQuery.eq("room_id", filters.room_id);
      }
      if (filters.type) vQuery = vQuery.eq("type", filters.type);
      if (filters.approval_status === "ALL_ACTIVE") {
        vQuery = vQuery.in("approval_status", ["APPROVED", "UNAPPROVED"]);
      } else if (filters.approval_status) {
        vQuery = vQuery.eq("approval_status", filters.approval_status);
      }
      if (businessResultOnly) {
        vQuery = vQuery.eq("counts_in_business_result", true);
      }

      const { data: vouchersData, error: vErr } = await vQuery;
      if (vErr) {
        console.error("useAccrualMonthReport vouchers error:", vErr);
        return EMPTY;
      }
      const voucherById = new Map<string, any>();
      for (const v of (vouchersData ?? []) as any[]) voucherById.set(v.id, v);
      if (voucherById.size === 0) return EMPTY;

      // 3) Loại hạng mục (tên + nhóm) để hiển thị.
      const typeIds = Array.from(
        new Set(candidateItems.map((it) => it.income_expense_type_id).filter(Boolean))
      );
      const typeById = new Map<string, { name: string; category: string | null }>();
      if (typeIds.length > 0) {
        const { data: typesData } = await supabase
          .from("income_expense_types" as any)
          .select("id, name, category")
          .in("id", typeIds);
        for (const t of (typesData ?? []) as any[]) {
          typeById.set(t.id, { name: t.name, category: t.category ?? null });
        }
      }

      // 4) Ghép: tính phần ghi nhận của mỗi item cho tháng YM.
      let totalIncome = 0;
      let totalExpense = 0;
      const rows: AccrualReportRow[] = [];

      for (const it of candidateItems) {
        const voucher = voucherById.get(it.income_expense_id);
        if (!voucher) continue; // voucher bị filter loại

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
          const vMonth = (voucher.voucher_date ?? "").slice(0, 7);
          portion = vMonth === month ? itemAmount : 0;
        }
        if (portion === 0) continue;

        const isIncome = voucher.type === "INCOME";
        if (isIncome) totalIncome += portion;
        else totalExpense += portion;

        const typeInfo = typeById.get(it.income_expense_type_id);
        rows.push({
          itemId: it.id,
          voucherId: voucher.id,
          voucherName: voucher.name ?? "",
          buildingName: voucher.building?.name ?? null,
          roomName: voucher.room?.name ?? null,
          typeName: typeInfo?.name ?? "",
          category: typeInfo?.category ?? null,
          startDate: it.start_date ?? null,
          endDate: it.end_date ?? null,
          income: isIncome ? portion : 0,
          expense: isIncome ? 0 : portion,
          countsInBusinessResult: voucher.counts_in_business_result ?? false,
        });
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
