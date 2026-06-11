import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
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

      const { data: incomeExpenses, error: ieError } = await ieQuery;
      if (ieError) {
        toast.error("Không thể tải sổ quỹ");
        throw ieError;
      }

      const entries: CashBookEntry[] = (incomeExpenses || []).map((ie: any) => {
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

      const sumByType = (rows: Array<{ type: string; total_amount: number | string | null }> | null) => {
        let income = 0;
        let expense = 0;
        for (const r of rows ?? []) {
          const amt = Number(r.total_amount) || 0;
          if (r.type === 'INCOME') income += amt;
          else if (r.type === 'EXPENSE') expense += amt;
        }
        return { income, expense };
      };

      // Trong kỳ
      let ieQuery = supabase
        .from("income_expenses")
        .select("type, total_amount")
        .eq('approval_status', 'APPROVED')
        .is('deleted_at', null);
      if (start_date) ieQuery = ieQuery.gte("voucher_date", start_date);
      if (end_date) ieQuery = ieQuery.lte("voucher_date", end_date);
      if (buildingId) ieQuery = ieQuery.eq("building_id", buildingId);
      if (accountId) ieQuery = ieQuery.eq("account_id", accountId);

      const { data: ieData, error: ieError } = await ieQuery;
      if (ieError) throw ieError;
      const { income: totalIncome, expense: totalExpense } = sumByType(ieData as any);

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

      let ieQuery = supabase
        .from("income_expenses")
        .select("voucher_date, type, total_amount")
        .eq('approval_status', 'APPROVED')
        .is('deleted_at', null)
        .gte("voucher_date", start_date)
        .lte("voucher_date", end_date);
      if (buildingId) ieQuery = ieQuery.eq("building_id", buildingId);
      if (accountId) ieQuery = ieQuery.eq("account_id", accountId);
      const { data: incomeExpenses, error } = await ieQuery;
      if (error) throw error;

      const dateMap: Record<string, { date: string; income: number; expense: number }> = {};
      for (const ie of incomeExpenses ?? []) {
        const date = ie.voucher_date as string;
        if (!dateMap[date]) dateMap[date] = { date, income: 0, expense: 0 };
        const amt = Number(ie.total_amount) || 0;
        if (ie.type === 'INCOME') dateMap[date].income += amt;
        else if (ie.type === 'EXPENSE') dateMap[date].expense += amt;
      }

      return Object.values(dateMap).sort(
        (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
      );
    },
    enabled: !!start_date && !!end_date,
  });
};
