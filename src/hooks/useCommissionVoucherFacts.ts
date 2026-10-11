import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { financialReadRows } from '@/lib/financialReadValidation';
import { batBuoc } from '@/lib/queryGuard';
import { parseCommissionVoucherFacts, type CommissionVoucherFacts } from '@/lib/commissionVoucherNote';

/**
 * Facts để xem/in phiếu tách khỏi các hook prepare/execute/retry hoa hồng:
 * màn đọc không cần tải graph tạo phiếu và khấu trừ hỗ trợ thuê.
 * RPC gate quyền theo tòa; mảng rỗng là không có facts được phép hiển thị.
 */
export const useCommissionVoucherFacts = (
  voucherId: string | null | undefined,
  enabled = true,
) => useQuery({
  queryKey: ['commission-voucher-facts', voucherId ?? null],
  enabled: enabled && !!voucherId,
  staleTime: 30_000,
  refetchOnWindowFocus: true,
  queryFn: async (): Promise<CommissionVoucherFacts | null> => {
    const { data, error } = await supabase.rpc('get_commission_voucher_facts_v1', {
      p_voucher_ids: [batBuoc(voucherId, 'voucherId')],
    });
    if (error) throw error;
    const row = financialReadRows(data)[0];
    return row ? parseCommissionVoucherFacts(row.facts) : null;
  },
});
