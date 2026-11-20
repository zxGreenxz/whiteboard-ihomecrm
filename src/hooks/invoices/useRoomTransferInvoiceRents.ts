import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { supabase } from '@/integrations/supabase/client';

const rents = z.record(z.string().min(1), z.number().finite().nonnegative());
const client = supabase as unknown as {
  rpc(name: 'room_transfer_invoice_rents_v1', args: { p_building_id: string; p_billing_month: string }):
    PromiseLike<{ data: unknown; error: unknown }>;
};

export function useRoomTransferInvoiceRents(buildingId: string, month: string, enabled: boolean) {
  return useQuery({
    queryKey: ['room-transfer-invoice-rents', buildingId, month],
    enabled: enabled && !!buildingId && /^\d{4}-(0[1-9]|1[0-2])$/.test(month),
    queryFn: async () => {
      const { data, error } = await client.rpc('room_transfer_invoice_rents_v1', {
        p_building_id: buildingId, p_billing_month: month,
      });
      if (error) throw error;
      const result = rents.safeParse(data);
      if (!result.success) throw new Error('Dữ liệu tiền thuê kỳ chuyển phòng không hợp lệ.');
      return result.data;
    },
  });
}
