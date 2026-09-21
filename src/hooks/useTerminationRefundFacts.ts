// =============================================================================
// Facts của một phiếu "Trả khách thanh lý" — dựng ghi chú + khung tổng hợp
// LÚC XEM. RPC gate quyền theo toà và bỏ qua im lặng phiếu không quyền, nên
// mảng rỗng là "không có gì để hiện", không phải lỗi.
// =============================================================================

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { batBuoc } from "@/lib/queryGuard";
import {
  parseTerminationRefundFacts,
  type TerminationRefundFacts,
} from "@/lib/terminationRefundNote";

export const TERMINATION_REFUND_FACTS_KEY = "termination-refund-facts";

export const useTerminationRefundFacts = (
  voucherId: string | null | undefined,
  enabled = true,
) => {
  return useQuery({
    queryKey: [TERMINATION_REFUND_FACTS_KEY, voucherId ?? null],
    enabled: enabled && !!voucherId,
    staleTime: 30_000,
    queryFn: async (): Promise<TerminationRefundFacts | null> => {
      const { data, error } = await supabase.rpc("get_termination_refund_facts_v1", {
        p_voucher_ids: [batBuoc(voucherId, "voucherId")],
      });
      if (error) throw error;
      const row = (data ?? [])[0];
      return row ? parseTerminationRefundFacts(row.facts) : null;
    },
  });
};
