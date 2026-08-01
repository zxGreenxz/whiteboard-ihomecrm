import type { QueryKey } from "@tanstack/react-query";

export const OPENCLAW_QUERY_ROOT = "openclaw-zalo" as const;
export const OPENCLAW_UNSELECTED_ORGANIZATION = "__unselected_organization__" as const;
export const OPENCLAW_UNSELECTED_ACCOUNT = "__unselected_account__" as const;

const normalized = (value: string | null | undefined, fallback: string) => value || fallback;

export const openClawQueryKeys = {
  all: [OPENCLAW_QUERY_ROOT] as const,
  scope: (organizationId: string | null | undefined, accountId: string | null | undefined) => [
    OPENCLAW_QUERY_ROOT,
    normalized(organizationId, OPENCLAW_UNSELECTED_ORGANIZATION),
    normalized(accountId, OPENCLAW_UNSELECTED_ACCOUNT),
  ] as const,
  organizations: () => [OPENCLAW_QUERY_ROOT, OPENCLAW_UNSELECTED_ORGANIZATION, OPENCLAW_UNSELECTED_ACCOUNT, "organizations"] as const,
  bootstrap: (organizationId: string | null | undefined, accountId: string | null | undefined) => [
    ...openClawQueryKeys.scope(organizationId, accountId), "bootstrap",
  ] as const,
  overview: (organizationId: string, accountId: string) => [
    ...openClawQueryKeys.scope(organizationId, accountId), "overview",
  ] as const,
  conversationsRoot: (organizationId: string, accountId: string) => [
    ...openClawQueryKeys.scope(organizationId, accountId), "conversations",
  ] as const,
  conversations: (organizationId: string, accountId: string, cursorAt?: string | null, cursorId?: string | null, limit = 50) => [
    ...openClawQueryKeys.conversationsRoot(organizationId, accountId), cursorAt ?? null, cursorId ?? null, limit,
  ] as const,
  messagesRoot: (organizationId: string, accountId: string) => [
    ...openClawQueryKeys.scope(organizationId, accountId), "messages",
  ] as const,
  messages: (organizationId: string, accountId: string, conversationId: string, cursorAt?: string | null, cursorId?: string | null, limit = 50) => [
    ...openClawQueryKeys.messagesRoot(organizationId, accountId), conversationId, cursorAt ?? null, cursorId ?? null, limit,
  ] as const,
  operationsRoot: (organizationId: string, accountId: string) => [
    ...openClawQueryKeys.scope(organizationId, accountId), "operations",
  ] as const,
  unknown: (organizationId: string, accountId: string, limit = 50) => [
    ...openClawQueryKeys.operationsRoot(organizationId, accountId), "unknown", limit,
  ] as const,
  deadLetters: (organizationId: string, accountId: string, limit = 50) => [
    ...openClawQueryKeys.operationsRoot(organizationId, accountId), "dead-letters", limit,
  ] as const,
  health: (organizationId: string, accountId: string, limit = 50) => [
    ...openClawQueryKeys.operationsRoot(organizationId, accountId), "health", limit,
  ] as const,
  audit: (organizationId: string, accountId: string, limit = 50) => [
    ...openClawQueryKeys.operationsRoot(organizationId, accountId), "audit", limit,
  ] as const,
  holds: (organizationId: string, accountId: string, limit = 50) => [
    ...openClawQueryKeys.operationsRoot(organizationId, accountId), "holds", limit,
  ] as const,
  permissions: (organizationId: string, accountId: string | null | undefined) => [
    ...openClawQueryKeys.scope(organizationId, accountId), "permissions",
  ] as const,
};

export function isOpenClawQueryKey(queryKey: QueryKey): boolean {
  return queryKey[0] === OPENCLAW_QUERY_ROOT;
}

export function isOpenClawScopeQueryKey(
  queryKey: QueryKey,
  organizationId: string,
  accountId: string,
): boolean {
  return queryKey[0] === OPENCLAW_QUERY_ROOT
    && queryKey[1] === organizationId
    && queryKey[2] === accountId;
}
