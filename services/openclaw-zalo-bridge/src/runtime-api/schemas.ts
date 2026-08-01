import { createHash } from "node:crypto";

import type { DlpFinding } from "../ai/dlp.js";
import { canonicalJson } from "../spool/checksum.js";

const RFC3339_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

export type ZaloUserBridgeSendPartV1 =
  | Readonly<{ version: 1; partIndex: number; kind: "TEXT"; text: string }>
  | Readonly<{
      version: 1;
      partIndex: number;
      kind: "MEDIA";
      objectKey: string;
      sha256: string;
      mime: string;
      bytes: number;
    }>;

export interface CanonicalSendPayloadV1 {
  version: 1;
  organizationId: string;
  accountId: string;
  target: { kind: "PEER" | "SALES_GROUP"; providerId: string };
  channel: "zalouser";
  accountProfile: string;
  idempotencyKey: string;
  parts: ZaloUserBridgeSendPartV1[];
  replyToProviderMessageId: string | null;
  policyVersionId: string;
  automationVersionId: string | null;
  templateVersionId: string | null;
  frozenInputs: {
    campaignVersionId: string | null;
    scheduleVersion: number | null;
    subscriptionVersion: number | null;
    subscriptionId: string | null;
    occurrenceId: string | null;
    sourceTable: string | null;
    sourceId: string | null;
    sourceVersion: string | null;
    knowledgeVersionIds: string[];
    sourceSnapshotHash: string | null;
    targetVersion: number;
    targetDirectoryRefreshedAt: string;
    fieldMappingHash: string | null;
  };
}

export interface OutboundAuthorizationMarker {
  version: 1;
  outboxId: string;
  claimGeneration: number;
  payloadHash: string;
  fencingToken: number;
  sessionGeneration: number;
  controlVersion: number;
  takeoverVersion: number;
  markerNonce: string;
  expiresAt: string;
}

export interface OutboxAuthorizeSendRequestV1 {
  version: 1;
  claimToken: string;
  authorizationMarker: OutboundAuthorizationMarker;
}

export interface OutboxClaim {
  version: 1;
  outboxId: string;
  organizationId: string;
  accountId: string;
  claimToken: string;
  claimGeneration: number;
  fencingToken: number;
  sessionGeneration: number;
  controlVersion: number;
  takeoverVersion: number;
  leaseExpiresAt: string;
  payloadHash: string;
  payload: CanonicalSendPayloadV1;
}

export type DeliveryReasonCodeV1 =
  | "ALL_PARTS_ACKNOWLEDGED"
  | "PROVIDER_REJECTED_BEFORE_ACCEPT"
  | "PROVIDER_TIMEOUT_AFTER_POSSIBLE_HANDOFF"
  | "PROVIDER_DISCONNECT_AFTER_POSSIBLE_HANDOFF"
  | "ACK_LOST_AFTER_HANDOFF";

export type PreHandoffReasonCodeV1 =
  | "AUTHORIZATION_EXPIRED"
  | "LEASE_EXPIRED"
  | "CELL_FENCED"
  | "SESSION_GENERATION_CHANGED"
  | "CONTROL_VERSION_CHANGED"
  | "TAKEOVER_VERSION_CHANGED"
  | "POLICY_CHANGED_BEFORE_HANDOFF"
  | "ADAPTER_NOT_READY"
  | "EGRESS_BLOCKED_BEFORE_HANDOFF";

export interface DeliveryEvidenceBaseV1 {
  version: 1;
  evidenceKind: "OUTBOX_DELIVERY";
  outboxId: string;
  claimGeneration: number;
  payloadHash: string;
  authorizationMarker: OutboundAuthorizationMarker;
  totalPartCount: number;
  knownProviderMessageIds: string[];
  possibleHandoffPrefixLength: number;
}

