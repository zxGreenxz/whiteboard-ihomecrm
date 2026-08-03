import { useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { openClawWriteRpc } from "./openClawRpc";
import type {
  OpenClawUnknownResolution,
  OpenClawUnknownResolutionRequest,
  OpenClawUnknownResolutionSummary,
} from "@/lib/openclaw-zalo/types";
import {
  hashSchema,
  idSchema,
  unknownResolutionSchema,
  unknownResolutionRequestSchema,
} from "@/lib/openclaw-zalo/validation";
import { assertOrganizationScope } from "@/lib/openclaw-zalo/query-contract";
import { openClawQueryKeys } from "./queryKeys";
import { fetchOpenClawUnknownResolution } from "./useOpenClawOperations";

export type BrowserWriteRpc =
  | "openclaw_acknowledge_disclosure_v1"
  | "openclaw_acknowledge_risk_v1"
  | "openclaw_begin_qr_login_v1"
  | "openclaw_consume_qr_challenge_v1"
  | "openclaw_disconnect_account_v1"
  | "openclaw_create_send_intent_v1"
  | "openclaw_takeover_conversation_v1"
  | "openclaw_release_takeover_v1"
  | "openclaw_assign_conversation_v1"
  | "openclaw_mark_conversation_read_v1"
  | "openclaw_create_knowledge_draft_v1"
  | "openclaw_update_knowledge_draft_v1"
  | "openclaw_validate_knowledge_v1"
  | "openclaw_publish_knowledge_v1"
  | "openclaw_archive_knowledge_v1"
  | "openclaw_create_automation_draft_v1"
  | "openclaw_save_automation_step_v1"
  | "openclaw_publish_automation_v1"
  | "openclaw_pause_automation_v1"
  | "openclaw_upsert_group_allowlist_v1"
  | "openclaw_upsert_schedule_v1"
  | "openclaw_pause_schedule_v1"
  | "openclaw_cancel_schedule_v1"
  | "openclaw_request_directory_sync_v1"
  | "openclaw_set_control_state_v1"
  | "openclaw_create_legal_hold_v1"
  | "openclaw_release_legal_hold_v1"
  | "openclaw_replay_dead_letter_v1"
  | "openclaw_resolve_unknown_v1";

export interface OpenClawMutationVariables<TRequest> {
  clientOperationId: string;
  request: TRequest;
}

export async function executeOpenClawMutation<TRequest, TResult>(
  rpcName: BrowserWriteRpc,
  variables: OpenClawMutationVariables<TRequest>,
  requestSchema: z.ZodType<TRequest>,
  resultSchema: z.ZodType<TResult>,
): Promise<TResult> {
  const request = requestSchema.parse(variables.request);
  const operationId = idSchema.parse(variables.clientOperationId);
  const { data, error } = await openClawWriteRpc<BrowserWriteRpc>(
    rpcName,
    request as Record<string, unknown>,
    operationId,
  );
  if (error) throw error;
  return parseOpenClawWriteResult(rpcName, data, resultSchema);
}

/**
 * Raised when the same `clientOperationId` is reused with a different request, or a
 * single-use operation is replayed. The database answers with a normal 200 carrying
 * `{version, conflict:true, reason}` - there is no SQL error - so parsing that shape
 * with the route's strict result schema surfaced "unrecognized key: conflict" to the
 * user instead of a conflict.
 */
export class OpenClawIdempotencyConflictError extends Error {
  readonly rpcName: string;
  readonly reason: string;

  constructor(rpcName: string, reason: string) {
    super(`OpenClaw operation conflict on ${rpcName}: ${reason}`);
    this.name = "OpenClawIdempotencyConflictError";
    this.rpcName = rpcName;
    this.reason = reason;
  }
}

function conflictEnvelope(value: unknown): { conflict: boolean; reason?: string; safeResult?: unknown } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return typeof record.conflict === "boolean"
    ? {
        conflict: record.conflict,
        reason: typeof record.reason === "string" ? record.reason : undefined,
        safeResult: record.safeResult,
      }
    : null;
}

/**
 * Handles the idempotency envelope before the route contract sees the payload:
 * a conflict becomes a typed error, and a replay is unwrapped to the result the
 * first call already produced.
 */
export function parseOpenClawWriteResult<TResult>(
  rpcName: string,
  data: unknown,
  resultSchema: z.ZodType<TResult>,
): TResult {
  const envelope = conflictEnvelope(data);
  if (envelope?.conflict === true) {
    throw new OpenClawIdempotencyConflictError(
      rpcName,
      envelope.reason ?? "operation conflict",
    );
  }
  // A replay carries the original result under safeResult; the caller must see the
  // same value the first attempt returned, not the bookkeeping wrapper.
  if (envelope !== null && envelope.safeResult !== undefined) {
    return resultSchema.parse(envelope.safeResult);
  }
  return resultSchema.parse(data);
}

