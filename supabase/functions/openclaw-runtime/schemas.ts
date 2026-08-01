/**
 * The single checked table the runtime API is allowed to act on:
 *
 *   path -> operation -> principal audience -> strict request schema
 *        -> public service facade
 *
 * Any combination that is not present here is rejected before a database
 * connection is opened. Adding a route requires adding a row.
 */

export type RuntimePrincipalKind = "CHANNEL" | "MAINTENANCE";

export interface RuntimeRouteDefinition {
  path: string;
  operation: string;
  principalKind: RuntimePrincipalKind;
  facade: string;
  /** Exact private operation expected by the SQL service-context validator. */
  serviceOperation: string;
  /** Work kinds the route may claim, when the route is a work route. */
  workKinds?: readonly string[];
  validateRequest: (value: unknown) => boolean;
  validateResponse: (value: unknown) => boolean;
}

export const CHANNEL_WORK_KINDS = Object.freeze([
  "INBOUND_AUTOMATION",
  "SCHEDULE_OCCURRENCE",
  "CRM_EVENT",
] as const);

export const MAINTENANCE_WORK_KINDS = Object.freeze([
  "RETENTION_DELETE",
  "AUDIT_ANCHOR",
] as const);

const RUNTIME_ROUTE_DEFINITIONS: readonly Omit<
  RuntimeRouteDefinition,
  "validateRequest" | "validateResponse"