export type DeliveryEvidenceV1 =
  | (DeliveryEvidenceBaseV1 & { outcome: "SENT" })
  | (DeliveryEvidenceBaseV1 & {
      outcome: "FAILED";
      reasonCode: "PROVIDER_REJECTED_BEFORE_ACCEPT";
    })
  | (DeliveryEvidenceBaseV1 & {
      outcome: "UNKNOWN";
      reasonCode:
        | "PROVIDER_TIMEOUT_AFTER_POSSIBLE_HANDOFF"
        | "PROVIDER_DISCONNECT_AFTER_POSSIBLE_HANDOFF"
        | "ACK_LOST_AFTER_HANDOFF";
    });

export type OutboxCompletionV1 = {
  version: 1;
  authorization: OutboxAuthorizeSendRequestV1;
  deliveryEvidence: DeliveryEvidenceV1;
  deliveryEvidenceHash: string;
} & (
  | { outcome: "SENT"; reasonCode: "ALL_PARTS_ACKNOWLEDGED" }
  | { outcome: "FAILED"; reasonCode: "PROVIDER_REJECTED_BEFORE_ACCEPT" }
  | {
      outcome: "UNKNOWN";
      reasonCode:
        | "PROVIDER_TIMEOUT_AFTER_POSSIBLE_HANDOFF"
        | "PROVIDER_DISCONNECT_AFTER_POSSIBLE_HANDOFF"
        | "ACK_LOST_AFTER_HANDOFF";
    }
);

export interface OutboxPreHandoffEvidenceV1 {
  version: 1;
  evidenceKind: "OUTBOX_PRE_HANDOFF";
  outboxId: string;
  claimGeneration: number;
  payloadHash: string;
  authorizationMarker: OutboundAuthorizationMarker;
  reasonCode: PreHandoffReasonCodeV1;
  authorizedHandoffRecorded: false;
}

export interface OutboxPreHandoffRequeueV1 {
  version: 1;
  authorization: OutboxAuthorizeSendRequestV1;
  outcome: "SAFE_RETRY";
  reasonCode: PreHandoffReasonCodeV1;
  preHandoffEvidence: OutboxPreHandoffEvidenceV1;
  preHandoffEvidenceHash: string;
  retryNotBefore: string;
}

export type OpenClawCrmSourceEnvelopeV1 =
  | {
      version: 1;
      eventType: "lead_created_or_assigned";
      eventSubtype: "CREATED" | "ASSIGNED" | "REASSIGNED";
      sourceTable: "leads";
      sourceId: string;
      sourceVersion: string;
      snapshot: { leadId: string; assignedStaffId: string | null; status: string };
    }
  | {
      version: 1;
      eventType: "room_became_available";
      eventSubtype: "FINAL_STATUS_AVAILABLE";
      sourceTable: "rooms";
      sourceId: string;
      sourceVersion: string;
      snapshot: { roomId: string; buildingId: string; roomStatus: "AVAILABLE" };
    }
  | {
      version: 1;
      eventType: "sales_task_due";
      eventSubtype: "FOLLOW_UP_DUE";
      sourceTable: "lead_activities";
      sourceId: string;
      sourceVersion: string;
      snapshot: {
        activityId: string;
        leadId: string;
        scheduledAt: string;
        scheduleRevision: number;
      };
    };

export type OpenClawSendWorkPayload =
  | {
      kind: "INBOUND_AUTOMATION";
      inboundEventId: string;
      messageId: string;
      conversationId: string;
      targetId: string;
      targetVersion: number;
      targetDirectoryRefreshedAt: string;
      automationVersionId: string;
      templateVersionId?: string;
      knowledgeVersionIds: string[];
      eligibilityDecisionHash: string;
    }
  | {
      kind: "SCHEDULE_OCCURRENCE";
      scheduleId: string;
      scheduleVersion: number;
      occurrenceId: string;
      campaignVersionId: string;
      targetId: string;
      targetVersion: number;
      targetDirectoryRefreshedAt: string;
      automationVersionId: string;
      templateVersionId: string;
      knowledgeVersionIds: string[];
      eligibilityDecisionHash: string;
    }
  | {
      kind: "CRM_EVENT";
      occurrenceId: string;
      subscriptionId: string;
      subscriptionVersion: number;
      campaignVersionId?: string;
      targetId: string;
      targetVersion: number;
      targetDirectoryRefreshedAt: string;
      automationVersionId: string;
      templateVersionId?: string;
      knowledgeVersionIds: string[];
      fieldMappingHash: string;
      sourceEnvelope: OpenClawCrmSourceEnvelopeV1;
      sourceEnvelopeHash: string;
    };

