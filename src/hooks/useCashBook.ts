import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
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

// Fetch cash book entries (combines payments and expenses)
export const useCashBook = (start_date?: string, end_date?: string) => {
  return useQuery({
    queryKey: ["cash-book", start_date, end_date],
    queryFn: async (): Promise<CashBookEntry[]> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const entries: CashBookEntry[] = [];

      // Fetch payments (income)
      let paymentsQuery = supabase
        .from("payments")
        .select(`
          id,
          payment_date,
          amount,
          payment_method,
          invoice_id,
          invoice:invoices!payments_invoice_id_fkey (
            invoice_number,
            contract:contracts!invoices_contract_id_fkey (
              tenant:tenants!contracts_tenant_id_fkey (
                full_name
              )
            )
          )
        `)
        .eq('user_id', user.id);

      if (start_date) {
        paymentsQuery = paymentsQuery.gte("payment_date", start_date);
      }
      if (end_date) {
        paymentsQuery = paymentsQuery.lte("payment_date", end_date);
      }

      const { data: payments, error: paymentsError } = await paymentsQuery;

      if (paymentsError) {
        toast.error("Không thể tải dữ liệu thanh toán");
        throw paymentsError;
      }

      // Add payments to entries
      payments?.forEach((payment: any) => {
        const tenantName = payment.invoice?.contract?.tenant?.full_name || "Không rõ";
        const invoiceNumber = payment.invoice?.invoice_number || "N/A";
        entries.push({
          id: payment.id,
          date: payment.payment_date,
          type: "INCOME",
          description: `Thu tiền ${tenantName} (HĐ: ${invoiceNumber})`,
          amount: payment.amount || 0,
          payment_method: payment.payment_method,
          reference_id: payment.invoice_id,
          reference_type: "invoice",
        });
      });

      // Fetch expenses (outcome)
      let expensesQuery = supabase
        .from("expenses")
        .select("*")
        .eq('user_id', user.id);

      if (start_date) {
        expensesQuery = expensesQuery.gte("expense_date", start_date);
      }
      if (end_date) {
        expensesQuery = expensesQuery.lte("expense_date", end_date);
      }

      const { data: expenses, error: expensesError } = await expensesQuery;

      if (expensesError) {
        toast.error("Không thể tải dữ liệu chi phí");
        throw expensesError;
      }

      // Add expenses to entries
      expenses?.forEach((expense) => {
        entries.push({
          id: expense.id,
          date: expense.expense_date,
          type: "EXPENSE",
          description: expense.description || "Chi phí",
          amount: expense.amount || 0,
          payment_method: expense.payment_method || undefined,
          reference_id: expense.id,
          reference_type: "expense",
        });
      });

      // Sort by date descending
      entries.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

      return entries;
    },
  });
};

// Get cash book summary
export const useCashBookSummary = (start_date?: string, end_date?: string) => {
  return useQuery({
    queryKey: ["cash-book-summary", start_date, end_date],
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Get total income
      let incomeQuery = supabase
        .from("payments")
        .select("amount")
        .eq('user_id', user.id);

      if (start_date) {
        incomeQuery = incomeQuery.gte("payment_date", start_date);
      }
      if (end_date) {
        incomeQuery = incomeQuery.lte("payment_date", end_date);
      }

      const { data: incomeData, error: incomeError } = await incomeQuery;
      if (incomeError) throw incomeError;

      const totalIncome = incomeData?.reduce((sum, p) => sum + (p.amount || 0), 0) || 0;

      // Get total expenses
      let expenseQuery = supabase
        .from("expenses")
        .select("amount")
        .eq('user_id', user.id);

      if (start_date) {
        expenseQuery = expenseQuery.gte("expense_date", start_date);
      }
      if (end_date) {
        expenseQuery = expenseQuery.lte("expense_date", end_date);
      }

      const { data: expenseData, error: expenseError } = await expenseQuery;
      if (expenseError) throw expenseError;

      const totalExpense = expenseData?.reduce((sum, e) => sum + (e.amount || 0), 0) || 0;

      // Calculate opening balance (sum before start_date)
      let openingBalance = 0;
      if (start_date) {
        const { data: prevIncome } = await supabase
          .from("payments")
          .select("amount")
          .eq('user_id', user.id)
          .lt("payment_date", start_date);

        const { data: prevExpense } = await supabase
          .from("expenses")
          .select("amount")
          .eq('user_id', user.id)
          .lt("expense_date", start_date);

        const prevIncomeTotal = prevIncome?.reduce((sum, p) => sum + (p.amount || 0), 0) || 0;
        const prevExpenseTotal = prevExpense?.reduce((sum, e) => sum + (e.amount || 0), 0) || 0;

        openingBalance = prevIncomeTotal - prevExpenseTotal;
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

// Get cash flow data by day
export const useCashFlowByDay = (start_date: string, end_date: string) => {
  return useQuery({
    queryKey: ["cash-flow-by-day", start_date, end_date],
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Get payments by day
      const { data: payments } = await supabase
        .from("payments")
        .select("payment_date, amount")
        .eq('user_id', user.id)
        .gte("payment_date", start_date)
        .lte("payment_date", end_date);

      // Get expenses by day
      const { data: expenses } = await supabase
        .from("expenses")
        .select("expense_date, amount")
        .eq('user_id', user.id)
        .gte("expense_date", start_date)
        .lte("expense_date", end_date);

      // Group by date
      const dateMap: Record<string, { date: string; income: number; expense: number }> = {};

      payments?.forEach((p) => {
        const date = p.payment_date;
        if (!dateMap[date]) {
          dateMap[date] = { date, income: 0, expense: 0 };
        }
        dateMap[date].income += p.amount || 0;
      });

      expenses?.forEach((e) => {
        const date = e.expense_date;
        if (!dateMap[date]) {
          dateMap[date] = { date, income: 0, expense: 0 };
        }
        dateMap[date].expense += e.amount || 0;
      });

      // Convert to array and sort
      const result = Object.values(dateMap).sort(
        (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
      );

      return result;
    },
    enabled: !!start_date && !!end_date,
  });
};
