import { canUse, type PermsLike } from '@/lib/permissionCheck';

export function canTransferRoom(perms: PermsLike, buildingId?: string | null): boolean {
  return !!buildingId
    && canUse(perms, 'contracts', 'edit', buildingId)
    && canUse(perms, 'contracts', 'transfer', buildingId);
}