export interface OpenClawSendWorkClaimV1 {
  version: 1;
  workItemId: string;
  organizationId: string;
  accountId: string;
  cellId: string;
  credentialGeneration: number;
  leaseGeneration: number;
  sourceKey: string;
  claimToken: string;
  claimGeneration: number;
  fencingToken: number;
  leaseExpiresAt: string;
  payload: OpenClawSendWorkPayload;
}

export interface OpenClawWorkCompletionResultV1 {
  version: 1;
  workItemId: string;
  claimGeneration: number;
  outcome: "COMPLETED" | "SAFE_RETRY" | "DEAD_LETTER";
  canonicalEvidenceHash: string;
  completedAt: string | null;
  retryNotBefore: string | null;
}

export interface OpenClawCreateOutboxRequestV1 {
  version: 1;
  principalKind: "CHANNEL";
  claim: OpenClawSendWorkClaimV1;
  canonicalPayload: CanonicalSendPayloadV1;
  payloadHash: string;
  sourceSnapshotHash: string;
}

export type OpenClawWorkCompletionEvidenceV1 =
  | {
      version: 1;
      evidenceKind: "NO_SEND";
      reasonCode: string;
    }
  | {
      version: 1;
      evidenceKind: "HUMAN_DRAFT";
      reasonCode: string;
      classification: string | null;
      confidenceBasisPoints: number | null;
      findings: DlpFinding[];
      draftText: string;
      draftHash: string;
    }
  | {
      version: 1;
      evidenceKind: "WORK_FAILURE";
      reasonCode: string;
      failureFingerprint: string;
    };

export interface OpenClawChannelWorkCompletionRequestV1 {
  version: 1;
  workItemId: string;
  organizationId: string;
  accountId: string;
  cellId: string;
  credentialGeneration: number;
  leaseGeneration: number;
  claimToken: string;
  claimGeneration: number;
  fencingToken: number;
  outcome: "COMPLETE" | "RETRY" | "FAILED" | "DEAD_LETTER";
  evidence: OpenClawWorkCompletionEvidenceV1;
  evidenceHash: string;
  retryAfterSeconds: number | null;
}

const PAYLOAD_KEYS = [
  "version",
  "organizationId",
  "accountId",
  "target",
  "channel",
  "accountProfile",
  "idempotencyKey",
  "parts",
  "replyToProviderMessageId",
  "policyVersionId",
  "automationVersionId",
  "templateVersionId",
  "frozenInputs",
] as const;
const FROZEN_KEYS = [
  "campaignVersionId",
  "scheduleVersion",
  "subscriptionVersion",
  "subscriptionId",
  "occurrenceId",
  "sourceTable",
  "sourceId",
  "sourceVersion",
  "knowledgeVersionIds",
  "sourceSnapshotHash",
  "targetVersion",
  "targetDirectoryRefreshedAt",
  "fieldMappingHash",
] as const;
const MARKER_KEYS = [
  "version",
  "outboxId",
  "claimGeneration",
  "payloadHash",
  "fencingToken",
  "sessionGeneration",
  "controlVersion",
  "takeoverVersion",
  "markerNonce",
  "expiresAt",
] as const;

function fail(message: string): never {
  throw new TypeError(message);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  const result = record(value, name);
  const actual = Object.keys(result).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    return fail(`${name} must contain the exact fields: ${keys.join(", ")}`);
  }
  return result;
}

