import { useMemo } from 'react';
import { useBuildings } from '@/hooks/useBuildings';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { useOrganization } from '@/contexts/OrganizationContext';
import { canUse } from '@/lib/permissionCheck';

/** Thu nhanh dùng phạm vi được giao của thu_tien.view, độc lập với building.view.
 * Quyền cộng tác toàn công ty không cấp thêm bất kỳ khóa thu_tien nào. */
export function useThuTienBuildings() {
  const buildings = useBuildings();
  const permissions = useMyPermissions();
  const { selectedOrganizationId } = useOrganization();
  const data = useMemo(() => {
    if (!selectedOrganizationId || !buildings.data || !permissions.data || buildings.isError || permissions.isError) return undefined;
    return buildings.data.filter(building =>
      building.organization_id === selectedOrganizationId &&
      canUse(permissions.data, 'thu_tien', 'view', building.id));
  }, [buildings.data, permissions.data, buildings.isError, permissions.isError, selectedOrganizationId]);
  return {
    ...buildings,
    data,
    isLoading: buildings.isLoading || permissions.isLoading || !selectedOrganizationId,
    isPending: buildings.isPending || permissions.isPending || !selectedOrganizationId,
    isError: buildings.isError || permissions.isError,
    error: buildings.error ?? permissions.error,
    refetch: async () => {
      await permissions.refetch();
      return buildings.refetch();
    },
  };
}
