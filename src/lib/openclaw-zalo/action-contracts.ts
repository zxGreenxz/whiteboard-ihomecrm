import { z } from "zod";
import type { JsonValue } from "./types";
import {
  deadLetterSchema,
  hashSchema,
  healthEventSchema,
  idSchema,
  pageSchema,
  timestampSchema,
  unknownResolutionSchema,
  unknownResponseSchema,
} from "./validation";

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number(),
  z.string(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]));

const jsonObjectSchema = z.record(z.string(), jsonValueSchema);
const versionSchema = { version: z.literal(1) } as const;
const knowledgeLifecycleSchema = z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]);
const automationLifecycleSchema = z.enum(["DRAFT", "PUBLISHED", "PAUSED", "ARCHIVED"]);
const knowledgeSensitivitySchema = z.enum(["CUSTOMER_SAFE", "INTERNAL_REVIEW_ONLY", "RESTRICTED"]);
const knowledgeSourceKindSchema = z.enum(["TEXT", "DOCUMENT", "FAQ", "CRM_SNAPSHOT"]);
const automationKindSchema = z.enum(["INBOUND_REPLY", "PROACTIVE", "SALES_GROUP", "CRM_EVENT", "FIRST_CONTACT"]);
const modeSchema = z.enum(["DRAFT_ONLY", "MANUAL_SEND", "LIMITED_AUTO_REPLY", "PROACTIVE", "SALES_GROUPS"]);

const boundedListRequestSchema = z.object({
  ...versionSchema,
  organizationId: idSchema,
  accountId: idSchema,
  limit: z.number().int().min(1).max(100).optional(),
}).strict();

