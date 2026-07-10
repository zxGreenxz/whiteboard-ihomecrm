import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { fetchAllRows } from "@/lib/supabaseFetchAll";
import { toast } from "sonner";

export interface CashBookEntry {
  id: string;
  date: string;
  type: "INCOME" | "EXPENSE";
  description: string;
  amount: number;
  payment_method?: string;
  reference_id?: string;
  reference_type?: string;
}

// Sổ quỹ lấy từ income_expenses (canonical ledger). Mỗi payment hoá đơn
// đều có row mirror trong income_expenses (xem migration voucher_payment_link),
// còn bảng `expenses` legacy không dùng nữa — đọc thêm các bảng đó sẽ double-count.
export const useCashBook = (start_date?: string, end_date?: string) => {
  return useQuery({
    queryKey: ["cash-book", start_date, end_date],
    queryFn: async (): Promise<CashBookEntry[]> => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      // PAGED: sổ quỹ 1 kỳ có thể > 1000 dòng → phân trang (order + id tiebreaker).
      const incomeExpenses = await fetchAllRows<any>(
        (from, to) => {
          let ieQuery = supabase
            .from("income_expenses")
            .select(`
              id,
              type,
              name,
              voucher_date,
              total_amount,
              invoice_id,
              payment_id,
              building:buildings!income_expenses_building_id_fkey (
                name
              )
            `)
            .eq('approval_status', 'APPROVED')
            .is('deleted_at', null);
          if (start_date) ieQuery = ieQuery.gte("voucher_date", start_date);
          if (end_date) ieQuery = ieQuery.lte("voucher_date", end_date);
          return ieQuery.order("voucher_date", { ascending: false }).order("id", { ascending: true }).range(from, to);
        },
        { label: "cashbook.entries" },
      );
      if (incomeExpenses === null) {
        toast.error("Không thể tải sổ quỹ");
        throw new Error("Lỗi tải sổ quỹ (income_expenses)");
      }

      const entries: CashBookEntry[] = incomeExpenses.map((ie: any) => {
        const buildingName = ie.building?.name || "";
        const description = buildingName ? `${ie.name} (${buildingName})` : ie.name;
        return {
          id: ie.id,
          date: ie.voucher_date,
          type: ie.type as "INCOME" | "EXPENSE",
          description,
          amount: Number(ie.total_amount) || 0,
          reference_id: ie.payment_id || ie.invoice_id || ie.id,
          reference_type: ie.payment_id ? "payment" : ie.invoice_id ? "invoice" : "income_expense",
        };
      });

      entries.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      return entries;
    },
  });
};


// Tổng hợp sổ quỹ — chỉ đọc từ income_expenses (APPROVED, chưa xoá).
// Mọi payment hoá đơn đều có row mirror trong income_expenses nên cộng cả
// hai bảng sẽ double-count (bug đã thấy ở /report/finance/cash-flow).
export const useCashBookSummary = (
  start_date?: string,
  end_date?: string,
  options?: { building_id?: string; account_id?: string }
) => {
  const buildingId = options?.building_id;
  const accountId = options?.account_id;
  return useQuery({
    queryKey: ["cash-book-summary", start_date, end_date, buildingId, accountId],
    queryFn: async () => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      // Trong kỳ: RPC SQL aggregate (miễn nhiễm cap-1000) — thay client-reduce
      // trên select không phân trang (hụt tổng khi vượt 1000 phiếu/kỳ).
      const { data: periodTotals, error: ptErr } = await (supabase.rpc as any)(
        "cashbook_period_totals",
        {
          p_start: start_date ?? null,
          p_end: end_date ?? null,
          p_building_id: buildingId ?? null,
          p_account_id: accountId ?? null,
        },
      );
      if (ptErr) throw ptErr;
      const totalIncome = Number((periodTotals as any)?.income) || 0;
      const totalExpense = Number((periodTotals as any)?.expense) || 0;

      // Số dư đầu kỳ — RPC aggregate (migration 20260610110000): trả 1 số
      // thay vì kéo TOÀN BỘ lịch sử phiếu trước start_date về client cộng
      // tay (payload tăng vô hạn theo tuổi dữ liệu). SECURITY INVOKER nên
      // phạm vi nhìn thấy y hệt query cũ (qua RLS).
      let openingBalance = 0;
      if (start_date) {
        const { data: ob, error: obErr } = await (supabase.rpc as any)(
          "cashbook_opening_balance",
          {
            p_before_date: start_date,
            p_building_id: buildingId ?? null,
            p_account_id: accountId ?? null,
          },
        );
        if (obErr) throw obErr;
        openingBalance = Number(ob) || 0;
      }

      return {
        openingBalance,
        totalIncome,
        totalExpense,
        closingBalance: openingBalance + totalIncome - totalExpense,
        netCashFlow: totalIncome - totalExpense,
      };
    },
  });
};

// Dòng tiền theo ngày — chỉ đọc từ income_expenses (APPROVED, chưa xoá).
// Đã từng cộng thêm payments + expenses → double-count vì mỗi payment hoá đơn
// đã có mirror trong income_expenses.
export const useCashFlowByDay = (
  start_date: string,
  end_date: string,
  options?: { building_id?: string; account_id?: string }
) => {
  const buildingId = options?.building_id;
  const accountId = options?.account_id;
  return useQuery({
    queryKey: ["cash-flow-by-day", start_date, end_date, buildingId, accountId],
    queryFn: async () => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      // RPC SQL aggregate theo ngày (miễn nhiễm cap-1000): 1 dòng/ngày, đã group
      // + sort trong SQL → không kéo cả năm phiếu về client cộng tay.
      const { data, error } = await (supabase.rpc as any)("cashflow_by_day", {
        p_start: start_date,
        p_end: end_date,
        p_building_id: buildingId ?? null,
        p_account_id: accountId ?? null,
      });
      if (error) throw error;

      return ((data ?? []) as any[]).map((r) => ({
        date: r.day as string,
        income: Number(r.income) || 0,
        expense: Number(r.expense) || 0,
      }));
    },
    enabled: !!start_date && !!end_date,
  });
};
