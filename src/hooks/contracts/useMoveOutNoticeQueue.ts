import { useQuery } from '@tanstack/react-query';
import { useOrganization } from '@/contexts/OrganizationContext';
import { supabase } from '@/integrations/supabase/client';
import { parseMoveOutNoticeQueue } from '@/lib/moveOutNoticeQueue';

export const NOTICE_QUEUE_PAGE_SIZE = 10;

export function useMoveOutNoticeQueue(buildingIds: string[] = [], page = 0) {
  const { selectedOrganizationId } = useOrganization();
  const scope = [...buildingIds].sort();
  return useQuery({
    queryKey: ['contracts', 'move-out-due', selectedOrganizationId, scope, page],
    enabled: Boolean(selectedOrganizationId),
    staleTime: 15_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      if (!selectedOrganizationId) throw new Error('Chưa chọn công ty.');
      const { data, error } = await supabase.rpc('list_due_contract_move_out_notices_v1', {
        p_organization_id: selectedOrganizationId,
        p_building_ids: scope.length ? scope : undefined,
        p_limit: NOTICE_QUEUE_PAGE_SIZE,
        p_offset: page * NOTICE_QUEUE_PAGE_SIZE,
      });
      if (error) throw error;
      return parseMoveOutNoticeQueue(data);
    },
  });
}
