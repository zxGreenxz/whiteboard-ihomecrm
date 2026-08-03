import { z } from "zod";
import type {
  OpenClawAuditEvent,
  OpenClawBootstrap,
  OpenClawConversation,
  OpenClawDeadLetter,
  OpenClawHealthEvent,
  OpenClawLegalHold,
  OpenClawMessage,
  OpenClawOverview,
  OpenClawOrganization,
  OpenClawUnknownItem,
  OpenClawUnknownResolution,
} from "./types";

export const idSchema = z.string().uuid();
export const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const timestampSchema = z.string().min(1);

const organizationSchema = z.object({
  organizationId: idSchema,
  name: z.string(),
}).strict();

export const organizationsResponseSchema = z.object({
  version: z.literal(1),
  organizations: z.array(organizationSchema),
}).strict();

const accountSchema = z.object({
  accountId: idSchema,
  displayName: z.string(),
  connectionState: z.enum(["DISCONNECTED", "QR_PENDING", "CONNECTING", "CONNECTED", "DISCONNECTING", "RECONNECT_REQUIRED"]),
  sessionRiskState: z.enum(["HEALTHY", "DEGRADED", "LIMITED", "SUSPECTED_THEFT", "INVALID"]),
  configuredMode: z.enum(["DRAFT_ONLY", "MANUAL_SEND", "LIMITED_AUTO_REPLY", "PROACTIVE", "SALES_GROUPS"]),
  effectiveMode: z.enum(["DRAFT_ONLY", "MANUAL_SEND", "LIMITED_AUTO_REPLY", "PROACTIVE", "SALES_GROUPS"]),
  connectionGeneration: z.number().int().nonnegative(),
  sessionGeneration: z.number().int().nonnegative(),
  // The server refuses a QR with 42501 unless these two agree. Without them the UI
  // could only report the refusal after the fact instead of showing the gate.
  disclosureVersion: z.number().int().nonnegative(),
  disclosureAcknowledgedVersion: z.number().int().nonnegative().nullable(),
  // Null while the account has no current cell, which is exactly when a QR cannot
  // be requested anyway.
  currentCellId: z.string().uuid().nullable(),
}).strict();

const controlSchema = z.object({
  globalStop: z.boolean(),
  featureEnabled: z.boolean(),
  limitedAutoReplyEnabled: z.boolean(),
  proactiveEnabled: z.boolean(),
  salesGroupsEnabled: z.boolean(),
  controlVersion: z.number().int().nonnegative(),
}).strict();

export const bootstrapResponseSchema = z.object({
  version: z.literal(1),
  organizationId: idSchema,
  account: accountSchema.nullable(),
  control: controlSchema.nullable(),
  actorId: idSchema,
}).strict();

export const overviewResponseSchema = z.object({
  version: z.literal(1),
  organizationId: idSchema,
  conversationCount: z.number().int().nonnegative(),
  unreadCount: z.number().int().nonnegative(),
  unresolvedUnknownCount: z.number().int().nonnegative(),
  resolvedUnknownCount: z.number().int().nonnegative(),
  deadLetterCount: z.number().int().nonnegative(),
}).strict();

export const conversationSchema = z.object({
  conversationId: idSchema,
  targetId: idSchema,
  status: z.string(),
  assignedMembershipId: idSchema.nullable(),
  unreadCount: z.number().int().nonnegative(),
  lastReceivedAt: timestampSchema,
  lastMessageId: idSchema.nullable(),
  version: z.number().int().nonnegative(),
}).strict();

export const messageSchema = z.object({
  messageId: idSchema,
  direction: z.enum(["INBOUND", "OUTBOUND"]),
  eventKind: z.string(),
  providerTimestamp: timestampSchema.nullable(),
  receivedAt: timestampSchema,
  createdAt: timestampSchema,
}).strict();

export function pageSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    version: z.literal(1),
    items: z.array(item),
    limit: z.number().int().min(1).max(100),
  }).strict();
}

