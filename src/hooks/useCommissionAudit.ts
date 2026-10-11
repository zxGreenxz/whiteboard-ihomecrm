import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { commissionInterventionsSchema } from '@/lib/commissionAudit';

export function useCommissionAudit(voucherId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['commission-interventions', voucherId], enabled: enabled && !!voucherId,
    queryFn: async () => {
      if (!voucherId) throw new Error('Chưa xác định phiếu cần xem lịch sử hoa hồng.');
      const { data, error } = await supabase.rpc('read_commission_interventions_v1', {p_voucher_id: voucherId});
      if (error) throw error;
      return commissionInterventionsSchema.parse(data);
    },
  });
}
