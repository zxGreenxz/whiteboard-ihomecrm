import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

// =============================================
// Types
// =============================================

export interface CashTransaction {
  id: string;
  date: string;
  type: 'INCOME' | 'EXPENSE';
  category: string;
  description: string;
  amount: number;
  payment_method?: string;
  related_to?: {
    type: 'INVOICE' | 'CONTRACT' | 'OTHER';
    id: string;
    title?: string;
  };
  balance?: number; // Running balance
}

export interface CashBookSummary {
  opening_balance: number;
  total_income: number;
  total_expense: number;
  closing_balance: number;
  transaction_count: number;
}

export interface CashBookData {
  transactions: CashTransaction[];
  summary: CashBookSummary;
}

export interface CashBookFilters {
  start_date: string;
  end_date: string;
}

// =============================================
// Get Cash Book Data
// =============================================

export const useCashBook = (filters: CashBookFilters) => {
  return useQuery({
    queryKey: ['cash_book', filters],
    queryFn: async (): Promise<CashBookData> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Fetch payments (INCOME)
      const { data: payments, error: paymentsError } = await supabase
        .from('payments')
        .select(`
          id,
          payment_date,
          amount,
          payment_method,
          notes,
          invoice:invoices!payments_invoice_id_fkey (
            id,
            title,
            contract:contracts!invoices_contract_id_fkey (
              tenant:tenants!contracts_tenant_id_fkey (
                full_name
              )
            )
          )
        `)
        .eq('user_id', user.id)
        .gte('payment_date', filters.start_date)
        .lte('payment_date', filters.end_date)
        .order('payment_date', { ascending: true });

      if (paymentsError) throw paymentsError;

      // Fetch expenses (EXPENSE) - currently not implemented in previous phases
      // We'll prepare the structure for future implementation
      const { data: expenses, error: expensesError } = await supabase
        .from('expenses')
        .select(`
          id,
          expense_date,
          amount,
          payment_method,
          category,
          description,
          notes
        `)
        .eq('user_id', user.id)
        .gte('expense_date', filters.start_date)
        .lte('expense_date', filters.end_date)
        .order('expense_date', { ascending: true });

      // If expenses table doesn't exist yet, just use empty array
      const expensesList = expensesError ? [] : (expenses || []);

      // Convert payments to transactions
      const incomeTransactions: CashTransaction[] = (payments || []).map((payment) => ({
        id: payment.id,
        date: payment.payment_date,
        type: 'INCOME' as const,
        category: 'Thanh toán từ khách',
        description: payment.invoice
          ? `${payment.invoice.title} - ${payment.invoice.contract?.tenant?.full_name || 'N/A'}`
          : payment.notes || 'Thanh toán',
        amount: payment.amount,
        payment_method: payment.payment_method,
        related_to: payment.invoice
          ? {
              type: 'INVOICE' as const,
              id: payment.invoice.id,
              title: payment.invoice.title || undefined,
            }
          : undefined,
      }));

      // Convert expenses to transactions
      const expenseTransactions: CashTransaction[] = expensesList.map((expense: any) => ({
        id: expense.id,
        date: expense.expense_date,
        type: 'EXPENSE' as const,
        category: expense.category || 'Chi phí khác',
        description: expense.description || expense.notes || 'Chi phí',
        amount: expense.amount,
        payment_method: expense.payment_method,
      }));

      // Combine and sort all transactions by date
      const allTransactions = [...incomeTransactions, ...expenseTransactions].sort((a, b) =>
        a.date.localeCompare(b.date)
      );

      // Calculate opening balance (sum of all transactions before start_date)
      const { data: previousPayments } = await supabase
        .from('payments')
        .select('amount')
        .eq('user_id', user.id)
        .lt('payment_date', filters.start_date);

      const { data: previousExpenses } = await supabase
        .from('expenses')
        .select('amount')
        .eq('user_id', user.id)
        .lt('expense_date', filters.start_date);

      const previousIncome = (previousPayments || []).reduce((sum, p) => sum + p.amount, 0);
      const previousExpense = previousExpenses
        ? (previousExpenses || []).reduce((sum: number, e: any) => sum + e.amount, 0)
        : 0;

      const opening_balance = previousIncome - previousExpense;

      // Calculate running balance for each transaction
      let runningBalance = opening_balance;
      const transactionsWithBalance = allTransactions.map((transaction) => {
        if (transaction.type === 'INCOME') {
          runningBalance += transaction.amount;
        } else {
          runningBalance -= transaction.amount;
        }
        return {
          ...transaction,
          balance: runningBalance,
        };
      });

      // Calculate summary
      const total_income = incomeTransactions.reduce((sum, t) => sum + t.amount, 0);
      const total_expense = expenseTransactions.reduce((sum, t) => sum + t.amount, 0);
      const closing_balance = opening_balance + total_income - total_expense;

      const summary: CashBookSummary = {
        opening_balance,
        total_income,
        total_expense,
        closing_balance,
        transaction_count: allTransactions.length,
      };

      return {
        transactions: transactionsWithBalance,
        summary,
      };
    },
  });
};

// =============================================
// Get Cash Flow (for Chart)
// =============================================

export interface CashFlowData {
  date: string;
  income: number;
  expense: number;
  net: number;
}

export const useCashFlow = (filters: CashBookFilters) => {
  return useQuery({
    queryKey: ['cash_flow', filters],
    queryFn: async (): Promise<CashFlowData[]> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Fetch payments grouped by date
      const { data: payments, error: paymentsError } = await supabase
        .from('payments')
        .select('payment_date, amount')
        .eq('user_id', user.id)
        .gte('payment_date', filters.start_date)
        .lte('payment_date', filters.end_date);

      if (paymentsError) throw paymentsError;

      // Fetch expenses grouped by date
      const { data: expenses, error: expensesError } = await supabase
        .from('expenses')
        .select('expense_date, amount')
        .eq('user_id', user.id)
        .gte('expense_date', filters.start_date)
        .lte('expense_date', filters.end_date);

      // If expenses table doesn't exist, use empty array
      const expensesList = expensesError ? [] : (expenses || []);

      // Group payments by date
      const incomeByDate = new Map<string, number>();
      (payments || []).forEach((payment) => {
        const existing = incomeByDate.get(payment.payment_date) || 0;
        incomeByDate.set(payment.payment_date, existing + payment.amount);
      });

      // Group expenses by date
      const expenseByDate = new Map<string, number>();
      expensesList.forEach((expense: any) => {
        const existing = expenseByDate.get(expense.expense_date) || 0;
        expenseByDate.set(expense.expense_date, existing + expense.amount);
      });

      // Get all unique dates
      const allDates = new Set([...incomeByDate.keys(), ...expenseByDate.keys()]);

      // Create cash flow data
      const cashFlowData: CashFlowData[] = Array.from(allDates)
        .sort()
        .map((date) => {
          const income = incomeByDate.get(date) || 0;
          const expense = expenseByDate.get(date) || 0;
          return {
            date,
            income,
            expense,
            net: income - expense,
          };
        });

      return cashFlowData;
    },
  });
};