>[] = Object.freeze([
  {
    path: "/v1/heartbeat",
    operation: "heartbeat",
    principalKind: "CHANNEL",
    facade: "openclaw_service_runtime_heartbeat_v1",
    serviceOperation: "openclaw_runtime_heartbeat_v1",
  },
  {
    path: "/v1/qr/publish",
    operation: "qr.publish",
    principalKind: "CHANNEL",
    facade: "openclaw_service_submit_qr_result_v1",
    serviceOperation: "openclaw_submit_qr_result_v1",
  },
  {
    path: "/v1/qr/result",
    operation: "qr.result",
    principalKind: "CHANNEL",
    facade: "openclaw_service_finalize_account_connection_v1",
    serviceOperation: "openclaw_finalize_account_connection_v1",
  },
  {
    path: "/v1/inbound/batch",
    operation: "inbound.commit",
    principalKind: "CHANNEL",
    facade: "openclaw_service_ingest_inbound_batch_v1",
    serviceOperation: "openclaw_ingest_inbound_batch_v1",
  },
  {
    path: "/v1/outbox/claim",
    operation: "outbox.claim",
    principalKind: "CHANNEL",
    facade: "openclaw_service_claim_outbox_v1",
    serviceOperation: "openclaw_claim_outbox_v1",
  },
  {
    path: "/v1/outbox/preflight",
    operation: "outbox.preflight",
    principalKind: "CHANNEL",
    facade: "openclaw_service_preflight_outbox_v1",
    serviceOperation: "openclaw_preflight_outbox_v1",
  },
  {
    path: "/v1/outbox/authorize-send",
    operation: "outbox.authorize-send",
    principalKind: "CHANNEL",
    facade: "openclaw_service_authorize_outbox_send_v1",
    serviceOperation: "openclaw_authorize_outbox_send_v1",
  },
  {
    path: "/v1/outbox/requeue",
    operation: "outbox.requeue",
    principalKind: "CHANNEL",
    facade: "openclaw_service_requeue_pre_handoff_v1",
    serviceOperation: "openclaw_requeue_pre_handoff_v1",
  },
  {
    path: "/v1/outbox/complete",
    operation: "outbox.complete",
    principalKind: "CHANNEL",
    facade: "openclaw_service_complete_outbox_v1",
    serviceOperation: "openclaw_complete_outbox_v1",
  },
  {
    path: "/v1/work/claim",
    operation: "work.claim",
    principalKind: "CHANNEL",
    facade: "openclaw_service_claim_work_item_v1",
    serviceOperation: "openclaw_claim_work_item_v1",
    workKinds: CHANNEL_WORK_KINDS,
  },
  {
    path: "/v1/work/context",
    operation: "work.context",
    principalKind: "CHANNEL",
    facade: "openclaw_service_get_work_context_v1",
    serviceOperation: "openclaw_get_work_context_v1",
    workKinds: CHANNEL_WORK_KINDS,
  },
  {
    path: "/v1/work/complete",
    operation: "work.complete",
    principalKind: "CHANNEL",
    facade: "openclaw_service_complete_work_item_v1",
    serviceOperation: "openclaw_complete_work_item_v1",
    workKinds: CHANNEL_WORK_KINDS,
  },
  {
    path: "/v1/work/create-outbox",
    operation: "work.complete",
    principalKind: "CHANNEL",
    facade: "openclaw_service_create_outbox_from_work_v1",
    serviceOperation: "openclaw_create_outbox_from_work_v1",
    workKinds: CHANNEL_WORK_KINDS,
  },
  {
    path: "/v1/media/upload-ticket",
    operation: "media.issue",
    principalKind: "CHANNEL",
    facade: "openclaw_service_issue_media_ticket_v1",
    serviceOperation: "openclaw_issue_media_ticket_v1",
  },
  {
    path: "/v1/media/upload-complete",
    operation: "media.issue",
    principalKind: "CHANNEL",
    facade: "openclaw_service_finalize_media_upload_v1",
    serviceOperation: "openclaw_finalize_media_upload_v1",
  },
  {
    path: "/v1/maintenance/work/claim",
    operation: "maintenance.claim",
    principalKind: "MAINTENANCE",
    facade: "openclaw_service_claim_work_item_v1",
    serviceOperation: "openclaw_claim_work_item_v1",
    workKinds: MAINTENANCE_WORK_KINDS,
  },
  {
    path: "/v1/maintenance/work/complete",
    operation: "maintenance.complete",
    principalKind: "MAINTENANCE",
    facade: "openclaw_service_complete_maintenance_work_v1",
    serviceOperation: "openclaw_complete_maintenance_work_v1",
    workKinds: MAINTENANCE_WORK_KINDS,
  },
  {
    path: "/v1/maintenance/media/upload-ticket",
    operation: "maintenance.complete",
    principalKind: "MAINTENANCE",
    facade: "openclaw_service_issue_media_ticket_v1",
    serviceOperation: "openclaw_issue_media_ticket_v1",
  },
  {
    path: "/v1/maintenance/media/verify-ticket",
    operation: "maintenance.complete",
    principalKind: "MAINTENANCE",
    facade: "openclaw_service_issue_media_ticket_v1",
    serviceOperation: "openclaw_issue_media_ticket_v1",
  },
  {
    path: "/v1/maintenance/retention/delete-ticket",
    operation: "maintenance.complete",
    principalKind: "MAINTENANCE",
    facade: "openclaw_service_issue_retention_delete_ticket_v1",
    serviceOperation: "openclaw_issue_retention_delete_ticket_v1",
  },
  {
    path: "/v1/maintenance/retention/authorize-delete",
    operation: "maintenance.complete",
    principalKind: "MAINTENANCE",
    facade: "openclaw_service_authorize_retention_delete_v1",
    serviceOperation: "openclaw_authorize_retention_delete_v1",
  },
]);

export const RUNTIME_ROUTES: readonly RuntimeRouteDefinition[] = Object.freeze(
  RUNTIME_ROUTE_DEFINITIONS.map((definition) => Object.freeze({
    ...definition,
    validateRequest: (value: unknown) =>
      definition.path === "/v1/inbound/batch"
        ? validateInboundBatch(value).ok
        : validateRuntimeRequestBody(definition.path, value),
    validateResponse: (value: unknown) =>
      validateRuntimeResponseBody(definition.path, value),
  })),
);

const ROUTE_BY_PATH = new Map(RUNTIME_ROUTES.map((route) => [route.path, route]));

