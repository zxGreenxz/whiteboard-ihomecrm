// =============================================
// useInvoiceCollectors — AI đã thu BAO NHIÊU cho từng hoá đơn.
//
// payments không lưu người thu (user_id = owner hoá đơn để khớp RLS) —
// người thu thật nằm ở income_expenses.creator_name của phiếu thu link
// payment_id (xem docs/he-thong/15 §4.7). Hook gom các phiếu thu APPROVED
// theo invoice_id → map { invoice_id: [{creator_name, amount, date}] }
// theo thứ tự thu trước → sau, phục vụ:
//  - Ô phòng: "{tên} Thu đủ" / "Thu thêm 2731K(T+N)"
//  - Drawer chi tiết: danh sách ai thu bao nhiêu.
// =============================================

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface CollectorEntry {
  payment_id: string | null;
  creator_name: string | null;
  amount: number;
  /** voucher_date (DATE) của phiếu thu. */
  date: string | null;
}

export type CollectorsMap = Record<string, CollectorEntry[]>;

export const useInvoiceCollectors = (invoiceIds: string[]) => {
  // Key ổn định theo tập hoá đơn đang xem (toà + kỳ đổi → ids đổi → refetch).
  const keyHash = invoiceIds.slice().sort().join(',');

  return useQuery({
    queryKey: ['invoice-collectors', keyHash],
    enabled: invoiceIds.length > 0,
    queryFn: async (): Promise<CollectorsMap> => {
      const { data, error } = await (supabase as any)
        .from('income_expenses')
        .select('invoice_id, payment_id, creator_name, total_amount, voucher_date, created_at')
        .in('invoice_id', invoiceIds)
        .eq('type', 'INCOME')
        .eq('approval_status', 'APPROVED')
        .is('deleted_at', null)
        .not('payment_id', 'is', null)
        .order('created_at', { ascending: true });
      if (error) throw error;

      const map: CollectorsMap = {};
      for (const row of (data ?? []) as any[]) {
        const inv = row.invoice_id as string;
        (map[inv] ??= []).push({
          payment_id: row.payment_id,
          creator_name: row.creator_name,
          amount: Number(row.total_amount) || 0,
          date: row.voucher_date,
        });
      }
      return map;
    },
  });
};
