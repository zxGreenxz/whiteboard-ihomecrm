import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionCheck';
import type { ActionKey } from '@/lib/permissions';

export interface MyBuildingScope {
  canManageAll: boolean;
  buildingIds: Set<string>;
  hasAnyScope: boolean;
  canManageBuilding: (buildingId: string | null | undefined) => boolean;
  isLoading: boolean;
  isError?: boolean;
  error?: unknown;
}

/** Phạm vi của đúng thao tác; phân công phụ trách không thay thế quyền nghiệp vụ. */
export function useMyBuildingScope(module: string, action: ActionKey): MyBuildingScope {
  const query = useMyPermissions();
  const value = query.data?.[module]?.[action];
  const ready = !!query.data && !query.isError && !query.isLoading;
  const canManageAll = ready && (query.data?.__superadmin === true || value === true ||
    (typeof value === 'object' && value.org_wide));
  const buildingIds = new Set(ready && typeof value === 'object' ? value.building_ids : []);
  return {
    canManageAll,
    buildingIds,
    hasAnyScope: ready && canUse(query.data, module, action),
    canManageBuilding: buildingId => ready && !!buildingId && canUse(query.data, module, action, buildingId),
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
  };
}
