import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { z } from "zod";
import { openClawReadRpc } from "./openClawRpc";
import {
  automationDetailContract,
  automationDryRunContract,
  automationListContract,
  automationMutationContracts,
  deadLetterReplayMutationContract,
  directorySyncMutationContract,
  groupAllowlistMutationContract,
  knowledgeDetailContract,
  knowledgeListContract,
  knowledgeMutationContracts,
  knowledgePreviewContract,
  legalHoldMutationContracts,
  mediaResolveContract,
  aiDraftListContract,
  takeoverListContract,
  salesGroupListContract,
  scheduleListContract,
  scheduleMutationContracts,
} from "@/lib/openclaw-zalo/action-contracts";
import { assertOrganizationScope } from "@/lib/openclaw-zalo/query-contract";
import type { JsonValue } from "@/lib/openclaw-zalo/types";
import { openClawQueryKeys } from "./queryKeys";
import {
  executeOpenClawMutation,
  type BrowserWriteRpc,
  type OpenClawMutationVariables,
} from "./useOpenClawMutations";

type BrowserReadRpc =
  | typeof knowledgeListContract.rpcName
  | typeof knowledgeDetailContract.rpcName
  | typeof knowledgePreviewContract.rpcName
  | typeof automationListContract.rpcName
  | typeof automationDetailContract.rpcName
  | typeof automationDryRunContract.rpcName
  | typeof salesGroupListContract.rpcName
  | typeof scheduleListContract.rpcName
  | typeof aiDraftListContract.rpcName
  | typeof takeoverListContract.rpcName
  | typeof mediaResolveContract.rpcName;

interface ReadContract {
  rpcName: BrowserReadRpc;
  requestSchema: z.ZodTypeAny;
  resultSchema: z.ZodTypeAny;
}

interface WriteContract {
  rpcName: BrowserWriteRpc;
  requestSchema: z.ZodTypeAny;
  resultSchema: z.ZodTypeAny;
}

const boundedLimit = (limit: number, maximum = 100) => Math.max(1, Math.min(maximum, Math.trunc(limit)));

export async function executeOpenClawQuery<TContract extends ReadContract>(
  contract: TContract,
  request: unknown,
): Promise<z.output<TContract["resultSchema"]>> {
  const parsedRequest = contract.requestSchema.parse(request);
  const { data, error } = await openClawReadRpc<BrowserReadRpc>(contract.rpcName, parsedRequest as Record<string, unknown>);
  if (error) throw error;
  return contract.resultSchema.parse(data);
}

function useOpenClawActionMutation<TContract extends WriteContract>(
  organizationId: string,
  contract: TContract,
  invalidateQueryKeys: readonly QueryKey[],
) {
  const queryClient = useQueryClient();
  return useMutation<
    z.output<TContract["resultSchema"]>,
    unknown,
    OpenClawMutationVariables<z.input<TContract["requestSchema"]>>
  >({
    retry: false,
    mutationFn: variables => {
      assertOrganizationScope(variables.request as { organizationId: string }, organizationId);
      return executeOpenClawMutation(
        contract.rpcName,
        variables,
        contract.requestSchema,
        contract.resultSchema,
      ) as Promise<z.output<TContract["resultSchema"]>>;
    },
    onSuccess: () => Promise.all(invalidateQueryKeys.map(queryKey => (
      queryClient.invalidateQueries({ queryKey })
    ))),
  });
}

export function useOpenClawKnowledgeList(
  organizationId: string | null,
  accountId: string | null,
  limit = 50,
) {
  const safeLimit = boundedLimit(limit);
  return useQuery({
    queryKey: openClawQueryKeys.knowledgeList(organizationId ?? "", accountId ?? "", safeLimit),
    enabled: Boolean(organizationId && accountId),
    queryFn: () => executeOpenClawQuery(knowledgeListContract, {
      version: 1,
      organizationId: organizationId!,
      accountId: accountId!,
      limit: safeLimit,
    }),
  });
}

export function useOpenClawKnowledge(
  organizationId: string | null,
  accountId: string | null,
  sourceId: string | null,
) {
  return useQuery({
    queryKey: openClawQueryKeys.knowledgeDetail(organizationId ?? "", accountId ?? "", sourceId ?? ""),
    enabled: Boolean(organizationId && accountId && sourceId),
    queryFn: () => executeOpenClawQuery(knowledgeDetailContract, {
      version: 1,
      organizationId: organizationId!,
      sourceId: sourceId!,
    }),
  });
}

export function useOpenClawKnowledgePreview(
  organizationId: string | null,
  accountId: string | null,
  query: string,
  limit = 5,
) {
  const safeLimit = boundedLimit(limit, 20);
  return useQuery({
    queryKey: openClawQueryKeys.knowledgePreview(organizationId ?? "", accountId ?? "", query, safeLimit),
    enabled: Boolean(organizationId && accountId && query.trim()),
    queryFn: () => executeOpenClawQuery(knowledgePreviewContract, {
      version: 1,
      organizationId: organizationId!,
      accountId: accountId!,
      query,
      limit: safeLimit,
    }),
  });
}

