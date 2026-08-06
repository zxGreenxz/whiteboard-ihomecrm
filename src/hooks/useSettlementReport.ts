// =============================================
// useSettlementReport — báo cáo bàn giao tiền & đối soát sổ (theo kỳ).
// Gọi RPC cashbook_settlement_report(from, to) — SECURITY DEFINER, trả JSON:
//   accounts[]        — theo TỪNG sổ: thu/chi thực kỳ · đã bàn giao · số dư (=còn phải nộp)
//   sessions[]        — phiên bàn giao CONFIRMED trong kỳ
//   reconciliations[] — lần chốt/đối soát trong kỳ
// =============================================

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface SettlementAccount {
  account_id: string;
  name: string;
  owner_name: string | null;
  is_bank: boolean;
  current_balance: number;
  period_collected: number;
  period_spent: number;
  period_handed_over: number;
  last_reconciliation: {
    as_of_date: string;
    system_balance: number;
    counted_balance: number;
    diff: number;
    status: string;
    confirmed_at: string | null;
  } | null;
}

export interface SettlementSession {
  code: string | null;
  giver_name: string | null;
  receiver_name: string | null;
  gross: number;
  expense: number;
  net: number;
  voucher_count: number;
  status: string;
  confirmed_at: string | null;
  created_at: string | null;
  from_account: string | null;
}

export interface SettlementReconciliation {
  account_name: string;
  as_of_date: string;
  system_balance: number;
  counted_balance: number;
  diff: number;
  status: string;
  note: string | null;
  confirmed_at: string | null;
}

export interface SettlementReport {
  from: string;
  to: string;
  accounts: SettlementAccount[];
  sessions: SettlementSession[];
  reconciliations: SettlementReconciliation[];
}

/** Báo cáo bàn giao theo kỳ [from, to] (ISO yyyy-mm-dd). */
export const useSettlementReport = (from: string, to: string) =>
  useQuery({
    queryKey: ['settlement-report', from, to],
    enabled: !!from && !!to,
    queryFn: async (): Promise<SettlementReport> => {
      const { data, error } = await supabase.rpc('cashbook_settlement_report', {
        p_from: from,
        p_to: to,
      });
      if (error) throw new Error(error.message);
      return data as unknown as SettlementReport;
    },
  });
