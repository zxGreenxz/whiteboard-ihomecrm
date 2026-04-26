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

      // Fetch payments (income from invoices)
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
        ;

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
        ;

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

      // Fetch APPROVED income_expenses (thu/chi phát sinh ngoài hoá đơn)
      let incomeExpensesQuery = supabase
        .from("income_expenses")
        .select(`
          id,
          type,
          name,
          voucher_date,
          total_amount,
          building:buildings!income_expenses_building_id_fkey (
            name
          )
        `)
        .eq('approval_status', 'APPROVED');

      if (start_date) {
        incomeExpensesQuery = incomeExpensesQuery.gte("voucher_date", start_date);
      }
      if (end_date) {
        incomeExpensesQuery = incomeExpensesQuery.lte("voucher_date", end_date);
      }

      const { data: incomeExpenses, error: incomeExpensesError } = await incomeExpensesQuery;

      if (incomeExpensesError) {
        toast.error("Không thể tải dữ liệu thu chi phát sinh");
        throw incomeExpensesError;
      }

      // Add income_expenses to entries
      incomeExpenses?.forEach((ie: any) => {
        const buildingName = ie.building?.name || "";
        const prefix = ie.type === "INCOME" ? "Thu" : "Chi";
        const desc = buildingName
          ? `${prefix} phát sinh: ${ie.name} (${buildingName})`
          : `${prefix} phát sinh: ${ie.name}`;
        entries.push({
          id: ie.id,
          date: ie.voucher_date,
          type: ie.type as "INCOME" | "EXPENSE",
          description: desc,
          amount: ie.total_amount || 0,
          reference_id: ie.id,
          reference_type: "income_expense",
        });
      });

      // Sort by date descending
      entries.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

      return entries;
    },
  });
};


// Get cash book summary (includes payments, expenses, and approved income_expenses)
export const useCashBookSummary = (start_date?: string, end_date?: string) => {
  return useQuery({
    queryKey: ["cash-book-summary", start_date, end_date],
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Get total income from payments (invoices)
      let incomeQuery = supabase
        .from("payments")
        .select("amount")
        ;

      if (start_date) {
        incomeQuery = incomeQuery.gte("payment_date", start_date);
      }
      if (end_date) {
        incomeQuery = incomeQuery.lte("payment_date", end_date);
      }

      const { data: incomeData, error: incomeError } = await incomeQuery;
      if (incomeError) throw incomeError;

      const paymentIncome = incomeData?.reduce((sum, p) => sum + (p.amount || 0), 0) || 0;

      // Get total expenses
      let expenseQuery = supabase
        .from("expenses")
        .select("amount")
        ;

      if (start_date) {
        expenseQuery = expenseQuery.gte("expense_date", start_date);
      }
      if (end_date) {
        expenseQuery = expenseQuery.lte("expense_date", end_date);
      }

      const { data: expenseData, error: expenseError } = await expenseQuery;
      if (expenseError) throw expenseError;

      const legacyExpense = expenseData?.reduce((sum, e) => sum + (e.amount || 0), 0) || 0;

      // Get APPROVED income_expenses (thu/chi phát sinh)
      let ieQuery = supabase
        .from("income_expenses")
        .select("type, total_amount")
        .eq('approval_status', 'APPROVED');

      if (start_date) {
        ieQuery = ieQuery.gte("voucher_date", start_date);
      }
      if (end_date) {
        ieQuery = ieQuery.lte("voucher_date", end_date);
      }

      const { data: ieData, error: ieError } = await ieQuery;
      if (ieError) throw ieError;

      const ieIncome = ieData?.filter(ie => ie.type === 'INCOME').reduce((sum, ie) => sum + (ie.total_amount || 0), 0) || 0;
      const ieExpense = ieData?.filter(ie => ie.type === 'EXPENSE').reduce((sum, ie) => sum + (ie.total_amount || 0), 0) || 0;

      const totalIncome = paymentIncome + ieIncome;
      const totalExpense = legacyExpense + ieExpense;

      // Calculate opening balance (sum before start_date)
      let openingBalance = 0;
      if (start_date) {
        const { data: prevIncome } = await supabase
          .from("payments")
          .select("amount")
          .lt("payment_date", start_date);

        const { data: prevExpense } = await supabase
          .from("expenses")
          .select("amount")
          .lt("expense_date", start_date);

        // Previous APPROVED income_expenses
        const { data: prevIE } = await supabase
          .from("income_expenses")
          .select("type, total_amount")
          .eq('approval_status', 'APPROVED')
          .lt("voucher_date", start_date);

        const prevIncomeTotal = (prevIncome?.reduce((sum, p) => sum + (p.amount || 0), 0) || 0)
          + (prevIE?.filter(ie => ie.type === 'INCOME').reduce((sum, ie) => sum + (ie.total_amount || 0), 0) || 0);
        const prevExpenseTotal = (prevExpense?.reduce((sum, e) => sum + (e.amount || 0), 0) || 0)
          + (prevIE?.filter(ie => ie.type === 'EXPENSE').reduce((sum, ie) => sum + (ie.total_amount || 0), 0) || 0);

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

// Get cash flow data by day (includes payments, expenses, and approved income_expenses)
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
        .gte("payment_date", start_date)
        .lte("payment_date", end_date);

      // Get expenses by day
      const { data: expenses } = await supabase
        .from("expenses")
        .select("expense_date, amount")
        .gte("expense_date", start_date)
        .lte("expense_date", end_date);

      // Get APPROVED income_expenses by day
      const { data: incomeExpenses } = await supabase
        .from("income_expenses")
        .select("voucher_date, type, total_amount")
        .eq('approval_status', 'APPROVED')
        .gte("voucher_date", start_date)
        .lte("voucher_date", end_date);

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

      // Add approved income_expenses to daily totals
      incomeExpenses?.forEach((ie) => {
        const date = ie.voucher_date;
        if (!dateMap[date]) {
          dateMap[date] = { date, income: 0, expense: 0 };
        }
        if (ie.type === 'INCOME') {
          dateMap[date].income += ie.total_amount || 0;
        } else {
          dateMap[date].expense += ie.total_amount || 0;
        }
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
