import { useQuery } from "@tanstack/react-query";
import { openClawReadRpc } from "./openClawRpc";
import type { OpenClawUnknownResolution } from "@/lib/openclaw-zalo/types";
import {
  deadLettersByAccountContract,
  healthEventsByAccountContract,
  unknownAuthorityGetContract,
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
  | typeof unknownResolutionGetContract.rpcName
  | typeof unknownAuthorityGetContract.rpcName;

// One typed entry point instead of a per-file cast; see openClawRpc.ts.
const accountOperationsRpc = (name: AccountOperationsRpc, request: Record<string, unknown>) =>
  openClawReadRpc<AccountOperationsRpc>(name, request);

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
  const { data, error } = await accountOperationsRpc(unknownByAccountContract.rpcName, request);
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
  const { data, error } = await accountOperationsRpc(unknownResolutionGetContract.rpcName, request);
  if (error) throw error;
  return unknownResolutionGetContract.resultSchema.parse(data) as OpenClawUnknownResolution | null;
}

export async function fetchOpenClawUnknownAuthority(
  organizationId: string,
  accountId: string,
  outboxId: string,
) {
  const request = unknownAuthorityGetContract.requestSchema.parse({
    version: 1, organizationId, accountId, outboxId,
  });
  const { data, error } = await accountOperationsRpc(unknownAuthorityGetContract.rpcName, request);
  if (error) throw error;
  return unknownAuthorityGetContract.resultSchema.parse(data);
}

/**
 * The authority evidence for one UNKNOWN, read fresh each time the dialog opens.
 *
 * It is deliberately not cached for long: the hash covers every delivery attempt,
 * so an attempt landing between the read and the write invalidates it. A stale
 * cached value would turn into a 40001 the operator cannot explain.
 */
export function useOpenClawUnknownAuthority(
  organizationId: string | null,
  accountId: string | null,
  outboxId: string | null,
) {
  return useQuery({
    queryKey: openClawQueryKeys.unknownAuthority(
      organizationId ?? "", accountId ?? "", outboxId ?? "",
    ),
    enabled: Boolean(organizationId && accountId && outboxId),
    staleTime: 0,
    gcTime: 0,
    queryFn: () => fetchOpenClawUnknownAuthority(organizationId!, accountId!, outboxId!),
  });
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
  const { data, error } = await openClawReadRpc(rpcName, {
    version: 1,
    organizationId,
    limit: safeLimit,
  });
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
  const { data, error } = await accountOperationsRpc(deadLettersByAccountContract.rpcName, request);
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
  const { data, error } = await accountOperationsRpc(healthEventsByAccountContract.rpcName, request);
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