export function isOpenClawSerializationFailure(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "40001");
}

export async function resolveUnknownWithWinnerReload<TResolution>(
  execute: () => Promise<TResolution>,
  reloadWinner: () => Promise<TResolution | null>,
): Promise<TResolution> {
  try {
    return await execute();
  } catch (error) {
    if (!isOpenClawSerializationFailure(error)) throw error;
    const winner = await reloadWinner();
    if (winner === null) throw error;
    return winner;
  }
}

const sendIntentRequestSchema = z.object({
  version: z.literal(1),
  organizationId: idSchema,
  sourceDraftId: idSchema,
  targetId: idSchema,
  expectedDraftVersion: z.number().int().nonnegative(),
  replyToMessageId: idSchema.nullable(),
}).strict();

const sendIntentResultSchema = z.object({
  version: z.literal(1),
  organizationId: idSchema,
  accountId: idSchema,
  outboxId: idSchema,
  state: z.literal("QUEUED"),
  payloadHash: hashSchema,
  idempotencyKey: idSchema,
}).strict();

export interface OpenClawSendIntentRequest {
  version: 1;
  organizationId: string;
  sourceDraftId: string;
  targetId: string;
  expectedDraftVersion: number;
  replyToMessageId: string | null;
}
export interface OpenClawSendIntentResult {
  version: 1;
  organizationId: string;
  accountId: string;
  outboxId: string;
  state: "QUEUED";
  payloadHash: string;
  idempotencyKey: string;
}

export function useOpenClawCreateSendIntent(organizationId: string, accountId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: (variables: OpenClawMutationVariables<OpenClawSendIntentRequest>) => {
      assertOrganizationScope(variables.request, organizationId);
      return executeOpenClawMutation(
        "openclaw_create_send_intent_v1",
        variables,
        sendIntentRequestSchema as z.ZodType<OpenClawSendIntentRequest>,
        sendIntentResultSchema as z.ZodType<OpenClawSendIntentResult>,
      );
    },
    onSuccess: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: openClawQueryKeys.conversationsRoot(organizationId, accountId) }),
      queryClient.invalidateQueries({ queryKey: openClawQueryKeys.overview(organizationId, accountId) }),
    ]),
  });
}

const controlRequestSchema = z.object({
  version: z.literal(1),
  organizationId: idSchema,
  expectedControlVersion: z.number().int().nonnegative(),
  globalStop: z.boolean(),
  featureEnabled: z.boolean().optional(),
  limitedAutoReplyEnabled: z.boolean().optional(),
  proactiveEnabled: z.boolean().optional(),
  salesGroupsEnabled: z.boolean().optional(),
  firstContactEnabled: z.boolean().optional(),
  reasonCode: z.string().min(1),
}).strict();

const controlResultSchema = z.object({
  version: z.literal(1),
  organizationId: idSchema,
  globalStop: z.boolean(),
  featureEnabled: z.boolean(),
  limitedAutoReplyEnabled: z.boolean(),
  proactiveEnabled: z.boolean(),
  salesGroupsEnabled: z.boolean(),
  firstContactEnabled: z.boolean(),
  controlVersion: z.number().int().nonnegative(),
}).strict();

export interface OpenClawControlRequest {
  version: 1;
  organizationId: string;
  expectedControlVersion: number;
  globalStop: boolean;
  featureEnabled?: boolean;
  limitedAutoReplyEnabled?: boolean;
  proactiveEnabled?: boolean;
  salesGroupsEnabled?: boolean;
  firstContactEnabled?: boolean;
  reasonCode: string;
}
export interface OpenClawControlResult {
  version: 1;
  organizationId: string;
  globalStop: boolean;
  featureEnabled: boolean;
  limitedAutoReplyEnabled: boolean;
  proactiveEnabled: boolean;
  salesGroupsEnabled: boolean;
  firstContactEnabled: boolean;
  controlVersion: number;
}

export function useOpenClawSetControlState(organizationId: string, accountId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: (variables: OpenClawMutationVariables<OpenClawControlRequest>) => {
      assertOrganizationScope(variables.request, organizationId);
      return executeOpenClawMutation(
        "openclaw_set_control_state_v1",
        variables,
        controlRequestSchema as z.ZodType<OpenClawControlRequest>,
        controlResultSchema as z.ZodType<OpenClawControlResult>,
      );
    },
    onSuccess: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: openClawQueryKeys.bootstrap(organizationId, accountId) }),
      queryClient.invalidateQueries({ queryKey: openClawQueryKeys.overview(organizationId, accountId) }),
    ]),
  });
}

