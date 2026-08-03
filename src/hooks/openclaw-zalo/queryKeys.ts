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
  /**
   * ORGANIZATION-scoped, not account-scoped. `openclaw_get_overview_v1` counts every
   * account in the organization, so keying it per account cached the same org-wide
   * numbers under each account and invited the UI to present them as that account's.
   * The accountId parameter is kept so callers need no change, and ignored.
   */
  overview: (organizationId: string, _accountId?: string) => [
    ...openClawQueryKeys.scope(organizationId, OPENCLAW_UNSELECTED_ACCOUNT), "overview",
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
  knowledgeRoot: (organizationId: string, accountId: string) => [
    ...openClawQueryKeys.scope(organizationId, accountId), "knowledge",
  ] as const,
  knowledgeList: (organizationId: string, accountId: string, limit = 50) => [
    ...openClawQueryKeys.knowledgeRoot(organizationId, accountId), "list", limit,
  ] as const,
  knowledgeDetail: (organizationId: string, accountId: string, sourceId: string) => [
    ...openClawQueryKeys.knowledgeRoot(organizationId, accountId), "detail", sourceId,
  ] as const,
  knowledgePreview: (organizationId: string, accountId: string, query: string, limit = 5) => [
    ...openClawQueryKeys.knowledgeRoot(organizationId, accountId), "preview", query, limit,
  ] as const,
  automationsRoot: (organizationId: string, accountId: string) => [
    ...openClawQueryKeys.scope(organizationId, accountId), "automations",
  ] as const,
  automationList: (organizationId: string, accountId: string, limit = 50) => [
    ...openClawQueryKeys.automationsRoot(organizationId, accountId), "list", limit,
  ] as const,
  automationDetail: (organizationId: string, accountId: string, automationId: string) => [
    ...openClawQueryKeys.automationsRoot(organizationId, accountId), "detail", automationId,
  ] as const,
  automationDryRun: (organizationId: string, accountId: string, automationVersionId: string) => [
    ...openClawQueryKeys.automationsRoot(organizationId, accountId), "dry-run", automationVersionId,
  ] as const,
  salesGroupsRoot: (organizationId: string, accountId: string) => [
    ...openClawQueryKeys.scope(organizationId, accountId), "sales-groups",
  ] as const,
  salesGroups: (organizationId: string, accountId: string, limit = 50) => [
    ...openClawQueryKeys.salesGroupsRoot(organizationId, accountId), "list", limit,
  ] as const,
  schedulesRoot: (organizationId: string, accountId: string) => [
    ...openClawQueryKeys.scope(organizationId, accountId), "schedules",
  ] as const,
  schedules: (organizationId: string, accountId: string, limit = 50) => [
    ...openClawQueryKeys.schedulesRoot(organizationId, accountId), "list", limit,
  ] as const,
  aiDrafts: (organizationId: string, accountId: string, conversationId: string, limit = 20) => [
    ...openClawQueryKeys.scope(organizationId, accountId), "ai-drafts", conversationId, limit,
  ] as const,
  qrChallenge: (organizationId: string, accountId: string, challengeId: string) => [
    ...openClawQueryKeys.scope(organizationId, accountId), "qr", challengeId,
  ] as const,
  media: (organizationId: string, accountId: string, mediaId: string) => [
    ...openClawQueryKeys.scope(organizationId, accountId), "media", mediaId,
  ] as const,
  operationsRoot: (organizationId: string, accountId: string) => [
    ...openClawQueryKeys.scope(organizationId, accountId), "operations",
  ] as const,
  unknown: (organizationId: string, accountId: string, limit = 50, cursorTerminalAt?: string | null, cursorId?: string | null) => [
    ...openClawQueryKeys.operationsRoot(organizationId, accountId), "unknown", cursorTerminalAt ?? null, cursorId ?? null, limit,
  ] as const,
  deadLetters: (organizationId: string, accountId: string, limit = 50, cursorCreatedAt?: string | null, cursorId?: string | null) => [
    ...openClawQueryKeys.operationsRoot(organizationId, accountId), "dead-letters", cursorCreatedAt ?? null, cursorId ?? null, limit,
  ] as const,
  health: (organizationId: string, accountId: string, limit = 50, cursorObservedAt?: string | null, cursorId?: string | null) => [
    ...openClawQueryKeys.operationsRoot(organizationId, accountId), "health", cursorObservedAt ?? null, cursorId ?? null, limit,
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