function exactOptional(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  name: string,
): Record<string, unknown> {
  const result = record(value, name);
  const allowed = new Set([...required, ...optional]);
  const actual = Object.keys(result);
  if (required.some((key) => !(key in result)) || actual.some((key) => !allowed.has(key))) {
    return fail(`${name} must contain only its canonical fields`);
  }
  return result;
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    return fail(`${name} must be a non-empty string`);
  }
  return value;
}

function nullableString(value: unknown, name: string): string | null {
  return value === null ? null : string(value, name);
}

function integer(value: unknown, name: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    return fail(`${name} must be a safe integer >= ${minimum}`);
  }
  return value as number;
}

function nullableInteger(value: unknown, name: string): number | null {
  return value === null ? null : integer(value, name);
}

function timestamp(value: unknown, name: string): string {
  const result = string(value, name);
  const parsed = new Date(result);
  if (!RFC3339_TIMESTAMP.test(result) || !Number.isFinite(parsed.valueOf())) {
    return fail(`${name} must be a canonical ISO timestamp`);
  }
  return result;
}

function sha256(value: unknown, name: string): string {
  const result = string(value, name);
  if (!/^[0-9a-f]{64}$/u.test(result)) return fail(`${name} must be a lowercase SHA-256`);
  return result;
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) return fail(`${name} must be an array`);
  return value.map((entry, index) => string(entry, `${name}[${index}]`));
}

function codePointCount(value: string): number {
  return Array.from(value).length;
}

function parsePart(value: unknown, expectedIndex: number): ZaloUserBridgeSendPartV1 {
  const base = record(value, `parts[${expectedIndex}]`);
  if (base.version !== 1 || base.partIndex !== expectedIndex) {
    return fail(`parts[${expectedIndex}] has an invalid partIndex`);
  }
  if (base.kind === "TEXT") {
    const part = exact(base, ["version", "partIndex", "kind", "text"], `parts[${expectedIndex}]`);
    const text = string(part.text, `parts[${expectedIndex}].text`);
    if (codePointCount(text) > 2_000) return fail(`parts[${expectedIndex}] exceeds 2000 code points`);
    return { version: 1, partIndex: expectedIndex, kind: "TEXT", text };
  }
  if (base.kind === "MEDIA") {
    const part = exact(
      base,
      ["version", "partIndex", "kind", "objectKey", "sha256", "mime", "bytes"],
      `parts[${expectedIndex}]`,
    );
    const mime = string(part.mime, `parts[${expectedIndex}].mime`);
    if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(mime)) {
      return fail(`parts[${expectedIndex}].mime is invalid`);
    }
    return {
      version: 1,
      partIndex: expectedIndex,
      kind: "MEDIA",
      objectKey: string(part.objectKey, `parts[${expectedIndex}].objectKey`),
      sha256: sha256(part.sha256, `parts[${expectedIndex}].sha256`),
      mime,
      bytes: integer(part.bytes, `parts[${expectedIndex}].bytes`, 1),
    };
  }
  return fail(`parts[${expectedIndex}] uses an unsupported kind`);
}