export function useOpenClawResolveUnknown(organizationId: string, accountId: string) {
  const queryClient = useQueryClient();
  return useMutation<OpenClawUnknownResolution | OpenClawUnknownResolutionSummary, unknown, OpenClawMutationVariables<OpenClawUnknownResolutionRequest>>({
    retry: false,
    mutationFn: variables => {
      assertOrganizationScope(variables.request, organizationId);
      return resolveUnknownWithWinnerReload(
        () => executeOpenClawMutation(
          "openclaw_resolve_unknown_v1",
          variables,
          unknownResolutionRequestSchema,
          unknownResolutionSchema as z.ZodType<OpenClawUnknownResolution>,
        ),
        async () => {
          return fetchOpenClawUnknownResolution(
            organizationId,
            accountId,
            variables.request.outboxId,
          );
        },
      );
    },
    onSettled: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: openClawQueryKeys.operationsRoot(organizationId, accountId) }),
      queryClient.invalidateQueries({ queryKey: openClawQueryKeys.overview(organizationId, accountId) }),
    ]),
  });
}

function useOpenClawValidatedMutation<TRequest extends { organizationId: string }, TResult>(
  organizationId: string,
  accountId: string,
  rpcName: BrowserWriteRpc,
  requestSchema: z.ZodType<TRequest>,
  resultSchema: z.ZodType<TResult>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: (variables: OpenClawMutationVariables<TRequest>) => {
      assertOrganizationScope(variables.request, organizationId);
      return executeOpenClawMutation(rpcName, variables, requestSchema, resultSchema);
    },
    onSuccess: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: openClawQueryKeys.bootstrap(organizationId, accountId) }),
      queryClient.invalidateQueries({ queryKey: openClawQueryKeys.conversationsRoot(organizationId, accountId) }),
      queryClient.invalidateQueries({ queryKey: openClawQueryKeys.overview(organizationId, accountId) }),
    ]),
  });
}

const acknowledgeRiskRequestSchema = z.object({
  version: z.literal(1), organizationId: idSchema, accountId: idSchema,
  expectedRiskState: z.enum(["HEALTHY", "DEGRADED", "LIMITED", "SUSPECTED_THEFT", "INVALID"]),
  acknowledgedRiskState: z.enum(["HEALTHY", "DEGRADED"]), evidenceHash: hashSchema,
}).strict();
const acknowledgeRiskResultSchema = z.object({
  version: z.literal(1), organizationId: idSchema, accountId: idSchema,
  sessionRiskState: z.enum(["HEALTHY", "DEGRADED"]), effectiveMode: z.literal("DRAFT_ONLY"),
}).strict();
export type OpenClawAcknowledgeRiskRequest = z.infer<typeof acknowledgeRiskRequestSchema>;
export type OpenClawAcknowledgeRiskResult = z.infer<typeof acknowledgeRiskResultSchema>;

const acknowledgeDisclosureRequestSchema = z.object({
  version: z.literal(1), organizationId: idSchema, accountId: idSchema,
  disclosureVersion: z.number().int().positive(),
}).strict();
const acknowledgeDisclosureResultSchema = z.object({
  version: z.literal(1), organizationId: idSchema, accountId: idSchema,
  disclosureAcknowledgedVersion: z.number().int().positive(),
  disclosureAcknowledgedAt: z.string().min(1),
  idempotentReplay: z.boolean(),
}).strict();
export type OpenClawAcknowledgeDisclosureRequest =
  z.infer<typeof acknowledgeDisclosureRequestSchema>;
export type OpenClawAcknowledgeDisclosureResult =
  z.infer<typeof acknowledgeDisclosureResultSchema>;

/**
 * The version MUST come from the account, never from a constant: the RPC raises
 * 40001 on a mismatch, so a client-side default breaks the day the text is
 * republished.
 */
export function useOpenClawAcknowledgeDisclosure(organizationId: string, accountId: string) {
  return useOpenClawValidatedMutation(
    organizationId,
    accountId,
    "openclaw_acknowledge_disclosure_v1",
    acknowledgeDisclosureRequestSchema as z.ZodType<
      OpenClawAcknowledgeDisclosureRequest & { organizationId: string }
    >,
    acknowledgeDisclosureResultSchema,
  );
}

