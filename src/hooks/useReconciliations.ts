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
      const { data, error } = await supabase.rpc('propose_reconciliation', {
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
      const { data, error } = await supabase.rpc('confirm_reconciliation', { p_id: id });
      if (error) throw new Error(error.message);
      return data as { id: string; status: string };
    },
    onSuccess: invalidate,
  });
};

// ĐỢT 6 — ĐÃ XOÁ useCreateOpeningAdjustment.
//
// Nó gọi `create_opening_adjustment`, mà Đợt 3 đã REVOKE khỏi `authenticated`
// (ACL trên prod còn mỗi `postgres`) vì hàm đó tự gỡ `lock_date = NULL` giữa
// transaction để lách chính trigger khoá của mình — mẫu bypass không được phép
// tồn tại song song với khoá vĩnh viễn. Giữ hook lại chỉ để UI gọi rồi ăn 42501
// SAU KHI đã kịp ghi một dòng cashbook_reconciliations.
//
// Khoá kỳ giờ đi qua nghi thức hai bên: propose_cashbook_closing_v1 →
// confirm_cashbook_closing_v1 (xem src/hooks/useCashbookClosing.ts), ghi biên
// bản vào app_private.cashbook_closures.

export const useCancelReconciliation = () => {
  const invalidate = useInvalidateRecon();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase.rpc('cancel_reconciliation', { p_id: id });
      if (error) throw new Error(error.message);
      return data as { id: string; status: string };
    },
    onSuccess: invalidate,
  });
};
