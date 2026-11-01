import { useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { persistentFinancialWorkflow } from '@/lib/persistentFinancialWorkflow';
import {
  readCashbookReopeningState, reopenCashbook, validateReopenCashbookInput,
  type CashbookReopeningReceipt, type ReopenCashbookInput,
} from '@/lib/cashbookReopening';

export const useCashbookReopeningState = (cashbookId: string | null | undefined) => useQuery({
  meta: { feedback: 'inline' },
  queryKey: ['cashbook-reopening', cashbookId ?? null],
  enabled: !!cashbookId,
  staleTime: 0,
  queryFn: () => {
    if (!cashbookId) throw new Error('Chưa chọn sổ quỹ.');
    return readCashbookReopeningState(cashbookId);
  },
});

export const useReopenCashbook = () => {
  const qc = useQueryClient();
  const guard = useRef(persistentFinancialWorkflow('cashbook-reopening', { scope: 'actor' }));
  return useMutation({
    meta: { handlesFeedback: true },
    mutationFn: async (input: ReopenCashbookInput) => {
      const checked = validateReopenCashbookInput(input);
      return guard.current.run(checked.cashbookId, 'mở khóa sổ quỹ',
        progress => reopenCashbook(checked, progress.requestKey),
        async pending => {
          const state = await readCashbookReopeningState(checked.cashbookId);
          const event = state.history.find(row => row.idempotency_key === pending.requestKey);
          if (!event) return null;
          // A receipt proves the old attempt completed. A later re-close remains
          // intact; recovery never issues another write against the new period.
          const result: CashbookReopeningReceipt = {
            cashbook_id: checked.cashbookId, reopening_id: event.id, status: 'REOPENED',
            lock_date: null, idempotency_key: event.idempotency_key, previous_revision: event.previous_revision,
          };
          return { result };
        },
      );
    },
    onSuccess: (_result, input) => {
      for (const key of [
        ['cashbook-reopening'], ['cashbook-closings'], ['cashbook-closing-blockers'],
        ['cashbook-closing-monthly'], ['cashbook-balance-as-of'], ['accounts-with-balance'],
        ['accounts'], ['cash-book-summary'], ['cash-flow-by-day'], ['settlement-report'], ['income-expenses'],
      ]) void qc.invalidateQueries({ queryKey: key });
      toast.success(`Đã ghi nhận mở khóa sổ ${input.cashbookName || ''}. Danh sách sẽ cập nhật trạng thái mới nhất.`);
    },
  });
};
