// =============================================
// useReconciliations — đối soát/chốt số sổ quỹ (dùng cho sổ chuyển khoản tkHiep).
// 3 mutation gọi RPC SECURITY DEFINER (migration 20260701130000):
//   propose_reconciliation  — chụp số dư hệ thống + số đếm thực; không counterparty
//                             → chốt luôn (CONFIRMED), có counterparty → chờ xác nhận.
//   confirm_reconciliation  — người đối ứng/chủ sổ xác nhận (PENDING → CONFIRMED).
//   cancel_reconciliation   — người tạo/chủ sổ hủy.
// =============================================

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const useInvalidateRecon = () => {
  const qc = useQueryClient();
  return () => {
    for (const key of ['settlement-report', 'cashbook-reconciliations', 'accounts-with-balance']) {
      qc.invalidateQueries({ queryKey: [key] });
    }
  };
};

export interface ProposeReconArgs {
  accountId: string;
  asOf: string;           // yyyy-mm-dd
  countedBalance: number;
  counterpartyId?: string | null;
  note?: string;
}

export const useProposeReconciliation = () => {
  const invalidate = useInvalidateRecon();
  return useMutation({
    mutationFn: async (args: ProposeReconArgs) => {
      const { data, error } = await (supabase as any).rpc('propose_reconciliation', {
        p_account_id: args.accountId,
        p_as_of: args.asOf,
        p_counted_balance: args.countedBalance,
        p_counterparty_id: args.counterpartyId ?? null,
        p_note: args.note ?? null,
      });
      if (error) throw new Error(error.message);
      return data as { id: string; status: string; system_balance: number; diff: number };
    },
    onSuccess: invalidate,
  });
};

export const useConfirmReconciliation = () => {
  const invalidate = useInvalidateRecon();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await (supabase as any).rpc('confirm_reconciliation', { p_id: id });
      if (error) throw new Error(error.message);
      return data as { id: string; status: string };
    },
    onSuccess: invalidate,
  });
};

export const useCancelReconciliation = () => {
  const invalidate = useInvalidateRecon();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await (supabase as any).rpc('cancel_reconciliation', { p_id: id });
      if (error) throw new Error(error.message);
      return data as { id: string; status: string };
    },
    onSuccess: invalidate,
  });
};