export function snapshotCanonicalSendPayload(value: unknown): CanonicalSendPayloadV1 {
  const payload = exact(value, PAYLOAD_KEYS, "payload");
  if (payload.version !== 1 || payload.channel !== "zalouser") {
    return fail("payload version/channel is invalid");
  }
  const target = exact(payload.target, ["kind", "providerId"], "payload.target");
  if (target.kind !== "PEER" && target.kind !== "SALES_GROUP") {
    return fail("payload.target.kind is invalid");
  }
  if (!Array.isArray(payload.parts) || payload.parts.length < 1 || payload.parts.length > 20) {
    return fail("payload.parts must contain 1-20 parts");
  }
  const frozen = exact(payload.frozenInputs, FROZEN_KEYS, "payload.frozenInputs");
  return {
    version: 1,
    organizationId: string(payload.organizationId, "payload.organizationId"),
    accountId: string(payload.accountId, "payload.accountId"),
    target: {
      kind: target.kind,
      providerId: string(target.providerId, "payload.target.providerId"),
    },
    channel: "zalouser",
    accountProfile: string(payload.accountProfile, "payload.accountProfile"),
    idempotencyKey: string(payload.idempotencyKey, "payload.idempotencyKey"),
    parts: payload.parts.map(parsePart),
    replyToProviderMessageId: nullableString(
      payload.replyToProviderMessageId,
      "payload.replyToProviderMessageId",
    ),
    policyVersionId: string(payload.policyVersionId, "payload.policyVersionId"),
    automationVersionId: nullableString(payload.automationVersionId, "payload.automationVersionId"),
    templateVersionId: nullableString(payload.templateVersionId, "payload.templateVersionId"),
    frozenInputs: {
      campaignVersionId: nullableString(frozen.campaignVersionId, "frozenInputs.campaignVersionId"),
      scheduleVersion: nullableInteger(frozen.scheduleVersion, "frozenInputs.scheduleVersion"),
      subscriptionVersion: nullableInteger(
        frozen.subscriptionVersion,
        "frozenInputs.subscriptionVersion",
      ),
      subscriptionId: nullableString(frozen.subscriptionId, "frozenInputs.subscriptionId"),
      occurrenceId: nullableString(frozen.occurrenceId, "frozenInputs.occurrenceId"),
      sourceTable: nullableString(frozen.sourceTable, "frozenInputs.sourceTable"),
      sourceId: nullableString(frozen.sourceId, "frozenInputs.sourceId"),
      sourceVersion: nullableString(frozen.sourceVersion, "frozenInputs.sourceVersion"),
      knowledgeVersionIds: stringArray(
        frozen.knowledgeVersionIds,
        "frozenInputs.knowledgeVersionIds",
      ),
      sourceSnapshotHash: nullableString(
        frozen.sourceSnapshotHash,
        "frozenInputs.sourceSnapshotHash",
      ),
      targetVersion: integer(frozen.targetVersion, "frozenInputs.targetVersion"),
      targetDirectoryRefreshedAt: timestamp(
        frozen.targetDirectoryRefreshedAt,
        "frozenInputs.targetDirectoryRefreshedAt",
      ),
      fieldMappingHash: nullableString(frozen.fieldMappingHash, "frozenInputs.fieldMappingHash"),
    },
  };
}

export function hashCanonicalSendPayload(payload: CanonicalSendPayloadV1): string {
  const snapshot = snapshotCanonicalSendPayload(payload);
  return createHash("sha256")
    .update("ihome-openclaw-send-v1\0", "utf8")
    .update(canonicalJson(snapshot), "utf8")
    .digest("hex");
}

export function parseOutboundAuthorizationMarker(value: unknown): OutboundAuthorizationMarker {
  const marker = exact(value, MARKER_KEYS, "authorization marker");
  if (marker.version !== 1) return fail("authorization marker version must be 1");
  return {
    version: 1,
    outboxId: string(marker.outboxId, "marker.outboxId"),
    claimGeneration: integer(marker.claimGeneration, "marker.claimGeneration", 1),
    payloadHash: sha256(marker.payloadHash, "marker.payloadHash"),
    fencingToken: integer(marker.fencingToken, "marker.fencingToken", 1),
    sessionGeneration: integer(marker.sessionGeneration, "marker.sessionGeneration"),
    controlVersion: integer(marker.controlVersion, "marker.controlVersion"),
    takeoverVersion: integer(marker.takeoverVersion, "marker.takeoverVersion"),
    markerNonce: string(marker.markerNonce, "marker.markerNonce"),
    expiresAt: timestamp(marker.expiresAt, "marker.expiresAt"),
  };
}

