import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  parseAuditEvents,
  parseDeadLetters,
  parseHealthEvents,
  parseLegalHolds,
  parseUnknownItems,
} from "@/lib/openclaw-zalo/validation";
import { openClawQueryKeys } from "./queryKeys";

const boundedLimit = (limit: number) => Math.max(1, Math.min(100, Math.trunc(limit)));

export async function fetchOpenClawUnknown(organizationId: string, limit = 50, accountId?: string) {
  const safeLimit = boundedLimit(limit);
  const { data, error } = await supabase.rpc("openclaw_list_unknown_v1", {
    p_request: { version: 1, organizationId, limit: safeLimit },
  });
  if (error) throw error;
  const items = parseUnknownItems(data);
  return accountId ? items.filter(item => item.accountId === accountId) : items;
}

export function useOpenClawUnknown(organizationId: string | null, accountId: string | null, limit = 50) {
  const safeLimit = boundedLimit(limit);
  return useQuery({
    queryKey: openClawQueryKeys.unknown(organizationId ?? "", accountId ?? "", safeLimit),
    enabled: Boolean(organizationId && accountId),
    staleTime: 5_000,
    queryFn: () => fetchOpenClawUnknown(organizationId!, safeLimit, accountId!),
  });
}

async function fetchStrictPage<T>(
  rpcName: "openclaw_list_dead_letters_v1" | "openclaw_list_health_events_v1" | "openclaw_list_audit_events_v1" | "openclaw_list_legal_holds_v1",
  organizationId: string,
  limit: number,
  parse: (value: unknown) => { version: 1; items: T[]; limit: number },
) {
  const safeLimit = boundedLimit(limit);
  const client = supabase as unknown as { rpc: (
    name: typeof rpcName,
    args: { p_request: { version: 1; organizationId: string; limit: number } },
  ) => Promise<{ data: unknown; error: Error | null }> };
  const { data, error } = await client.rpc(rpcName, { p_request: { version: 1, organizationId, limit: safeLimit } });
  if (error) throw error;
  return parse(data);
}

export function useOpenClawDeadLetters(organizationId: string | null, accountId: string | null, limit = 50) {
  const safeLimit = boundedLimit(limit);
  return useQuery({
    queryKey: openClawQueryKeys.deadLetters(organizationId ?? "", accountId ?? "", safeLimit),
    enabled: Boolean(organizationId && accountId),
    queryFn: () => fetchStrictPage("openclaw_list_dead_letters_v1", organizationId!, safeLimit, parseDeadLetters),
    select: page => ({ ...page, items: page.items.filter(item => item.accountId === accountId) }),
  });
}

export function useOpenClawHealthEvents(organizationId: string | null, accountId: string | null, limit = 50) {
  const safeLimit = boundedLimit(limit);
  return useQuery({
    queryKey: openClawQueryKeys.health(organizationId ?? "", accountId ?? "", safeLimit),
    enabled: Boolean(organizationId && accountId),
    queryFn: () => fetchStrictPage("openclaw_list_health_events_v1", organizationId!, safeLimit, parseHealthEvents),
    select: page => ({ ...page, items: page.items.filter(item => item.accountId === null || item.accountId === accountId) }),
  });
}

export function useOpenClawAuditEvents(organizationId: string | null, accountId: string | null, limit = 50) {
  const safeLimit = boundedLimit(limit);
  return useQuery({
    queryKey: openClawQueryKeys.audit(organizationId ?? "", accountId ?? "", safeLimit),
    enabled: Boolean(organizationId && accountId),
    queryFn: () => fetchStrictPage("openclaw_list_audit_events_v1", organizationId!, safeLimit, parseAuditEvents),
  });
}

export function useOpenClawLegalHolds(organizationId: string | null, accountId: string | null, limit = 50) {
  const safeLimit = boundedLimit(limit);
  return useQuery({
    queryKey: openClawQueryKeys.holds(organizationId ?? "", accountId ?? "", safeLimit),
    enabled: Boolean(organizationId && accountId),
    queryFn: () => fetchStrictPage("openclaw_list_legal_holds_v1", organizationId!, safeLimit, parseLegalHolds),
  });
}

export const useOpenClawOperations = useOpenClawUnknown;