export function useOpenClawAutomationList(
  organizationId: string | null,
  accountId: string | null,
  limit = 50,
) {
  const safeLimit = boundedLimit(limit);
  return useQuery({
    queryKey: openClawQueryKeys.automationList(organizationId ?? "", accountId ?? "", safeLimit),
    enabled: Boolean(organizationId && accountId),
    queryFn: () => executeOpenClawQuery(automationListContract, {
      version: 1,
      organizationId: organizationId!,
      accountId: accountId!,
      limit: safeLimit,
    }),
  });
}

export function useOpenClawAutomation(
  organizationId: string | null,
  accountId: string | null,
  automationId: string | null,
) {
  return useQuery({
    queryKey: openClawQueryKeys.automationDetail(organizationId ?? "", accountId ?? "", automationId ?? ""),
    enabled: Boolean(organizationId && accountId && automationId),
    queryFn: () => executeOpenClawQuery(automationDetailContract, {
      version: 1,
      organizationId: organizationId!,
      automationId: automationId!,
    }),
  });
}

export function useOpenClawAutomationDryRun(
  organizationId: string | null,
  accountId: string | null,
  automationVersionId: string | null,
  sampleInputs: Record<string, JsonValue>,
) {
  return useQuery({
    queryKey: [
      ...openClawQueryKeys.automationDryRun(
        organizationId ?? "",
        accountId ?? "",
        automationVersionId ?? "",
      ),
      sampleInputs,
    ],
    enabled: Boolean(organizationId && accountId && automationVersionId),
    queryFn: () => executeOpenClawQuery(automationDryRunContract, {
      version: 1,
      organizationId: organizationId!,
      automationVersionId: automationVersionId!,
      sampleInputs,
    }),
  });
}

export function useOpenClawSalesGroups(
  organizationId: string | null,
  accountId: string | null,
  limit = 50,
) {
  const safeLimit = boundedLimit(limit);
  return useQuery({
    queryKey: openClawQueryKeys.salesGroups(organizationId ?? "", accountId ?? "", safeLimit),
    enabled: Boolean(organizationId && accountId),
    queryFn: () => executeOpenClawQuery(salesGroupListContract, {
      version: 1,
      organizationId: organizationId!,
      accountId: accountId!,
      limit: safeLimit,
    }),
  });
}

export function useOpenClawSchedules(
  organizationId: string | null,
  accountId: string | null,
  limit = 50,
) {
  const safeLimit = boundedLimit(limit);
  return useQuery({
    queryKey: openClawQueryKeys.schedules(organizationId ?? "", accountId ?? "", safeLimit),
    enabled: Boolean(organizationId && accountId),
    queryFn: () => executeOpenClawQuery(scheduleListContract, {
      version: 1,
      organizationId: organizationId!,
      accountId: accountId!,
      limit: safeLimit,
    }),
  });
}

/**
 * Review-only drafts for one conversation. `draftText` is null unless DLP passed -
 * the server withholds it, so no client-side redaction is involved or possible.
 */
export function useOpenClawAiDrafts(
  organizationId: string | null,
  accountId: string | null,
  conversationId: string | null,
  limit = 20,
) {
  return useQuery({
    queryKey: openClawQueryKeys.aiDrafts(
      organizationId ?? "",
      accountId ?? "",
      conversationId ?? "",
      limit,
    ),
    enabled: Boolean(organizationId && accountId && conversationId),
    queryFn: () => executeOpenClawQuery(aiDraftListContract, {
      version: 1,
      organizationId: organizationId!,
      accountId: accountId!,
      conversationId: conversationId!,
      limit,
    }),
  });
}

/**
 * Active takeovers for the account, refreshed on a timer.
 *
 * Polled rather than subscribed: 20260727080000_openclaw_realtime_allowlist.sql
 * raises 55000 if any openclaw table outside its seven-name allowlist joins the
 * publication, and openclaw_takeovers is not on it.
 */
export function useOpenClawTakeovers(
  organizationId: string | null,
  accountId: string | null,
) {
  return useQuery({
    queryKey: openClawQueryKeys.takeovers(organizationId ?? "", accountId ?? ""),
    enabled: Boolean(organizationId && accountId),
    // A takeover expires on the server clock; a stale banner would claim auto-reply
    // is still suspended after it lapsed.
    refetchInterval: 30_000,
    queryFn: () => executeOpenClawQuery(takeoverListContract, {
      version: 1,
      organizationId: organizationId!,
      accountId: accountId!,
    }),
  });
}