export function findRuntimeRoute(
  method: string,
  path: string,
): RuntimeRouteDefinition | null {
  if (method !== "POST") return null;
  return ROUTE_BY_PATH.get(path) ?? null;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const OPENCLAW_MAX_INBOUND_BATCH_COUNT = 100;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Field names that must never appear anywhere in a runtime request body. The
 * runtime is not allowed to push secret material through the control plane.
 */
const FORBIDDEN_FIELD_NAMES = new Set([
  "credential",
  "credentialhash",
  "credentialproofsha256",
  "password",
  "secret",
  "runtimetoken",
  "sessiontoken",
  "sessionsecret",
  "accesstoken",
  "refreshtoken",
  "servicerolekey",
  "apikey",
  "cookie",
  "privatekey",
  "signingkey",
]);

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function findSecretLikeField(value: unknown): string | null {
  const pending: unknown[] = [value];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    visited += 1;
    // Parsed runtime JSON is globally byte-bounded; this independent node cap
    // prevents pathological nesting/fan-out from turning the scan into unbounded work.
    if (visited > 100_000) return "__STRUCTURE_TOO_COMPLEX__";
    if (Array.isArray(current)) {
      for (const entry of current) pending.push(entry);
      continue;
    }
    if (!isPlainObject(current)) continue;
    for (const [key, entry] of Object.entries(current)) {
      if (FORBIDDEN_FIELD_NAMES.has(normalizedKey(key))) return key;
      pending.push(entry);
    }
  }
  return null;
}

export interface InboundBatchValidation {
  ok: boolean;
  reason?: string;
}

const INBOUND_BATCH_KEYS = [
  "version", "organizationId", "accountId", "cellId", "sessionGeneration", "events",
] as const;
const INBOUND_EVENT_KEYS = [
  "version", "eventKind", "providerEventId", "providerMessageId",
  "providerConversationId", "providerSenderId", "providerTarget", "providerEventType",
  "sourceTimestamp", "callbackReceivedAt", "rawEnvelope", "rawEnvelopeSha256",
  "normalized", "normalizedSha256",
] as const;
const INBOUND_NORMALIZED_KEYS = [
  "text", "replyToProviderMessageId", "mediaManifest",
] as const;
const INBOUND_MEDIA_KEYS = [
  "version", "index", "providerMediaId", "kind", "mime", "byteLength",
  "providerChecksum", "fetchRef", "byteState",
] as const;
const INBOUND_EVENT_KINDS = new Set([
  "MESSAGE", "REACTION", "DELIVERY_RECEIPT", "SEEN", "TYPING", "MEMBERSHIP", "OTHER",
]);
const INBOUND_MEDIA_KINDS = new Set([
  "IMAGE", "VIDEO", "AUDIO", "FILE", "STICKER", "OTHER",
]);

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isBoundedString(value: unknown, maximum: number, nullable = false): boolean {
  return (nullable && value === null) ||
    (typeof value === "string" && value.length > 0 && value.length <= maximum);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.valueOf()) && timestamp.toISOString() === value;
}

function validInboundMediaManifest(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 20) return false;
  return value.every((entry, index) => {
    if (!isPlainObject(entry) || !hasExactKeys(entry, INBOUND_MEDIA_KEYS)) return false;
    return entry.version === 1 && entry.index === index &&
      isBoundedString(entry.providerMediaId, 255, true) &&
      typeof entry.kind === "string" && INBOUND_MEDIA_KINDS.has(entry.kind) &&
      (entry.mime === null ||
        (typeof entry.mime === "string" && entry.mime.length >= 3 && entry.mime.length <= 255)) &&
      (entry.byteLength === null ||
        (Number.isSafeInteger(entry.byteLength) && Number(entry.byteLength) >= 0 &&
          Number(entry.byteLength) <= 52_428_800)) &&
      (entry.providerChecksum === null || isSha256(entry.providerChecksum)) &&
      isBoundedString(entry.fetchRef, 2_048, true) && entry.byteState === "PENDING";
  });
}

