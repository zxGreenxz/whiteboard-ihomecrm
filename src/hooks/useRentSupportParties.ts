import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOrganization } from '@/contexts/OrganizationContext';
import { listRentSupportParties, registerRentSupportParty } from '@/lib/rentSupportApi';
import type { SupportParty } from '@/lib/rentSupportFunding';

export function useRentSupportParties(buildingId: string, enabled: boolean) {
  const { selectedOrganizationId } = useOrganization();
  const cache = useQueryClient();
  const queryKey = ['rent-support-parties', selectedOrganizationId, buildingId];
  const query = useQuery({ queryKey, enabled: enabled && !!selectedOrganizationId && !!buildingId,
    queryFn: async () => {
      if (!selectedOrganizationId || !buildingId) throw new Error('Chọn tổ chức và toà nhà.');
      const rows: SupportParty[] = [];
      let total = 0;
      do {
        const page = await listRentSupportParties(selectedOrganizationId, buildingId, rows.length, 200);
        total = page.total;
        if (!page.rows.length && rows.length < total) throw new Error('Danh sách danh tính đã thay đổi. Tải lại để chọn.');
        rows.push(...page.rows);
      } while (rows.length < total);
      return rows;
    } });
  const register = useMutation({ mutationFn: (input: { profileId: string | null; displayName: string; reason: string; requestId: string }) => {
    if (!selectedOrganizationId || !buildingId) throw new Error('Chọn tổ chức và toà nhà.');
    return registerRentSupportParty(selectedOrganizationId, buildingId, input);
  }, onSuccess: () => cache.invalidateQueries({ queryKey }) });
  return { ...query, register };
}
