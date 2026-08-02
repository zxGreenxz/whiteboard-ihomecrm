import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import type { OpenClawPermissionAction, OpenClawPermissionSnapshot } from "@/lib/openclaw-zalo/types";
import { openClawQueryKeys } from "./queryKeys";

export const OPENCLAW_PERMISSION_ACTIONS = [
  "view",
  "send",
  "manage_connections",
  "manage_automation",
  "manage_knowledge",
  "manage_handoff",
  "manage_operations",
  "audit",
] as const satisfies readonly OpenClawPermissionAction[];

const permissionKeySchema = z.enum(OPENCLAW_PERMISSION_ACTIONS.map(
  action => `openclaw_zalo.${action}`,
) as [`openclaw_zalo.${OpenClawPermissionAction}`, ...`openclaw_zalo.${OpenClawPermissionAction}`[]]);

const authorizationContextSchema = z.object({
  organizationId: z.string().uuid().nullable(),
  membershipId: z.string().uuid().nullable(),
  memberType: z.string().nullable(),
  authorizationVersion: z.number().int().nonnegative().nullable(),
  nearestDeadline: z.string().nullable().optional(),
  isPlatformAdmin: z.boolean(),
  isOffboarded: z.boolean(),
  organizations: z.array(z.object({
    id: z.string().uuid(),
    name: z.string(),
    isDemo: z.boolean(),
    memberType: z.string(),
  }).strict()),
  permissions: z.record(z.string(), z.literal(true)),
  scopeSets: z.array(z.object({
    orgWide: z.boolean(),
    buildingIds: z.array(z.string().uuid()),
    cashbookIds: z.array(z.string().uuid()),
  }).strict()),
  scopes: z.record(z.string(), z.number().int().nonnegative()),
}).strict();

export function projectOpenClawPermissions(
  value: unknown,
  requestedOrganizationId: string,
): OpenClawPermissionSnapshot | null {
  const parsed = authorizationContextSchema.parse(value);
  if (parsed.organizationId === null) return null;
  if (parsed.organizationId !== requestedOrganizationId) {
    throw new Error("Authorization context organization mismatch");
  }
  const actions = Object.fromEntries(OPENCLAW_PERMISSION_ACTIONS.map(action => [
    action,
    parsed.permissions[permissionKeySchema.parse(`openclaw_zalo.${action}`)] === true,
  ])) as Record<OpenClawPermissionAction, boolean>;
  return { organizationId: parsed.organizationId, actions };
}

export function useOpenClawPermissions(organizationId: string | null, accountId?: string | null) {
  return useQuery({
    queryKey: openClawQueryKeys.permissions(organizationId ?? "", accountId),
    enabled: Boolean(organizationId),
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_authorization_context_v1", {
        p_organization_id: organizationId!,
      });
      if (error) throw error;
      return projectOpenClawPermissions(data, organizationId!);
    },
  });
}

export function canOpenClaw(
  snapshot: OpenClawPermissionSnapshot | null | undefined,
  action: OpenClawPermissionAction,
): boolean {
  return snapshot?.actions[action] === true;
}