export function parseOutboxClaim(value: unknown): OutboxClaim {
  const claim = exact(value, [
    "version",
    "outboxId",
    "organizationId",
    "accountId",
    "claimToken",
    "claimGeneration",
    "fencingToken",
    "sessionGeneration",
    "controlVersion",
    "takeoverVersion",
    "leaseExpiresAt",
    "payloadHash",
    "payload",
  ], "outbox claim");
  if (claim.version !== 1) return fail("outbox claim version must be 1");
  const payload = snapshotCanonicalSendPayload(claim.payload);
  const payloadHash = sha256(claim.payloadHash, "claim.payloadHash");
  if (hashCanonicalSendPayload(payload) !== payloadHash) return fail("outbox claim payload hash mismatch");
  const organizationId = string(claim.organizationId, "claim.organizationId");
  const accountId = string(claim.accountId, "claim.accountId");
  if (payload.organizationId !== organizationId || payload.accountId !== accountId) {
    return fail("outbox claim payload tenant mismatch");
  }
  return {
    version: 1,
    outboxId: string(claim.outboxId, "claim.outboxId"),
    organizationId,
    accountId,
    claimToken: string(claim.claimToken, "claim.claimToken"),
    claimGeneration: integer(claim.claimGeneration, "claim.claimGeneration", 1),
    fencingToken: integer(claim.fencingToken, "claim.fencingToken", 1),
    sessionGeneration: integer(claim.sessionGeneration, "claim.sessionGeneration"),
    controlVersion: integer(claim.controlVersion, "claim.controlVersion"),
    takeoverVersion: integer(claim.takeoverVersion, "claim.takeoverVersion"),
    leaseExpiresAt: timestamp(claim.leaseExpiresAt, "claim.leaseExpiresAt"),
    payloadHash,
    payload,
  };
}

function parseCrmEnvelope(value: unknown): OpenClawCrmSourceEnvelopeV1 {
  const envelope = record(value, "CRM source envelope");
  if (envelope.eventType === "room_became_available") {
    const result = exact(envelope, [
      "version", "eventType", "eventSubtype", "sourceTable", "sourceId", "sourceVersion", "snapshot",
    ], "CRM room envelope");
    const snapshot = exact(result.snapshot, ["roomId", "buildingId", "roomStatus"], "CRM room snapshot");
    if (
      result.version !== 1 || result.eventSubtype !== "FINAL_STATUS_AVAILABLE" ||
      result.sourceTable !== "rooms" || snapshot.roomStatus !== "AVAILABLE"
    ) return fail("CRM room envelope discriminator is invalid");
    return {
      version: 1,
      eventType: "room_became_available",
      eventSubtype: "FINAL_STATUS_AVAILABLE",
      sourceTable: "rooms",
      sourceId: string(result.sourceId, "sourceId"),
      sourceVersion: string(result.sourceVersion, "sourceVersion"),
      snapshot: {
        roomId: string(snapshot.roomId, "snapshot.roomId"),
        buildingId: string(snapshot.buildingId, "snapshot.buildingId"),
        roomStatus: "AVAILABLE",
      },
    };
  }
  if (envelope.eventType === "lead_created_or_assigned") {
    const result = exact(envelope, [
      "version", "eventType", "eventSubtype", "sourceTable", "sourceId", "sourceVersion", "snapshot",
    ], "CRM lead envelope");
    const snapshot = exact(result.snapshot, ["leadId", "assignedStaffId", "status"], "CRM lead snapshot");
    if (
      result.version !== 1 || !["CREATED", "ASSIGNED", "REASSIGNED"].includes(String(result.eventSubtype)) ||
      result.sourceTable !== "leads"
    ) return fail("CRM lead envelope discriminator is invalid");
    return {
      version: 1,
      eventType: "lead_created_or_assigned",
      eventSubtype: result.eventSubtype as "CREATED" | "ASSIGNED" | "REASSIGNED",
      sourceTable: "leads",
      sourceId: string(result.sourceId, "sourceId"),
      sourceVersion: string(result.sourceVersion, "sourceVersion"),
      snapshot: {
        leadId: string(snapshot.leadId, "snapshot.leadId"),
        assignedStaffId: nullableString(snapshot.assignedStaffId, "snapshot.assignedStaffId"),
        status: string(snapshot.status, "snapshot.status"),
      },
    };
  }
  if (envelope.eventType === "sales_task_due") {
    const result = exact(envelope, [
      "version", "eventType", "eventSubtype", "sourceTable", "sourceId", "sourceVersion", "snapshot",
    ], "CRM task envelope");
    const snapshot = exact(
      result.snapshot,
      ["activityId", "leadId", "scheduledAt", "scheduleRevision"],
      "CRM task snapshot",
    );
    if (
      result.version !== 1 || result.eventSubtype !== "FOLLOW_UP_DUE" ||
      result.sourceTable !== "lead_activities"
    ) return fail("CRM task envelope discriminator is invalid");
    return {
      version: 1,
      eventType: "sales_task_due",
      eventSubtype: "FOLLOW_UP_DUE",
      sourceTable: "lead_activities",
      sourceId: string(result.sourceId, "sourceId"),
      sourceVersion: string(result.sourceVersion, "sourceVersion"),
      snapshot: {
        activityId: string(snapshot.activityId, "snapshot.activityId"),
        leadId: string(snapshot.leadId, "snapshot.leadId"),
        scheduledAt: timestamp(snapshot.scheduledAt, "snapshot.scheduledAt"),
        scheduleRevision: integer(snapshot.scheduleRevision, "snapshot.scheduleRevision"),
      },
    };
  }
  return fail("unsupported CRM source envelope");
}