function validInboundEvent(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value) || !hasExactKeys(value, INBOUND_EVENT_KEYS)) return false;
  if (
    value.version !== 1 || typeof value.eventKind !== "string" ||
    !INBOUND_EVENT_KINDS.has(value.eventKind) ||
    !isBoundedString(value.providerEventId, 255, true) ||
    !isBoundedString(value.providerMessageId, 255, true) ||
    !isBoundedString(value.providerConversationId, 255) ||
    !isBoundedString(value.providerSenderId, 255) ||
    !isBoundedString(value.providerEventType, 128) ||
    !isCanonicalTimestamp(value.sourceTimestamp) ||
    !isCanonicalTimestamp(value.callbackReceivedAt) ||
    !isSha256(value.rawEnvelopeSha256) || !isSha256(value.normalizedSha256)
  ) return false;
  if (!isPlainObject(value.providerTarget) ||
    !hasExactKeys(value.providerTarget, ["kind", "providerId"]) ||
    (value.providerTarget.kind !== "PEER" && value.providerTarget.kind !== "SALES_GROUP") ||
    !isBoundedString(value.providerTarget.providerId, 255)
  ) return false;
  if (!isPlainObject(value.normalized) ||
    !hasExactKeys(value.normalized, INBOUND_NORMALIZED_KEYS) ||
    (value.normalized.text !== null && typeof value.normalized.text !== "string") ||
    !isBoundedString(value.normalized.replyToProviderMessageId, 255, true) ||
    !validInboundMediaManifest(value.normalized.mediaManifest)
  ) return false;
  return true;
}

/**
 * Inbound batches carry provider evidence, so they get their own structural
 * checks before any DB call: bounded count, one organization/account, and no
 * duplicate event id that disagrees with itself.
 */
export function validateInboundBatch(body: unknown): InboundBatchValidation {
  if (!isPlainObject(body) || !hasExactKeys(body, INBOUND_BATCH_KEYS) ||
    body.version !== 1 || typeof body.organizationId !== "string" ||
    !UUID_PATTERN.test(body.organizationId) || typeof body.accountId !== "string" ||
    !UUID_PATTERN.test(body.accountId) || typeof body.cellId !== "string" ||
    !UUID_PATTERN.test(body.cellId) || !Number.isSafeInteger(body.sessionGeneration) ||
    Number(body.sessionGeneration) < 0
  ) return { ok: false, reason: "BATCH_INVALID" };
  const events = body.events;
  if (!Array.isArray(events) || events.length === 0) {
    return { ok: false, reason: "BATCH_INVALID" };
  }
  if (events.length > OPENCLAW_MAX_INBOUND_BATCH_COUNT) {
    return { ok: false, reason: "BATCH_TOO_LARGE" };
  }

  const identityBindings = new Map<string, string>();

  for (const event of events) {
    if (!validInboundEvent(event)) return { ok: false, reason: "BATCH_INVALID" };
    const eventId = event.providerEventId as string | null;
    const messageId = event.providerMessageId as string | null;
    const binding = `${event.eventKind}\0${eventId ?? ""}\0${messageId ?? ""}\0` +
      `${event.rawEnvelopeSha256}\0${event.normalizedSha256}`;
    for (const [kind, identifier] of [
      ["PROVIDER_EVENT_ID", eventId],
      ["PROVIDER_MESSAGE_ID", messageId],
    ] as const) {
      if (identifier === null) continue;
      const key = `${kind}\0${identifier}`;
      const existing = identityBindings.get(key);
      if (existing !== undefined && existing !== binding) {
        return { ok: false, reason: "BATCH_DUPLICATE_CONFLICT" };
      }
      identityBindings.set(key, binding);
    }
  }
  return { ok: true };
}

/**
 * The server derives the required scope from the trusted route and the claimed
 * work kind. A caller can never widen its class through the JSON body.
 */
export function workKindIsAllowed(
  route: RuntimeRouteDefinition,
  requestedKinds: unknown,
): boolean {
  if (!route.workKinds) return true;
  if (requestedKinds === undefined) return true;
  if (!Array.isArray(requestedKinds) || requestedKinds.length === 0) return false;
  return requestedKinds.every(
    (kind) => typeof kind === "string" && route.workKinds!.includes(kind),
  );
}
import {
  validateRuntimeRequestBody,
  validateRuntimeResponseBody,
} from "./contracts.ts";