const unknownRawSchema = z.object({
  outboxId: idSchema,
  accountId: idSchema,
  payloadHash: hashSchema,
  terminalAt: timestampSchema,
  resolution_version: z.number().int().min(0).max(1),
  authoritative_evidence_hash: hashSchema.nullable(),
  resolutionId: idSchema.nullable(),
  outcome: z.enum(["CONFIRMED_SENT", "CONFIRMED_FAILED", "NEW_INTENT_CREATED"]).nullable(),
  new_outbox_id: idSchema.nullable(),
  resolvedAt: timestampSchema.nullable(),
}).strict().superRefine((item, context) => {
  const requiredResolutionMetadata = [
    item.resolutionId,
    item.authoritative_evidence_hash,
    item.outcome,
    item.resolvedAt,
  ];
  const allNull = requiredResolutionMetadata.every(value => value === null);
  const allPresent = requiredResolutionMetadata.every(value => value !== null);
  if ((!allNull && !allPresent) || allPresent !== (item.resolution_version === 1)) {
    context.addIssue({ code: "custom", message: "incomplete UNKNOWN resolution projection" });
  }
  if (item.outcome === "NEW_INTENT_CREATED" && item.new_outbox_id === null) {
    context.addIssue({ code: "custom", message: "NEW_INTENT_CREATED requires a new outbox id" });
  }
  if (item.outcome !== "NEW_INTENT_CREATED" && item.new_outbox_id !== null) {
    context.addIssue({ code: "custom", message: "confirmed UNKNOWN outcomes cannot link a new outbox" });
  }
});

export const unknownResponseSchema = z.object({
  version: z.literal(1),
  items: z.array(unknownRawSchema),
  limit: z.number().int().min(1).max(100),
}).strict();

export const deadLetterSchema = z.object({
  deadLetterId: idSchema,
  accountId: idSchema,
  outboxId: idSchema.nullable(),
  sendWorkItemId: idSchema.nullable(),
  reasonCode: z.string(),
  payloadHash: hashSchema,
  createdAt: timestampSchema,
}).strict();

export const healthEventSchema = z.object({
  healthEventId: idSchema,
  accountId: idSchema.nullable(),
  cellId: idSchema.nullable(),
  severity: z.string(),
  healthKind: z.string(),
  status: z.string(),
  fingerprint: z.string(),
  contentFreeMetrics: z.record(z.string(), z.union([z.null(), z.boolean(), z.number(), z.string(), z.array(z.unknown()), z.record(z.string(), z.unknown())])),
  observedAt: timestampSchema,
  createdAt: timestampSchema,
}).strict();

export const auditEventSchema = z.object({
  auditEventId: idSchema,
  organizationSequence: z.number().int().nonnegative(),
  eventType: z.string(),
  actorId: idSchema.nullable(),
  workloadPrincipal: z.string().nullable(),
  requestId: idSchema.nullable(),
  correlationId: idSchema.nullable(),
  evidenceHash: hashSchema,
  previousHash: hashSchema.nullable(),
  eventHash: hashSchema,
  occurredAt: timestampSchema,
}).strict();

export const legalHoldSchema = z.object({
  holdId: idSchema,
  targetKind: z.string(),
  targetId: idSchema,
  reason: z.string(),
  holdVersion: z.number().int().nonnegative(),
  createdBy: idSchema,
  createdAt: timestampSchema,
  expiresAt: timestampSchema.nullable(),
  releasedBy: idSchema.nullable(),
  releasedAt: timestampSchema.nullable(),
  releaseReason: z.string().nullable(),
}).strict();

const resolutionBaseSchema = z.object({
  version: z.literal(1),
  resolutionId: idSchema,
  organizationId: idSchema,
  accountId: idSchema,
  outboxId: idSchema,
  resolutionVersion: z.literal(1),
  outcome: z.enum(["CONFIRMED_SENT", "CONFIRMED_FAILED", "NEW_INTENT_CREATED"]),
  newOutboxId: idSchema.nullable(),
  authoritativeEvidenceDomain: z.literal("ihome-openclaw-unknown-authority-v1\\0"),
  authoritativeEvidenceHash: hashSchema,
  reasonCode: z.enum(["OPERATOR_CONFIRMED_SENT", "OPERATOR_CONFIRMED_FAILED", "OPERATOR_CREATED_NEW_INTENT"]),
  resolvedBy: idSchema,
  resolvedAt: timestampSchema,
}).strict();

export const unknownResolutionSchema = resolutionBaseSchema.superRefine((value, context) => {
  const expectedReason = value.outcome === "CONFIRMED_SENT"
    ? "OPERATOR_CONFIRMED_SENT"
    : value.outcome === "CONFIRMED_FAILED"
      ? "OPERATOR_CONFIRMED_FAILED"
      : "OPERATOR_CREATED_NEW_INTENT";
  if (value.reasonCode !== expectedReason) context.addIssue({ code: "custom", message: "resolution reason mismatch" });
  if (value.outcome !== "NEW_INTENT_CREATED" && value.newOutboxId !== null) {
    context.addIssue({ code: "custom", message: "newOutboxId must be null" });
  }
  if (value.outcome === "NEW_INTENT_CREATED" && value.newOutboxId === null) {
    context.addIssue({ code: "custom", message: "newOutboxId is required" });
  }
});