function parseWorkPayload(value: unknown): OpenClawSendWorkPayload {
  const payload = record(value, "send work payload");
  if (payload.kind === "INBOUND_AUTOMATION") {
    const item = exactOptional(payload, [
      "kind", "inboundEventId", "messageId", "conversationId", "targetId",
      "targetVersion", "targetDirectoryRefreshedAt", "automationVersionId",
      "knowledgeVersionIds", "eligibilityDecisionHash",
    ], ["templateVersionId"], "inbound automation payload");
    const result: OpenClawSendWorkPayload = {
      kind: "INBOUND_AUTOMATION",
      inboundEventId: string(item.inboundEventId, "payload.inboundEventId"),
      messageId: string(item.messageId, "payload.messageId"),
      conversationId: string(item.conversationId, "payload.conversationId"),
      targetId: string(item.targetId, "payload.targetId"),
      targetVersion: integer(item.targetVersion, "payload.targetVersion", 1),
      targetDirectoryRefreshedAt: timestamp(
        item.targetDirectoryRefreshedAt,
        "payload.targetDirectoryRefreshedAt",
      ),
      automationVersionId: string(item.automationVersionId, "payload.automationVersionId"),
      knowledgeVersionIds: stringArray(item.knowledgeVersionIds, "payload.knowledgeVersionIds"),
      eligibilityDecisionHash: sha256(
        item.eligibilityDecisionHash,
        "payload.eligibilityDecisionHash",
      ),
    };
    if (item.templateVersionId !== undefined) {
      result.templateVersionId = string(item.templateVersionId, "payload.templateVersionId");
    }
    return result;
  }
  if (payload.kind === "SCHEDULE_OCCURRENCE") {
    const item = exact(payload, [
      "kind", "scheduleId", "scheduleVersion", "occurrenceId", "campaignVersionId", "targetId",
      "targetVersion", "targetDirectoryRefreshedAt", "automationVersionId", "templateVersionId",
      "knowledgeVersionIds", "eligibilityDecisionHash",
    ], "schedule payload");
    return {
      kind: "SCHEDULE_OCCURRENCE",
      scheduleId: string(item.scheduleId, "payload.scheduleId"),
      scheduleVersion: integer(item.scheduleVersion, "payload.scheduleVersion"),
      occurrenceId: string(item.occurrenceId, "payload.occurrenceId"),
      campaignVersionId: string(item.campaignVersionId, "payload.campaignVersionId"),
      targetId: string(item.targetId, "payload.targetId"),
      targetVersion: integer(item.targetVersion, "payload.targetVersion"),
      targetDirectoryRefreshedAt: timestamp(
        item.targetDirectoryRefreshedAt,
        "payload.targetDirectoryRefreshedAt",
      ),
      automationVersionId: string(item.automationVersionId, "payload.automationVersionId"),
      templateVersionId: string(item.templateVersionId, "payload.templateVersionId"),
      knowledgeVersionIds: stringArray(item.knowledgeVersionIds, "payload.knowledgeVersionIds"),
      eligibilityDecisionHash: sha256(
        item.eligibilityDecisionHash,
        "payload.eligibilityDecisionHash",
      ),
    };
  }
  if (payload.kind === "CRM_EVENT") {
    const item = exactOptional(payload, [
      "kind", "occurrenceId", "subscriptionId", "subscriptionVersion",
      "targetId", "targetVersion", "targetDirectoryRefreshedAt", "automationVersionId",
      "knowledgeVersionIds", "fieldMappingHash", "sourceEnvelope",
      "sourceEnvelopeHash",
    ], ["campaignVersionId", "templateVersionId"], "CRM event payload");
    const result: OpenClawSendWorkPayload = {
      kind: "CRM_EVENT",
      occurrenceId: string(item.occurrenceId, "payload.occurrenceId"),
      subscriptionId: string(item.subscriptionId, "payload.subscriptionId"),
      subscriptionVersion: integer(item.subscriptionVersion, "payload.subscriptionVersion"),
      targetId: string(item.targetId, "payload.targetId"),
      targetVersion: integer(item.targetVersion, "payload.targetVersion"),
      targetDirectoryRefreshedAt: timestamp(
        item.targetDirectoryRefreshedAt,
        "payload.targetDirectoryRefreshedAt",
      ),
      automationVersionId: string(item.automationVersionId, "payload.automationVersionId"),
      knowledgeVersionIds: stringArray(item.knowledgeVersionIds, "payload.knowledgeVersionIds"),
      fieldMappingHash: sha256(item.fieldMappingHash, "payload.fieldMappingHash"),
      sourceEnvelope: parseCrmEnvelope(item.sourceEnvelope),
      sourceEnvelopeHash: sha256(item.sourceEnvelopeHash, "payload.sourceEnvelopeHash"),
    };
    if (item.campaignVersionId !== undefined) {
      result.campaignVersionId = string(item.campaignVersionId, "payload.campaignVersionId");
    }
    if (item.templateVersionId !== undefined) {
      result.templateVersionId = string(item.templateVersionId, "payload.templateVersionId");
    }
    return result;
  }
  return fail("unsupported send work kind");
}

