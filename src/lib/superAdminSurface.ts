import { canUse, type PermsLike } from '@/lib/permissionPages';
import type { ActionKey } from '@/lib/permissions';

export function canShowSurface(item: { superAdminOnly?: boolean; module?: string; action?: ActionKey }, permissions: PermsLike, superAdmin: unknown): boolean {
  if (item.superAdminOnly) return superAdmin === true;
  return !item.module || canUse(permissions, item.module, item.action ?? 'view');
}