const unknownRequestBase = {
  version: z.literal(1),
  organizationId: idSchema,
  outboxId: idSchema,
  expectedResolutionVersion: z.literal(0),
  expectedEvidenceDomain: z.literal("ihome-openclaw-unknown-authority-v1\\0"),
  expectedEvidenceHash: hashSchema,
  operatorEvidenceHash: hashSchema,
};

export const unknownResolutionRequestSchema = z.discriminatedUnion("outcome", [
  z.object({ ...unknownRequestBase, outcome: z.literal("CONFIRMED_SENT"), reasonCode: z.literal("OPERATOR_CONFIRMED_SENT"), newIntent: z.null().optional() }).strict(),
  z.object({ ...unknownRequestBase, outcome: z.literal("CONFIRMED_FAILED"), reasonCode: z.literal("OPERATOR_CONFIRMED_FAILED"), newIntent: z.null().optional() }).strict(),
  z.object({
    ...unknownRequestBase,
    outcome: z.literal("NEW_INTENT_CREATED"),
    reasonCode: z.literal("OPERATOR_CREATED_NEW_INTENT"),
    newIntent: z.object({
      clientOperationId: idSchema,
      targetId: idSchema,
      sourceDraftId: idSchema,
      expectedDraftVersion: z.number().int().nonnegative(),
      replyToMessageId: idSchema.nullable(),
    }).strict(),
  }).strict(),
]);

export const basicMutationResultSchema = z.object({
  version: z.literal(1),
  organizationId: idSchema,
}).strict();

export function parseOrganizations(value: unknown): OpenClawOrganization[] {
  return organizationsResponseSchema.parse(value).organizations as OpenClawOrganization[];
}

export function parseBootstrap(value: unknown): OpenClawBootstrap {
  return bootstrapResponseSchema.parse(value) as OpenClawBootstrap;
}

export function parseOverview(value: unknown): OpenClawOverview {
  return overviewResponseSchema.parse(value) as OpenClawOverview;
}

export function parseConversations(value: unknown): { version: 1; items: OpenClawConversation[]; limit: number } {
  return pageSchema(conversationSchema).parse(value) as { version: 1; items: OpenClawConversation[]; limit: number };
}

export function parseMessages(value: unknown): { version: 1; items: OpenClawMessage[]; limit: number } {
  return pageSchema(messageSchema).parse(value) as { version: 1; items: OpenClawMessage[]; limit: number };
}

export function parseUnknownResolution(value: unknown): OpenClawUnknownResolution {
  return unknownResolutionSchema.parse(value) as OpenClawUnknownResolution;
}

export function parseUnknownItems(value: unknown): OpenClawUnknownItem[] {
  const response = unknownResponseSchema.parse(value);
  return response.items.map(item => ({
    outboxId: item.outboxId,
    accountId: item.accountId,
    payloadHash: item.payloadHash,
    terminalAt: item.terminalAt,
    historicalState: "UNKNOWN",
    resolutionVersion: item.resolution_version as 0 | 1,
    resolution: item.resolutionId === null
      ? null
      : {
          resolutionId: item.resolutionId,
          outcome: item.outcome!,
          newOutboxId: item.new_outbox_id,
          authoritativeEvidenceHash: item.authoritative_evidence_hash!,
          resolvedAt: item.resolvedAt!,
        },
  }));
}

export function parseDeadLetters(value: unknown): { version: 1; items: OpenClawDeadLetter[]; limit: number } {
  return pageSchema(deadLetterSchema).parse(value) as { version: 1; items: OpenClawDeadLetter[]; limit: number };
}

export function parseHealthEvents(value: unknown): { version: 1; items: OpenClawHealthEvent[]; limit: number } {
  return pageSchema(healthEventSchema).parse(value) as { version: 1; items: OpenClawHealthEvent[]; limit: number };
}

export function parseAuditEvents(value: unknown): { version: 1; items: OpenClawAuditEvent[]; limit: number } {
  return pageSchema(auditEventSchema).parse(value) as { version: 1; items: OpenClawAuditEvent[]; limit: number };
}

export function parseLegalHolds(value: unknown): { version: 1; items: OpenClawLegalHold[]; limit: number } {
  return pageSchema(legalHoldSchema).parse(value) as { version: 1; items: OpenClawLegalHold[]; limit: number };
}
