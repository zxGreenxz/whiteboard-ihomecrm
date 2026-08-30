import { copilotPageByRoute } from '@/app/capabilities/registry';
import { canUse } from '@/lib/permissionPages';
import type { PermissionsMap } from '@/lib/permissions';
import {
  copilotAvailability,
  copilotAvailabilitySnapshotIsFresh,
  type CopilotAvailabilitySnapshot,
} from './featureFlags';

export interface UiControlAvailabilityContext {
  perms: PermissionsMap | undefined;
  organizationId: string | null;
  availability?: CopilotAvailabilitySnapshot | null;
}

export interface UiControlGuardResult {
  allowed: boolean;
  reason?:
    | 'organization_required'
    | 'availability_missing_or_stale'
    | 'organization_mismatch'
    | 'page_contract_missing'
    | 'page_rollout_disabled'
    | 'page_permission_missing';
  pageKey?: string;
}

/** Keep UI-control construction behind the same server snapshot and page contract gates. */
export function uiControlGuard(params: {
  pathname: string;
  ctx: UiControlAvailabilityContext;
  now?: number;
}): UiControlGuardResult {
  const { pathname, ctx } = params;
  const now = params.now ?? Date.now();
  if (!ctx.organizationId) return { allowed: false, reason: 'organization_required' };

  const snapshot = ctx.availability;
  if (!copilotAvailabilitySnapshotIsFresh(snapshot, 60_000, now)) {
    return { allowed: false, reason: 'availability_missing_or_stale' };
  }
  if (snapshot.organizationId !== ctx.organizationId) {
    return { allowed: false, reason: 'organization_mismatch' };
  }

  const page = copilotPageByRoute(pathname);
  if (!page) return { allowed: false, reason: 'page_contract_missing' };
  if (copilotAvailability(snapshot, page.key, 60_000, now) !== 'enabled') {
    return { allowed: false, reason: 'page_rollout_disabled', pageKey: page.key };
  }
  if (!ctx.perms || !canUse(ctx.perms, page.permission.module, page.permission.action)) {
    return { allowed: false, reason: 'page_permission_missing', pageKey: page.key };
  }
  return { allowed: true, pageKey: page.key };
}

export function assertUiControlAvailability(params: {
  pathname: string;
  ctx: UiControlAvailabilityContext;
  now?: number;
}): void {
  const result = uiControlGuard(params);
  if (!result.allowed) {
    throw new Error(`ui_control_unavailable: ${result.reason ?? 'unknown'}`);
  }
}

export function makeUiControlStepGuard(
  ctx: UiControlAvailabilityContext,
  allowlist: readonly string[],
  pathname: () => string = () => window.location.pathname,
): () => void {
  return () => {
    const path = pathname();
    const allowedRoute = allowlist.some((route) => path === route || path.startsWith(`${route}/`));
    if (!allowedRoute) throw new Error(`outside_allowlist: ${path}`);
    assertUiControlAvailability({ pathname: path, ctx });
  };
}

export function assertUiControlPageContract(
  pathname: string,
  expectedPageKey: string,
  ctx: UiControlAvailabilityContext,
): void {
  const result = uiControlGuard({ pathname, ctx });
  if (!result.allowed) {
    throw new Error(`ui_control_unavailable: ${result.reason ?? 'unknown'}`);
  }
  if (result.pageKey !== expectedPageKey) {
    throw new Error(`ui_control_page_mismatch: expected ${expectedPageKey}, got ${result.pageKey ?? 'none'}`);
  }
}
