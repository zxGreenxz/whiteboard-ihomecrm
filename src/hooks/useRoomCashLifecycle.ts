import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { parseSettlementRoomLifecycle } from '@/lib/contractSettlementTimeline';
import { useAuth } from '@/hooks/useAuth';
import { useOrganization } from '@/contexts/OrganizationContext';

/** Private/unpublished dependencies are covered by polling; public realtime accelerates refresh. */
export const roomLifecycleDependencies = ['contracts', 'contract_extensions', 'contract_transfers', 'contract_terminations',
  'rooms', 'buildings', 'contract_customers', 'tenants', 'invoices', 'income_expenses', 'income_expense_items',
  'income_expense_postings', 'organization_memberships'] as const;

/** Same authenticated reader for the room sheet and settlement modal; legacy event amounts are not cash facts. */
export function useRoomCashLifecycle(roomId: string | null) {
  const { data: actor } = useAuth();
  const { selectedOrganizationId } = useOrganization();
  const client = useQueryClient();
  const enabled = !!roomId && !!actor?.id && !!selectedOrganizationId;
  const query = useQuery({
    queryKey: ['room-cash-lifecycle', selectedOrganizationId, actor?.id, roomId],
    enabled, staleTime: 0, refetchOnWindowFocus: 'always', refetchInterval: 30_000, retry: false,
    queryFn: async ({ signal }) => {
      if (!roomId || !actor?.id || !selectedOrganizationId) throw new Error('Chưa chọn đủ phạm vi xem lịch sử phòng.');
      const { data, error } = await supabase.rpc('get_room_cash_lifecycle_v1', {
        p_room_id: roomId,
      }).abortSignal(signal);
      if (error) throw new Error(error.code === '42501' ? 'Bạn không có quyền xem lịch sử phòng trong phạm vi này.' : 'Chưa tải được lịch sử phòng. Vui lòng thử lại.');
      try { return parseSettlementRoomLifecycle(data, roomId, selectedOrganizationId); }
      catch { throw new Error('Dữ liệu lịch sử phòng chưa được xác minh. Vui lòng tải lại.'); }
    },
  });
  useEffect(() => {
    if (!enabled || !actor?.id) return;
    const key = ['room-cash-lifecycle', selectedOrganizationId, actor.id, roomId];
    const channel = supabase.channel(`room-lifecycle:${selectedOrganizationId}:${actor.id}:${roomId}`);
    for (const table of roomLifecycleDependencies) channel.on('postgres_changes', { event: '*', schema: 'public', table }, () => { void client.invalidateQueries({ queryKey: key }); });
    channel.subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [enabled, selectedOrganizationId, actor?.id, roomId, client]);
  return { ...query, data: enabled && !query.isError ? query.data : undefined };
}
