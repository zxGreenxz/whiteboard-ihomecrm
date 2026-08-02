import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { OpenClawUnknownResolution } from "@/lib/openclaw-zalo/types";
import {
  deadLettersByAccountContract,
  healthEventsByAccountContract,
  unknownByAccountContract,
  unknownResolutionGetContract,
} from "@/lib/openclaw-zalo/action-contracts";
import {
  parseAuditEvents,
  parseDeadLetters,
  parseHealthEvents,
  parseLegalHolds,
  parseUnknownItems,
} from "@/lib/openclaw-zalo/validation";
import { openClawQueryKeys } from "./queryKeys";

const boundedLimit = (limit: number) => Math.max(1, Math.min(100, Math.trunc(limit)));

type AccountOperationsRpc =
  | typeof unknownByAccountContract.rpcName
  | typeof deadLettersByAccountContract.rpcName
  | typeof healthEventsByAccountContract.rpcName
  | typeof unknownResolutionGetContract.rpcName;

const accountOperationsClient = supabase as unknown as { rpc: (
  name: AccountOperationsRpc,
  args: { p_request: Record<string, unknown> },
) => Promise<{ data: unknown; error: Error | null }> };

export async function fetchOpenClawUnknown(
  organizationId: string,
  accountId: string,
  limit = 50,
  cursorTerminalAt?: string | null,
  cursorId?: string | null,
) {
  const safeLimit = boundedLimit(limit);
  const request = unknownByAccountContract.requestSchema.parse({
    version: 1, organizationId, accountId, limit: safeLimit,
    ...(cursorTerminalAt ? { cursorTerminalAt } : {}),
    ...(cursorId ? { cursorId } : {}),
  });
  const { data, error } = await accountOperationsClient.rpc(unknownByAccountContract.rpcName, {
    p_request: request,
  });
  if (error) throw error;
  return parseUnknownItems(data);
}

export async function fetchOpenClawUnknownResolution(
  organizationId: string,
  accountId: string,
  outboxId: string,
) {
  const request = unknownResolutionGetContract.requestSchema.parse({
    version: 1, organizationId, accountId, outboxId,
  });
  const { data, error } = await accountOperationsClient.rpc(unknownResolutionGetContract.rpcName, {
    p_request: request,
  });
  if (error) throw error;
  return unknownResolutionGetContract.resultSchema.parse(data) as OpenClawUnknownResolution | null;
}

export function useOpenClawUnknown(
  organizationId: string | null,
  accountId: string | null,
  limit = 50,
  cursorTerminalAt?: string | null,
  cursorId?: string | null,
) {
  const safeLimit = boundedLimit(limit);
  return useQuery({
    queryKey: openClawQueryKeys.unknown(organizationId ?? "", accountId ?? "", safeLimit, cursorTerminalAt, cursorId),
    enabled: Boolean(organizationId && accountId),
    staleTime: 5_000,
    queryFn: () => fetchOpenClawUnknown(organizationId!, accountId!, safeLimit, cursorTerminalAt, cursorId),
  });
}

async function fetchStrictPage<T>(
  rpcName: "openclaw_list_audit_events_v1" | "openclaw_list_legal_holds_v1",
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

export async function fetchOpenClawDeadLetters(
  organizationId: string,
  accountId: string,
  limit = 50,
  cursorCreatedAt?: string | null,
  cursorId?: string | null,
) {
  const safeLimit = boundedLimit(limit);
  const request = deadLettersByAccountContract.requestSchema.parse({
    version: 1, organizationId, accountId, limit: safeLimit,
    ...(cursorCreatedAt ? { cursorCreatedAt } : {}),
    ...(cursorId ? { cursorId } : {}),
  });
  const { data, error } = await accountOperationsClient.rpc(deadLettersByAccountContract.rpcName, {
    p_request: request,
  });
  if (error) throw error;
  return parseDeadLetters(data);
}

export async function fetchOpenClawHealthEvents(
  organizationId: string,
  accountId: string,
  limit = 50,
  cursorObservedAt?: string | null,
  cursorId?: string | null,
) {
  const safeLimit = boundedLimit(limit);
  const request = healthEventsByAccountContract.requestSchema.parse({
    version: 1, organizationId, accountId, limit: safeLimit,
    ...(cursorObservedAt ? { cursorObservedAt } : {}),
    ...(cursorId ? { cursorId } : {}),
  });
  const { data, error } = await accountOperationsClient.rpc(healthEventsByAccountContract.rpcName, {
    p_request: request,
  });
  if (error) throw error;
  return parseHealthEvents(data);
}

export function useOpenClawDeadLetters(
  organizationId: string | null,
  accountId: string | null,
  limit = 50,
  cursorCreatedAt?: string | null,
  cursorId?: string | null,
) {
  const safeLimit = boundedLimit(limit);
  return useQuery({
    queryKey: openClawQueryKeys.deadLetters(organizationId ?? "", accountId ?? "", safeLimit, cursorCreatedAt, cursorId),
    enabled: Boolean(organizationId && accountId),
    queryFn: () => fetchOpenClawDeadLetters(organizationId!, accountId!, safeLimit, cursorCreatedAt, cursorId),
  });
}

export function useOpenClawHealthEvents(
  organizationId: string | null,
  accountId: string | null,
  limit = 50,
  cursorObservedAt?: string | null,
  cursorId?: string | null,
) {
  const safeLimit = boundedLimit(limit);
  return useQuery({
    queryKey: openClawQueryKeys.health(organizationId ?? "", accountId ?? "", safeLimit, cursorObservedAt, cursorId),
    enabled: Boolean(organizationId && accountId),
    queryFn: () => fetchOpenClawHealthEvents(organizationId!, accountId!, safeLimit, cursorObservedAt, cursorId),
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