/*
 * `useOpenClawQrPoll` lived here and is gone.
 *
 * It polled `openclaw_poll_qr_login_v1` straight from PostgREST. That RPC exists and
 * is granted, but it can never yield a scannable code: the QR is AES-GCM ciphertext
 * and only the `openclaw-qr` Edge function holds the key. The whole flow - BEGIN,
 * POLL and CONSUME - now goes through that function via src/lib/openclaw-zalo/qrClient.ts,
 * and its poll result is component state rather than a React Query entry, so no QR
 * metadata outlives the dialog in the cache.
 */

export function useOpenClawMediaObject(
  organizationId: string | null,
  accountId: string | null,
  mediaId: string | null,
) {
  return useQuery({
    queryKey: openClawQueryKeys.media(organizationId ?? "", accountId ?? "", mediaId ?? ""),
    enabled: Boolean(organizationId && accountId && mediaId),
    staleTime: 0,
    queryFn: () => executeOpenClawQuery(mediaResolveContract, {
      version: 1,
      organizationId: organizationId!,
      mediaId: mediaId!,
    }),
  });
}

export function useOpenClawKnowledgeMutations(organizationId: string, accountId: string) {
  const keys = [openClawQueryKeys.knowledgeRoot(organizationId, accountId)];
  return {
    createDraft: useOpenClawActionMutation(organizationId, knowledgeMutationContracts.create, keys),
    updateDraft: useOpenClawActionMutation(organizationId, knowledgeMutationContracts.update, keys),
    validate: useOpenClawActionMutation(organizationId, knowledgeMutationContracts.validate, keys),
    publish: useOpenClawActionMutation(organizationId, knowledgeMutationContracts.publish, keys),
    archive: useOpenClawActionMutation(organizationId, knowledgeMutationContracts.archive, keys),
  };
}

export function useOpenClawAutomationMutations(organizationId: string, accountId: string) {
  const keys = [openClawQueryKeys.automationsRoot(organizationId, accountId)];
  return {
    createDraft: useOpenClawActionMutation(organizationId, automationMutationContracts.create, keys),
    saveStep: useOpenClawActionMutation(organizationId, automationMutationContracts.saveStep, keys),
    publish: useOpenClawActionMutation(organizationId, automationMutationContracts.publish, keys),
    pause: useOpenClawActionMutation(organizationId, automationMutationContracts.pause, keys),
  };
}

export function useOpenClawGroupAllowlistMutation(organizationId: string, accountId: string) {
  return useOpenClawActionMutation(organizationId, groupAllowlistMutationContract, [
    openClawQueryKeys.salesGroupsRoot(organizationId, accountId),
  ]);
}

export function useOpenClawScheduleMutations(organizationId: string, accountId: string) {
  const keys = [openClawQueryKeys.schedulesRoot(organizationId, accountId)];
  return {
    upsert: useOpenClawActionMutation(organizationId, scheduleMutationContracts.upsert, keys),
    pause: useOpenClawActionMutation(organizationId, scheduleMutationContracts.pause, keys),
    cancel: useOpenClawActionMutation(organizationId, scheduleMutationContracts.cancel, keys),
  };
}

export function useOpenClawDirectorySyncMutation(organizationId: string, accountId: string) {
  return useOpenClawActionMutation(organizationId, directorySyncMutationContract, [
    openClawQueryKeys.bootstrap(organizationId, accountId),
    openClawQueryKeys.salesGroupsRoot(organizationId, accountId),
  ]);
}

export function useOpenClawLegalHoldMutations(organizationId: string, accountId: string) {
  const keys = [openClawQueryKeys.operationsRoot(organizationId, accountId)];
  return {
    create: useOpenClawActionMutation(organizationId, legalHoldMutationContracts.create, keys),
    release: useOpenClawActionMutation(organizationId, legalHoldMutationContracts.release, keys),
  };
}

export function useOpenClawDeadLetterReplayMutation(organizationId: string, accountId: string) {
  return useOpenClawActionMutation(organizationId, deadLetterReplayMutationContract, [
    openClawQueryKeys.operationsRoot(organizationId, accountId),
    openClawQueryKeys.overview(organizationId, accountId),
  ]);
}

export function useOpenClawResourceMutations(organizationId: string, accountId: string) {
  const knowledge = useOpenClawKnowledgeMutations(organizationId, accountId);
  const automations = useOpenClawAutomationMutations(organizationId, accountId);
  const groupAllowlist = useOpenClawGroupAllowlistMutation(organizationId, accountId);
  const schedules = useOpenClawScheduleMutations(organizationId, accountId);
  const directorySync = useOpenClawDirectorySyncMutation(organizationId, accountId);
  const legalHolds = useOpenClawLegalHoldMutations(organizationId, accountId);
  const replayDeadLetter = useOpenClawDeadLetterReplayMutation(organizationId, accountId);
  return {
    knowledge,
    automations,
    groupAllowlist,
    schedules,
    directorySync,
    legalHolds,
    replayDeadLetter,
  };
}
