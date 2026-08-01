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

const permissionModuleSchema = z.object(Object.fromEntries(
  OPENCLAW_PERMISSION_ACTIONS.map(action => [action, z.boolean().optional()]),
) as Record<OpenClawPermissionAction, z.ZodOptional<z.ZodBoolean>>).strict();

const permissionProjectionSchema = z.object({
  __superadmin: z.boolean().optional(),
  openclaw_zalo: permissionModuleSchema.optional(),
}).strict();

export function projectOpenClawPermissions(value: unknown, organizationId: string): OpenClawPermissionSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid permission response");
  }
  const source = value as Record<string, unknown>;
  const parsed = permissionProjectionSchema.parse({
    __superadmin: source.__superadmin,
    openclaw_zalo: source.openclaw_zalo,
  });
  const actions = Object.fromEntries(OPENCLAW_PERMISSION_ACTIONS.map(action => [
    action,
    parsed.__superadmin === true || parsed.openclaw_zalo?.[action] === true,
  ])) as Record<OpenClawPermissionAction, boolean>;
  return { organizationId, actions };
}

export function useOpenClawPermissions(organizationId: string | null, accountId?: string | null) {
  return useQuery({
    queryKey: openClawQueryKeys.permissions(organizationId ?? "", accountId),
    enabled: Boolean(organizationId),
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_my_permissions");
      if (error) throw error;
      return projectOpenClawPermissions(data, organizationId!);
    },
  });
}

export function canOpenClaw(
  snapshot: OpenClawPermissionSnapshot | undefined,
  action: OpenClawPermissionAction,
): boolean {
  return snapshot?.actions[action] === true;
}