const knowledgeSummarySchema = z.object({
  sourceId: idSchema,
  accountId: idSchema,
  title: z.string(),
  sourceKind: knowledgeSourceKindSchema,
  sensitivity: knowledgeSensitivitySchema,
  lifecycleState: knowledgeLifecycleSchema,
  currentVersion: z.number().int().nonnegative(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();

export const knowledgeListContract = {
  rpcName: "openclaw_list_knowledge_v1",
  requestSchema: boundedListRequestSchema,
  resultSchema: z.object({
    ...versionSchema,
    items: z.array(knowledgeSummarySchema),
    limit: z.number().int().min(1).max(100),
  }).strict(),
} as const;

export const knowledgeDetailContract = {
  rpcName: "openclaw_get_knowledge_v1",
  requestSchema: z.object({ ...versionSchema, organizationId: idSchema, sourceId: idSchema }).strict(),
  resultSchema: z.object({
    ...versionSchema,
    knowledge: z.object({
      sourceId: idSchema,
      accountId: idSchema,
      title: z.string(),
      sourceKind: knowledgeSourceKindSchema,
      sensitivity: knowledgeSensitivitySchema,
      lifecycleState: knowledgeLifecycleSchema,
      currentVersion: z.number().int().nonnegative(),
      publishedVersionId: idSchema.nullable(),
      contentHash: hashSchema.nullable(),
      validationResult: jsonValueSchema.nullable(),
      publishedAt: timestampSchema.nullable(),
      archivedAt: timestampSchema.nullable(),
    }).strict().nullable(),
  }).strict(),
} as const;

const knowledgeChunkSchema = z.object({
  chunkId: idSchema,
  sourceId: idSchema,
  knowledgeVersionId: idSchema,
  chunkIndex: z.number().int().nonnegative(),
  chunkText: z.string(),
  chunkHash: hashSchema,
}).strict();

export const knowledgePreviewContract = {
  rpcName: "openclaw_preview_knowledge_retrieval_v1",
  requestSchema: z.object({
    ...versionSchema,
    organizationId: idSchema,
    accountId: idSchema,
    query: z.string().min(1),
    limit: z.number().int().min(1).max(20).optional(),
  }).strict(),
  resultSchema: z.object({
    ...versionSchema,
    items: z.array(knowledgeChunkSchema),
    limit: z.number().int().min(1).max(20),
  }).strict(),
} as const;

const automationSummarySchema = z.object({
  automationId: idSchema,
  name: z.string(),
  automationKind: automationKindSchema,
  lifecycleState: automationLifecycleSchema,
  currentVersion: z.number().int().nonnegative(),
  updatedAt: timestampSchema,
}).strict();

export const automationListContract = {
  rpcName: "openclaw_list_automations_v1",
  requestSchema: boundedListRequestSchema,
  resultSchema: z.object({
    ...versionSchema,
    items: z.array(automationSummarySchema),
    limit: z.number().int().min(1).max(100),
  }).strict(),
} as const;

export const automationDetailContract = {
  rpcName: "openclaw_get_automation_v1",
  requestSchema: z.object({ ...versionSchema, organizationId: idSchema, automationId: idSchema }).strict(),
  resultSchema: z.object({
    ...versionSchema,
    automation: z.object({
      automationId: idSchema,
      accountId: idSchema,
      name: z.string(),
      automationKind: automationKindSchema,
      lifecycleState: automationLifecycleSchema,
      currentVersion: z.number().int().nonnegative(),
      versionId: idSchema.nullable(),
      mode: modeSchema.nullable(),
      policyVersionId: idSchema.nullable(),
      knowledgeVersionIds: z.array(idSchema).nullable(),
      configuration: jsonObjectSchema.nullable(),
      dryRunHash: hashSchema.nullable(),
    }).strict().nullable(),
  }).strict(),
} as const;

export const automationDryRunContract = {
  rpcName: "openclaw_dry_run_automation_v1",
  requestSchema: z.object({
    ...versionSchema,
    organizationId: idSchema,
    automationVersionId: idSchema,
    sampleInputs: jsonObjectSchema,
  }).strict(),
  resultSchema: z.object({
    ...versionSchema,
    eligible: z.boolean(),
    dryRunHash: hashSchema,
    sendCreated: z.literal(false),
    reason: z.enum(["DRY_RUN_ONLY", "NOT_ELIGIBLE"]),
  }).strict(),
} as const;

const salesGroupSchema = z.object({
  targetId: idSchema,
  groupId: idSchema,
  displayName: z.string(),
  memberCount: z.number().int().nonnegative().nullable(),
  directoryVersion: z.number().int().nonnegative(),
  directoryRefreshedAt: timestampSchema,
  targetVersion: z.number().int().nonnegative(),
  isActive: z.boolean(),
  isAllowed: z.boolean().nullable(),
  allowlistVersion: z.number().int().nonnegative().nullable(),
  directoryExpiresAt: timestampSchema.nullable(),
}).strict();

export const salesGroupListContract = {
  rpcName: "openclaw_list_sales_groups_v1",
  requestSchema: boundedListRequestSchema,
  resultSchema: z.object({
    ...versionSchema,
    items: z.array(salesGroupSchema),
    limit: z.number().int().min(1).max(100),
  }).strict(),
} as const;

const scheduleSchema = z.object({
  scheduleId: idSchema,
  automationVersionId: idSchema,
  targetId: idSchema.nullable(),
  campaignId: idSchema.nullable(),
  scheduleVersion: z.number().int().positive(),
  status: z.enum(["PAUSED", "ACTIVE", "CANCELLED", "COMPLETE"]),
  timezone: z.string().min(1),
  localRecurrenceRule: z.string().min(1),
  nextRunAt: timestampSchema.nullable(),
  missedOccurrencePolicy: z.literal("SKIPPED_MISSED"),
  updatedAt: timestampSchema,
}).strict();

export const scheduleListContract = {
  rpcName: "openclaw_list_schedules_v1",
  requestSchema: boundedListRequestSchema,
  resultSchema: z.object({
    ...versionSchema,
    items: z.array(scheduleSchema),
    limit: z.number().int().min(1).max(100),
  }).strict(),
} as const;

export const aiDraftListContract = {
  rpcName: "openclaw_list_ai_drafts_v1",
  requestSchema: z.object({
    ...versionSchema,
    organizationId: idSchema,
    accountId: idSchema,
    conversationId: idSchema,
    limit: z.number().int().min(1).max(50).optional(),
  }).strict(),
  resultSchema: z.object({
    ...versionSchema,
    items: z.array(z.object({
      draftId: idSchema,
      conversationId: idSchema,
      draftVersion: z.number().int().positive(),
      humanEditVersion: z.number().int().nonnegative(),
      dlpDecision: z.enum(["PASS", "BLOCK", "REVIEW"]),
      publicationState: z.enum(["REVIEW_ONLY", "APPROVED", "REJECTED", "PUBLISHED"]),
      citationCount: z.number().int().nonnegative(),
      // Null whenever DLP did not pass, same rule as draftText: citations are
      // free-form jsonb and could carry source excerpts.
      citations: z.array(jsonValueSchema).nullable(),
      knowledgeVersionIds: z.array(idSchema),
      createdAt: timestampSchema,
      // NULL whenever DLP did not pass. Nullable rather than defaulted to "" so the
      // panel can tell "withheld" from "the model produced nothing".
      draftText: z.string().nullable(),
    }).strict()),
    limit: z.number().int().min(1).max(50),
  }).strict(),
} as const;

export const takeoverListContract = {
  rpcName: "openclaw_list_takeovers_v1",
  requestSchema: z.object({
    ...versionSchema,
    organizationId: idSchema,
    accountId: idSchema,
    limit: z.number().int().min(1).max(100).optional(),
  }).strict(),
  resultSchema: z.object({
    ...versionSchema,
    items: z.array(z.object({
      takeoverId: idSchema,
      conversationId: idSchema,
      ownerMembershipId: idSchema,
      // Decided server-side: the browser is never told its own membership id.
      heldByViewer: z.boolean(),
      takeoverVersion: z.number().int().positive(),
      startedAt: timestampSchema,
      expiresAt: timestampSchema,
    }).strict()),
    limit: z.number().int().min(1).max(100),
  }).strict(),
} as const;

/*
 * `qrPollContract` lived here and is gone: polling now goes through the
 * `openclaw-qr` Edge function, whose request shape is validated by that function's
 * own schema in src/lib/openclaw-zalo/__tests__/qrClient.test.ts rather than by a
 * second copy of the contract here.
 */

export const mediaResolveContract = {
  rpcName: "openclaw_resolve_media_object_v1",
  requestSchema: z.object({ ...versionSchema, organizationId: idSchema, mediaId: idSchema }).strict(),
  resultSchema: z.object({
    // `version` is the first key openclaw_resolve_media_object_v1 builds. Omitting
    // it from a .strict() schema made every real response throw
    // "unrecognized_keys: version", so the hook could never return an image.
    ...versionSchema,
    mediaId: idSchema,
    organizationId: idSchema,
    accountId: idSchema,
    conversationId: idSchema,
    messageId: idSchema,
    mime: z.string().min(1),
    byteLength: z.number().int().nonnegative(),
    sha256: hashSchema,
    objectKey: z.string().min(1),
    byteState: z.enum(["CACHED", "AVAILABLE"]),
    sessionGeneration: z.number().int().nonnegative(),
  }).strict(),
} as const;

function pairedCursorRequestSchema(cursorAtName: string) {
  return z.object({
    ...versionSchema,
    organizationId: idSchema,
    accountId: idSchema,
    limit: z.number().int().min(1).max(100).optional(),
    [cursorAtName]: timestampSchema.optional(),
    cursorId: idSchema.optional(),
  }).strict().superRefine((request, context) => {
    if ((request[cursorAtName] === undefined) !== (request.cursorId === undefined)) {
      context.addIssue({ code: "custom", message: "operation cursor fields must be provided together" });
    }
  });
}

export const unknownByAccountContract = {
  rpcName: "openclaw_list_unknown_by_account_v1",
  requestSchema: pairedCursorRequestSchema("cursorTerminalAt"),
  resultSchema: unknownResponseSchema,
} as const;

export const deadLettersByAccountContract = {
  rpcName: "openclaw_list_dead_letters_by_account_v1",
  requestSchema: pairedCursorRequestSchema("cursorCreatedAt"),
  resultSchema: pageSchema(deadLetterSchema),
} as const;

export const healthEventsByAccountContract = {
  rpcName: "openclaw_list_health_events_by_account_v1",
  requestSchema: pairedCursorRequestSchema("cursorObservedAt"),
  resultSchema: pageSchema(healthEventSchema),
} as const;

export const unknownResolutionGetContract = {
  rpcName: "openclaw_get_unknown_resolution_v1",
  requestSchema: z.object({
    ...versionSchema,
    organizationId: idSchema,
    accountId: idSchema,
    outboxId: idSchema,
  }).strict(),
  resultSchema: unknownResolutionSchema.nullable(),
} as const;

/**
 * The evidence an operator must echo back to resolve an UNKNOWN.
 *
 * Null means there is nothing left to authorise - already resolved, or not an
 * UNKNOWN at all - so a caller that gets null must show that rather than offer a
 * choice which could only fail.
 */
export const unknownAuthorityGetContract = {
  rpcName: "openclaw_get_unknown_authority_v1",
  requestSchema: z.object({
    ...versionSchema,
    organizationId: idSchema,
    accountId: idSchema,
    outboxId: idSchema,
  }).strict(),
  resultSchema: z.object({
    ...versionSchema,
    organizationId: idSchema,
    accountId: idSchema,
    outboxId: idSchema,
    // Pinned to the exact string the resolver compares against, trailing "\0" and
    // all: a domain built any other way is a guaranteed 40001.
    authorityDomain: z.literal("ihome-openclaw-unknown-authority-v1\\0"),
    authorityHash: hashSchema,
    resolutionVersion: z.literal(0),
  }).strict().nullable(),
} as const;

const knowledgeDraftResultSchema = z.object({
  ...versionSchema,
  sourceId: idSchema,
  knowledgeVersionId: idSchema,
  knowledgeVersion: z.number().int().positive(),
  lifecycleState: z.literal("DRAFT"),
  contentHash: hashSchema,
}).strict();

const knowledgeVersionRequestSchema = z.object({
  ...versionSchema,
  organizationId: idSchema,
  sourceId: idSchema,
  knowledgeVersionId: idSchema,
}).strict();

const knowledgeLifecycleResultSchema = z.object({
  ...versionSchema,
  sourceId: idSchema,
  knowledgeVersionId: idSchema,
  knowledgeVersion: z.number().int().positive(),
  lifecycleState: z.enum(["PUBLISHED", "ARCHIVED"]),
}).strict();

export const knowledgeMutationContracts = {
  create: {
    rpcName: "openclaw_create_knowledge_draft_v1",
    requestSchema: z.object({
      ...versionSchema,
      organizationId: idSchema,
      accountId: idSchema,
      title: z.string().min(1),
      sourceKind: knowledgeSourceKindSchema,
      sensitivity: knowledgeSensitivitySchema,
      content: z.string().min(1),
      metadata: jsonObjectSchema.optional(),
    }).strict(),
    resultSchema: knowledgeDraftResultSchema,
  },
  update: {
    rpcName: "openclaw_update_knowledge_draft_v1",
    requestSchema: z.object({
      ...versionSchema,
      organizationId: idSchema,
      sourceId: idSchema,
      expectedSourceVersion: z.number().int().nonnegative(),
      content: z.string().min(1),
      metadata: jsonObjectSchema.optional(),
    }).strict(),
    resultSchema: knowledgeDraftResultSchema,
  },
  validate: {
    rpcName: "openclaw_validate_knowledge_v1",
    requestSchema: knowledgeVersionRequestSchema,
    resultSchema: z.object({
      ...versionSchema,
      sourceId: idSchema,
      knowledgeVersionId: idSchema,
      valid: z.literal(true),
      contentHash: hashSchema,
    }).strict(),
  },
  publish: {
    rpcName: "openclaw_publish_knowledge_v1",
    requestSchema: knowledgeVersionRequestSchema,
    resultSchema: knowledgeLifecycleResultSchema.refine(value => value.lifecycleState === "PUBLISHED"),
  },
  archive: {
    rpcName: "openclaw_archive_knowledge_v1",
    requestSchema: knowledgeVersionRequestSchema,
    resultSchema: knowledgeLifecycleResultSchema.refine(value => value.lifecycleState === "ARCHIVED"),
  },
} as const;

const automationDraftResultSchema = z.object({
  ...versionSchema,
  automationId: idSchema,
  automationVersionId: idSchema,
  automationVersion: z.number().int().positive(),
  lifecycleState: z.literal("DRAFT"),
}).strict();

const automationVersionRequestSchema = z.object({
  ...versionSchema,
  organizationId: idSchema,
  automationId: idSchema,
  expectedAutomationVersion: z.number().int().positive(),
}).strict();

export const automationMutationContracts = {
  create: {
    rpcName: "openclaw_create_automation_draft_v1",
    requestSchema: z.object({
      ...versionSchema,
      organizationId: idSchema,
      accountId: idSchema,
      name: z.string().min(1),
      automationKind: automationKindSchema,
      mode: modeSchema,
      templateBody: z.string(),
      allowedCrmFields: z.array(z.string()).optional(),
      missingValuePolicy: z.enum(["REJECT", "EMPTY", "OMIT"]).optional(),
      escapingMode: z.enum(["PLAIN_TEXT", "CONTROL_SAFE"]).optional(),
      maximumRenderedCodepoints: z.number().int().min(1).max(40_000).optional(),
      policyVersionId: idSchema,
      knowledgeVersionIds: z.array(idSchema),
      configuration: jsonObjectSchema,
      dryRunHash: hashSchema.optional(),
    }).strict(),
    resultSchema: automationDraftResultSchema,
  },
  saveStep: {
    rpcName: "openclaw_save_automation_step_v1",
    requestSchema: z.object({
      ...versionSchema,
      organizationId: idSchema,
      automationId: idSchema,
      expectedAutomationVersion: z.number().int().positive(),
      configurationPatch: jsonObjectSchema,
      mode: modeSchema.optional(),
      templateBody: z.string().optional(),
      dryRunHash: hashSchema.optional(),
    }).strict(),
    resultSchema: automationDraftResultSchema,
  },
  publish: {
    rpcName: "openclaw_publish_automation_v1",
    requestSchema: automationVersionRequestSchema,
    resultSchema: z.object({
      ...versionSchema,
      automationId: idSchema,
      automationVersionId: idSchema,
      automationVersion: z.number().int().positive(),
      lifecycleState: z.literal("PUBLISHED"),
      dryRunHash: hashSchema,
    }).strict(),
  },
  pause: {
    rpcName: "openclaw_pause_automation_v1",
    requestSchema: automationVersionRequestSchema,
    resultSchema: z.object({
      ...versionSchema,
      automationId: idSchema,
      automationVersion: z.number().int().positive(),
      lifecycleState: z.literal("PAUSED"),
    }).strict(),
  },
} as const;

export const groupAllowlistMutationContract = {
  rpcName: "openclaw_upsert_group_allowlist_v1",
  requestSchema: z.object({
    ...versionSchema,
    organizationId: idSchema,
    targetId: idSchema,
    expectedAllowlistVersion: z.number().int().nonnegative(),
    isAllowed: z.boolean(),
    evidenceHash: hashSchema,
  }).strict(),
  resultSchema: z.object({
    ...versionSchema,
    allowlistId: idSchema,
    targetId: idSchema,
    allowlistVersion: z.number().int().positive(),
    isAllowed: z.boolean(),
  }).strict(),
} as const;

const scheduleVersionRequestSchema = z.object({
  ...versionSchema,
  organizationId: idSchema,
  scheduleId: idSchema,
  expectedScheduleVersion: z.number().int().positive(),
}).strict();

const scheduleMutationResultSchema = z.object({
  ...versionSchema,
  scheduleId: idSchema,
  scheduleVersion: z.number().int().positive(),
  status: z.enum(["PAUSED", "CANCELLED"]),
  snapshotHash: hashSchema,
}).strict();

export const scheduleMutationContracts = {
  upsert: {
    rpcName: "openclaw_upsert_schedule_v1",
    requestSchema: z.object({
      ...versionSchema,
      organizationId: idSchema,
      scheduleId: idSchema.optional(),
      expectedScheduleVersion: z.number().int().positive().optional(),
      accountId: idSchema,
      automationVersionId: idSchema,
      targetId: idSchema.nullable(),
      campaignVersionId: idSchema.nullable(),
      timezone: z.string().min(1),
      localRecurrenceRule: z.string().min(1),
      occurrenceGraceSeconds: z.number().int().nonnegative().optional(),
      dstFoldPolicy: z.string().min(1).optional(),
    }).strict(),
    resultSchema: scheduleMutationResultSchema.refine(value => value.status === "PAUSED"),
  },
  pause: {
    rpcName: "openclaw_pause_schedule_v1",
    requestSchema: scheduleVersionRequestSchema,
    resultSchema: scheduleMutationResultSchema.refine(value => value.status === "PAUSED"),
  },
  cancel: {
    rpcName: "openclaw_cancel_schedule_v1",
    requestSchema: scheduleVersionRequestSchema,
    resultSchema: scheduleMutationResultSchema.refine(value => value.status === "CANCELLED"),
  },
} as const;

export const directorySyncMutationContract = {
  rpcName: "openclaw_request_directory_sync_v1",
  requestSchema: z.object({ ...versionSchema, organizationId: idSchema, accountId: idSchema }).strict(),
  resultSchema: z.object({
    ...versionSchema,
    runtimeCommandId: idSchema,
    status: z.literal("PENDING"),
  }).strict(),
} as const;

const legalHoldTargetKindSchema = z.enum([
  "ORGANIZATION", "CONVERSATION", "MESSAGE", "MEDIA", "AI_DRAFT", "KNOWLEDGE",
  "HEALTH", "QR", "AUDIT", "POLICY", "CONTROL", "DELIVERY", "UNKNOWN",
  "SECURITY", "CONSENT", "RISK",
]);

export const legalHoldMutationContracts = {
  create: {
    rpcName: "openclaw_create_legal_hold_v1",
    requestSchema: z.object({
      ...versionSchema,
      organizationId: idSchema,
      targetKind: legalHoldTargetKindSchema,
      targetId: idSchema,
      reason: z.string().min(1),
      expiresAt: timestampSchema.nullable(),
    }).strict(),
    resultSchema: z.object({
      ...versionSchema,
      holdId: idSchema,
      targetKind: legalHoldTargetKindSchema,
      targetId: idSchema,
      holdVersion: z.number().int().positive(),
      active: z.literal(true),
    }).strict(),
  },
  release: {
    rpcName: "openclaw_release_legal_hold_v1",
    requestSchema: z.object({
      ...versionSchema,
      organizationId: idSchema,
      holdId: idSchema,
      expectedHoldVersion: z.number().int().positive(),
      releaseReason: z.string().min(1),
    }).strict(),
    resultSchema: z.object({
      ...versionSchema,
      holdId: idSchema,
      holdVersion: z.number().int().positive(),
      active: z.literal(false),
      releasedAt: timestampSchema,
    }).strict(),
  },
} as const;

export const deadLetterReplayMutationContract = {
  rpcName: "openclaw_replay_dead_letter_v1",
  requestSchema: z.object({
    ...versionSchema,
    organizationId: idSchema,
    deadLetterId: idSchema,
  }).strict(),
  resultSchema: z.union([
    z.object({
      ...versionSchema,
      deadLetterId: idSchema,
      sendWorkItemId: idSchema,
      state: z.literal("QUEUED"),
    }).strict(),
    z.object({
      ...versionSchema,
      deadLetterId: idSchema,
      newOutboxId: idSchema,
      state: z.literal("QUEUED"),
      payloadHash: hashSchema,
    }).strict(),
  ]),
} as const;

export const OPENCLAW_ACTION_CONTRACTS = [
  knowledgeListContract,
  knowledgeDetailContract,
  knowledgePreviewContract,
  automationListContract,
  automationDetailContract,
  automationDryRunContract,
  salesGroupListContract,
  scheduleListContract,
  aiDraftListContract,
  takeoverListContract,
  mediaResolveContract,
  unknownByAccountContract,
  deadLettersByAccountContract,
  healthEventsByAccountContract,
  unknownResolutionGetContract,
  unknownAuthorityGetContract,
  ...Object.values(knowledgeMutationContracts),
  ...Object.values(automationMutationContracts),
  groupAllowlistMutationContract,
  ...Object.values(scheduleMutationContracts),
  directorySyncMutationContract,
  ...Object.values(legalHoldMutationContracts),
  deadLetterReplayMutationContract,
] as const;
