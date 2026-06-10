// =============================================
// useCashHandovers — data layer cho Bàn giao tiền mặt (/thu-tien).
//
// - useUnhandedVouchers: phiếu thu TM CHƯA bàn giao trong sổ "…Thu" của
//   chính user (resolve qua ownCashAccountId — ledger-based, trùng logic
//   sổ nhận tiền của useQuickCollect).
// - useCashHandoverList: phiên bàn giao mình là người giao/nhận (RLS tự
//   lọc) + badge số phiên CẦN TÔI thao tác.
// - 5 mutation gọi RPC SECURITY DEFINER (migration 20260610130000).
//   Gọi supabase.rpc như METHOD + cast any (types.ts chưa regen —
//   gotcha docs/he-thong/15 §4.4).
// =============================================

import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAccounts } from '@/hooks/useAccounts';
import { useAuth } from '@/hooks/useAuth';
import { ownCashAccountId } from '@/lib/cashAccount';
import { needsMyAction, type HandoverItemLite, type HandoverLite } from '@/lib/handover';

export interface UnhandedVoucher {
  id: string;
  code: string | null;
  name: string | null;
  total_amount: number;
  voucher_date: string | null;
  room?: { name: string | null } | null;
  building?: { name: string | null } | null;
}

export interface CashHandover extends HandoverLite {
  from_account_id: string;
  to_account_id: string | null;
  note: string | null;
  cancel_requested_at: string | null;
  items: HandoverItemLite[];
}

/** Phiếu thu TM chưa bàn giao trong sổ "…Thu" của chính mình. */
export const useUnhandedVouchers = () => {
  const { data: accounts = [] } = useAccounts();
  const { data: currentUser } = useAuth();
  const accountId = useMemo(
    () => ownCashAccountId(accounts as any[], currentUser?.id),
    [accounts, currentUser],
  );

  const query = useQuery({
    queryKey: ['handover-vouchers', accountId],
    enabled: !!accountId,
    queryFn: async (): Promise<UnhandedVoucher[]> => {
      const { data, error } = await (supabase as any)
        .from('income_expenses')
        .select('id, code, name, total_amount, voucher_date, room:rooms(name), building:buildings(name)')
        .eq('account_id', accountId)
        .eq('type', 'INCOME')
        .eq('approval_status', 'APPROVED')
        .is('deleted_at', null)
        .is('handover_id', null)
        .order('voucher_date', { ascending: false })
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as UnhandedVoucher[];
    },
  });

  return { ...query, accountId };
};

/** Mọi phiên bàn giao mình tham gia (RLS lọc) + badge cần-tôi-thao-tác. */
export const useCashHandoverList = () => {
  const { data: currentUser } = useAuth();

  const query = useQuery({
    queryKey: ['cash-handovers'],
    enabled: !!currentUser?.id,
    // Polling nhẹ để người nhận thấy phiên mới mà không cần reload.
    refetchInterval: 30_000,
    queryFn: async (): Promise<CashHandover[]> => {
      const { data, error } = await (supabase as any)
        .from('cash_handovers')
        .select('*, items:cash_handover_items(*)')
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as CashHandover[];
    },
  });

  const actionCount = useMemo(
    () => (query.data ?? []).filter((h) => needsMyAction(h, currentUser?.id)).length,
    [query.data, currentUser],
  );

  return { ...query, actionCount, myId: currentUser?.id };
};

const useInvalidateHandover = () => {
  const queryClient = useQueryClient();
  return () => {
    for (const key of [
      'cash-handovers',
      'handover-vouchers',
      'income-expenses',
      'accounts-with-balance',
      'accounts',
    ]) {
      queryClient.invalidateQueries({ queryKey: [key] });
    }
  };
};

export const useCreateHandover = () => {
  const invalidate = useInvalidateHandover();
  return useMutation({
    mutationFn: async (args: { receiverId: string; voucherIds: string[]; note?: string }) => {
      const { data, error } = await (supabase as any).rpc('create_cash_handover', {
        p_receiver_id: args.receiverId,
        p_voucher_ids: args.voucherIds,
        p_note: args.note ?? null,
      });
      if (error) throw new Error(error.message);
      return data as { id: string; code: string; total_amount: number; voucher_count: number };
    },
    onSuccess: invalidate,
  });
};

export const useConfirmHandover = () => {
  const invalidate = useInvalidateHandover();
  return useMutation({
    mutationFn: async (args: { handoverId: string; toAccountId?: string | null }) => {
      const { data, error } = await (supabase as any).rpc('confirm_cash_handover', {
        p_handover_id: args.handoverId,
        p_to_account_id: args.toAccountId ?? null,
      });
      if (error) throw new Error(error.message);
      return data as { id: string; code: string };
    },
    onSuccess: invalidate,
  });
};

export const useRequestCancelHandover = () => {
  const invalidate = useInvalidateHandover();
  return useMutation({
    mutationFn: async (args: { handoverId: string; reason: string }) => {
      const { data, error } = await (supabase as any).rpc('request_cancel_handover', {
        p_handover_id: args.handoverId,
        p_reason: args.reason,
      });
      if (error) throw new Error(error.message);
      return data as { id: string; code: string };
    },
    onSuccess: invalidate,
  });
};

export const useConfirmCancelHandover = () => {
  const invalidate = useInvalidateHandover();
  return useMutation({
    mutationFn: async (args: { handoverId: string }) => {
      const { data, error } = await (supabase as any).rpc('confirm_cancel_handover', {
        p_handover_id: args.handoverId,
      });
      if (error) throw new Error(error.message);
      return data as { id: string; code: string };
    },
    onSuccess: invalidate,
  });
};

export const useRejectCancelHandover = () => {
  const invalidate = useInvalidateHandover();
  return useMutation({
    mutationFn: async (args: { handoverId: string }) => {
      const { data, error } = await (supabase as any).rpc('reject_cancel_handover', {
        p_handover_id: args.handoverId,
      });
      if (error) throw new Error(error.message);
      return data as { id: string; code: string };
    },
    onSuccess: invalidate,
  });
};
