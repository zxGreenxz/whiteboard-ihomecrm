import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useQuickExpense, type QuickExpenseActions } from '@/hooks/income-expenses/useQuickExpense';

const QuickExpenseContext = createContext<QuickExpenseActions | null>(null);
const waitingForList = 'Đang tải thông tin phiếu. Vui lòng chờ trước khi chi nhanh.';

/** The page owns the job; changing a tab or responsive layout only replaces its view. */
export function QuickExpenseProvider({ children }: { children: ReactNode }) {
  const actions = useQuickExpense('income-expense-page');
  return <QuickExpenseContext.Provider value={actions}>{children}</QuickExpenseContext.Provider>;
}

export function usePageQuickExpense(scopeKey: string, readReady = true): QuickExpenseActions {
  const actions = useContext(QuickExpenseContext);
  if (!actions) throw new Error('Chi nhanh cần được đặt trong trang Thu chi.');
  const { resetSelection } = actions;
  useEffect(() => { resetSelection(); }, [scopeKey, resetSelection]);

  // Refetching or replacing a view must block new submissions without cancelling
  // the already selected job. The owner retains its writer lock and unknown results.
  return {
    ...actions,
    ready: readReady && actions.ready,
    reason: voucher => readReady ? actions.reason(voucher) : waitingForList,
    batchReason: batch => readReady ? actions.batchReason(batch) : waitingForList,
    run: async rows => { if (readReady) await actions.run(rows); },
    runBatch: async batch => { if (readReady) await actions.runBatch(batch); },
    selectAll: async (filters, search) => { if (readReady) await actions.selectAll(filters, search); },
    toggle: (voucher, checked) => { if (!checked || readReady) actions.toggle(voucher, checked); },
    togglePage: (rows, checked) => { if (!checked || readReady) actions.togglePage(rows, checked); },
  };
}