export function useOpenClawAcknowledgeRisk(organizationId: string, accountId: string) {
  return useOpenClawValidatedMutation(
    organizationId,
    accountId,
    "openclaw_acknowledge_risk_v1",
    acknowledgeRiskRequestSchema as z.ZodType<OpenClawAcknowledgeRiskRequest & { organizationId: string }>,
    acknowledgeRiskResultSchema,
  );
}

const beginQrRequestSchema = z.object({
  version: z.literal(1), organizationId: idSchema, accountId: idSchema, cellId: idSchema,
  browserNonceHash: hashSchema, authSessionHash: hashSchema,
  disclosureVersion: z.number().int().nonnegative(),
}).strict();
const beginQrResultSchema = z.object({
  version: z.literal(1), organizationId: idSchema, accountId: idSchema, cellId: idSchema,
  challengeId: idSchema, runtimeCommandId: idSchema, issuedAt: z.string().min(1),
  expiresAt: z.string().min(1), status: z.literal("PENDING"),
}).strict();
export type OpenClawBeginQrRequest = z.infer<typeof beginQrRequestSchema>;
export type OpenClawBeginQrResult = z.infer<typeof beginQrResultSchema>;

export function useOpenClawBeginQrLogin(organizationId: string, accountId: string) {
  return useOpenClawValidatedMutation(
    organizationId,
    accountId,
    "openclaw_begin_qr_login_v1",
    beginQrRequestSchema as z.ZodType<OpenClawBeginQrRequest & { organizationId: string }>,
    beginQrResultSchema,
  );
}

const consumeQrRequestSchema = z.object({
  version: z.literal(1), organizationId: idSchema, challengeId: idSchema,
  browserNonceHash: hashSchema, authSessionHash: hashSchema,
}).strict();
const consumeQrResultSchema = z.object({
  version: z.literal(1), organizationId: idSchema, challengeId: idSchema,
  status: z.literal("CONSUMED"), materialVersion: z.number().int().positive(),
}).strict();
export type OpenClawConsumeQrRequest = z.infer<typeof consumeQrRequestSchema>;
export type OpenClawConsumeQrResult = z.infer<typeof consumeQrResultSchema>;

export function useOpenClawConsumeQrChallenge(organizationId: string, accountId: string) {
  return useOpenClawValidatedMutation(
    organizationId,
    accountId,
    "openclaw_consume_qr_challenge_v1",
    consumeQrRequestSchema as z.ZodType<OpenClawConsumeQrRequest & { organizationId: string }>,
    consumeQrResultSchema,
  );
}

const disconnectRequestSchema = z.object({
  version: z.literal(1), organizationId: idSchema, accountId: idSchema,
  expectedConnectionGeneration: z.number().int().nonnegative(), reasonCode: z.string().min(1),
}).strict();
const disconnectResultSchema = z.object({
  version: z.literal(1), organizationId: idSchema, accountId: idSchema, cellId: idSchema,
  runtimeCommandId: idSchema, revocationId: idSchema, revocationKind: z.literal("SESSION"),
  revokedGeneration: z.number().int().nonnegative(), minimumValidGeneration: z.number().int().nonnegative(),
  connectionState: z.literal("DISCONNECTING"), effectiveMode: z.literal("DRAFT_ONLY"),
}).strict();
export type OpenClawDisconnectRequest = z.infer<typeof disconnectRequestSchema>;
export type OpenClawDisconnectResult = z.infer<typeof disconnectResultSchema>;

export function useOpenClawDisconnectAccount(organizationId: string, accountId: string) {
  return useOpenClawValidatedMutation(
    organizationId,
    accountId,
    "openclaw_disconnect_account_v1",
    disconnectRequestSchema as z.ZodType<OpenClawDisconnectRequest & { organizationId: string }>,
    disconnectResultSchema,
  );
}

const takeoverRequestSchema = z.object({
  version: z.literal(1), organizationId: idSchema, conversationId: idSchema,
  expectedConversationVersion: z.number().int().nonnegative(), expiresAt: z.string().min(1),
}).strict();
const takeoverResultSchema = z.object({
  version: z.literal(1), takeoverId: idSchema, conversationId: idSchema,
  ownerMembershipId: idSchema, takeoverVersion: z.number().int().positive(), expiresAt: z.string().min(1),
}).strict();
export type OpenClawTakeoverRequest = z.infer<typeof takeoverRequestSchema>;
export type OpenClawTakeoverResult = z.infer<typeof takeoverResultSchema>;

export function useOpenClawTakeoverConversation(organizationId: string, accountId: string) {
  return useOpenClawValidatedMutation(
    organizationId,
    accountId,
    "openclaw_takeover_conversation_v1",
    takeoverRequestSchema as z.ZodType<OpenClawTakeoverRequest & { organizationId: string }>,
    takeoverResultSchema,
  );
}