export function parseOpenClawSendWorkClaimV1(value: unknown): OpenClawSendWorkClaimV1 {
  const claim = exact(value, [
    "version", "workItemId", "organizationId", "accountId", "cellId", "credentialGeneration",
    "leaseGeneration", "sourceKey", "claimToken", "claimGeneration", "fencingToken",
    "leaseExpiresAt", "payload",
  ], "send work claim");
  if (claim.version !== 1) return fail("send work claim version must be 1");
  return {
    version: 1,
    workItemId: string(claim.workItemId, "claim.workItemId"),
    organizationId: string(claim.organizationId, "claim.organizationId"),
    accountId: string(claim.accountId, "claim.accountId"),
    cellId: string(claim.cellId, "claim.cellId"),
    credentialGeneration: integer(claim.credentialGeneration, "claim.credentialGeneration", 1),
    leaseGeneration: integer(claim.leaseGeneration, "claim.leaseGeneration", 1),
    sourceKey: string(claim.sourceKey, "claim.sourceKey"),
    claimToken: string(claim.claimToken, "claim.claimToken"),
    claimGeneration: integer(claim.claimGeneration, "claim.claimGeneration", 1),
    fencingToken: integer(claim.fencingToken, "claim.fencingToken", 1),
    leaseExpiresAt: timestamp(claim.leaseExpiresAt, "claim.leaseExpiresAt"),
    payload: parseWorkPayload(claim.payload),
  };
}
