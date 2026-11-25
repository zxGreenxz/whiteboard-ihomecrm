import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { useOrganization } from '@/contexts/OrganizationContext';
import { supabase } from '@/integrations/supabase/client';

const snapshot = z.object({ hold: z.object({
  id: z.string().uuid(), revision: z.number().int().positive(), payer: z.string().nullable(),
  hold_until: z.string().nullable(), intended_move_in_on: z.string().nullable(),
  received_amount:z.number().nonnegative().nullable().optional(),
  topup_due_on: z.string().nullable(), deposit_target: z.number().nullable(),
}).nullable() });

export function useDepositIncomeHold(roomId?: string | null, enabled = true) {
  const { selectedOrganizationId } = useOrganization();
  return useQuery({
    queryKey: ['deposit-income-hold', selectedOrganizationId, roomId],
    enabled: !!roomId && !!selectedOrganizationId && enabled,
    queryFn: async () => {
      if (!selectedOrganizationId || !roomId) throw new Error('Chọn phòng để nhận cọc.');
      type Read = (name: 'get_deposit_income_hold_v1', args: {p_organization_id: string; p_room_id: string}) =>
        PromiseLike<{data: unknown; error: {message: string} | null}>;
      const client = supabase as unknown as { rpc: Read };
      const { data, error } = await client.rpc('get_deposit_income_hold_v1', {p_organization_id:selectedOrganizationId,p_room_id:roomId});
      if (error) throw error;
      return snapshot.parse(data).hold;
    },
  });
}