const releaseTakeoverRequestSchema = z.object({
  version: z.literal(1), organizationId: idSchema, takeoverId: idSchema,
  expectedTakeoverVersion: z.number().int().positive(),
}).strict();
const releaseTakeoverResultSchema = z.object({
  version: z.literal(1), takeoverId: idSchema, conversationId: idSchema,
  takeoverVersion: z.number().int().positive(), released: z.literal(true),
}).strict();
export type OpenClawReleaseTakeoverRequest = z.infer<typeof releaseTakeoverRequestSchema>;
export type OpenClawReleaseTakeoverResult = z.infer<typeof releaseTakeoverResultSchema>;

export function useOpenClawReleaseTakeover(organizationId: string, accountId: string) {
  return useOpenClawValidatedMutation(
    organizationId,
    accountId,
    "openclaw_release_takeover_v1",
    releaseTakeoverRequestSchema as z.ZodType<OpenClawReleaseTakeoverRequest & { organizationId: string }>,
    releaseTakeoverResultSchema,
  );
}

const assignRequestSchema = z.object({
  version: z.literal(1), organizationId: idSchema, conversationId: idSchema,
  membershipId: idSchema, expectedConversationVersion: z.number().int().nonnegative(),
}).strict();
const assignResultSchema = z.object({
  version: z.literal(1), conversationId: idSchema, assignedMembershipId: idSchema,
  conversationVersion: z.number().int().positive(),
}).strict();
export type OpenClawAssignConversationRequest = z.infer<typeof assignRequestSchema>;
export type OpenClawAssignConversationResult = z.infer<typeof assignResultSchema>;

export function useOpenClawAssignConversation(organizationId: string, accountId: string) {
  return useOpenClawValidatedMutation(
    organizationId,
    accountId,
    "openclaw_assign_conversation_v1",
    assignRequestSchema as z.ZodType<OpenClawAssignConversationRequest & { organizationId: string }>,
    assignResultSchema,
  );
}

const markReadRequestSchema = z.object({
  version: z.literal(1), organizationId: idSchema, conversationId: idSchema,
  expectedConversationVersion: z.number().int().nonnegative(),
}).strict();
const markReadResultSchema = z.object({
  version: z.literal(1), conversationId: idSchema, unreadCount: z.literal(0),
  conversationVersion: z.number().int().positive(),
}).strict();
export type OpenClawMarkReadRequest = z.infer<typeof markReadRequestSchema>;
export type OpenClawMarkReadResult = z.infer<typeof markReadResultSchema>;

export function useOpenClawMarkConversationRead(organizationId: string, accountId: string) {
  return useOpenClawValidatedMutation(
    organizationId,
    accountId,
    "openclaw_mark_conversation_read_v1",
    markReadRequestSchema as z.ZodType<OpenClawMarkReadRequest & { organizationId: string }>,
    markReadResultSchema,
  );
}

export function useOpenClawConnectionMutations(organizationId: string, accountId: string) {
  const acknowledgeRisk = useOpenClawAcknowledgeRisk(organizationId, accountId);
  const beginQrLogin = useOpenClawBeginQrLogin(organizationId, accountId);
  const consumeQrChallenge = useOpenClawConsumeQrChallenge(organizationId, accountId);
  const disconnectAccount = useOpenClawDisconnectAccount(organizationId, accountId);
  return { acknowledgeRisk, beginQrLogin, consumeQrChallenge, disconnectAccount };
}

export function useOpenClawHandoffMutations(organizationId: string, accountId: string) {
  const takeoverConversation = useOpenClawTakeoverConversation(organizationId, accountId);
  const releaseTakeover = useOpenClawReleaseTakeover(organizationId, accountId);
  const assignConversation = useOpenClawAssignConversation(organizationId, accountId);
  const markConversationRead = useOpenClawMarkConversationRead(organizationId, accountId);
  return { takeoverConversation, releaseTakeover, assignConversation, markConversationRead };
}

export function useOpenClawMutations(organizationId: string, accountId: string) {
  const createSendIntent = useOpenClawCreateSendIntent(organizationId, accountId);
  const setControlState = useOpenClawSetControlState(organizationId, accountId);
  const resolveUnknown = useOpenClawResolveUnknown(organizationId, accountId);
  const connections = useOpenClawConnectionMutations(organizationId, accountId);
  const handoff = useOpenClawHandoffMutations(organizationId, accountId);
  return { createSendIntent, setControlState, resolveUnknown, connections, handoff };
}
