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
  /** Work kinds the route may claim, when the route is a work route. */
  workKinds?: readonly string[];
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

export const RUNTIME_ROUTES: readonly RuntimeRouteDefinition[] = Object.freeze([
  {
    path: "/v1/heartbeat",
    operation: "heartbeat",
    principalKind: "CHANNEL",
    facade: "openclaw_service_runtime_heartbeat_v1",
  },
  {
    path: "/v1/qr/publish",
    operation: "qr.publish",
    principalKind: "CHANNEL",
    facade: "openclaw_service_submit_qr_result_v1",
  },
  {
    path: "/v1/qr/result",
    operation: "qr.result",
    principalKind: "CHANNEL",
    facade: "openclaw_service_submit_qr_result_v1",
  },
  {
    path: "/v1/inbound/batch",
    operation: "inbound.commit",
    principalKind: "CHANNEL",
    facade: "openclaw_service_ingest_inbound_batch_v1",
  },
  {
    path: "/v1/outbox/claim",
    operation: "outbox.claim",
    principalKind: "CHANNEL",
    facade: "openclaw_service_claim_outbox_v1",
  },
  {
    path: "/v1/outbox/preflight",
    operation: "outbox.preflight",
    principalKind: "CHANNEL",
    facade: "openclaw_service_preflight_outbox_v1",
  },
  {
    path: "/v1/outbox/authorize-send",
    operation: "outbox.authorize-send",
    principalKind: "CHANNEL",
    facade: "openclaw_service_authorize_outbox_send_v1",
  },
  {
    path: "/v1/outbox/requeue",
    operation: "outbox.requeue",
    principalKind: "CHANNEL",
    facade: "openclaw_service_requeue_pre_handoff_v1",
  },
  {
    path: "/v1/outbox/complete",
    operation: "outbox.complete",
    principalKind: "CHANNEL",
    facade: "openclaw_service_complete_outbox_v1",
  },
  {
    path: "/v1/work/claim",
    operation: "work.claim",
    principalKind: "CHANNEL",
    facade: "openclaw_service_claim_work_item_v1",
    workKinds: CHANNEL_WORK_KINDS,
  },
  {
    path: "/v1/work/complete",
    operation: "work.complete",
    principalKind: "CHANNEL",
    facade: "openclaw_service_complete_work_item_v1",
    workKinds: CHANNEL_WORK_KINDS,
  },
  {
    path: "/v1/work/create-outbox",
    operation: "work.complete",
    principalKind: "CHANNEL",
    facade: "openclaw_service_create_outbox_from_work_v1",
    workKinds: CHANNEL_WORK_KINDS,
  },
  {
    path: "/v1/media/upload-ticket",
    operation: "media.issue",
    principalKind: "CHANNEL",
    facade: "openclaw_service_issue_media_ticket_v1",
  },
  {
    path: "/v1/maintenance/work/claim",
    operation: "maintenance.claim",
    principalKind: "MAINTENANCE",
    facade: "openclaw_service_claim_work_item_v1",
    workKinds: MAINTENANCE_WORK_KINDS,
  },
  {
    path: "/v1/maintenance/work/complete",
    operation: "maintenance.complete",
    principalKind: "MAINTENANCE",
    facade: "openclaw_service_complete_work_item_v1",
    workKinds: MAINTENANCE_WORK_KINDS,
  },
  {
    path: "/v1/maintenance/media/upload-ticket",
    operation: "maintenance.complete",
    principalKind: "MAINTENANCE",
    facade: "openclaw_service_issue_media_ticket_v1",
  },
  {
    path: "/v1/maintenance/media/verify-ticket",
    operation: "maintenance.complete",
    principalKind: "MAINTENANCE",
    facade: "openclaw_service_issue_media_ticket_v1",
  },
  {
    path: "/v1/maintenance/retention/delete-ticket",
    operation: "maintenance.complete",
    principalKind: "MAINTENANCE",
    facade: "openclaw_service_authorize_retention_delete_v1",
  },
  {
    path: "/v1/maintenance/retention/authorize-delete",
    operation: "maintenance.complete",
    principalKind: "MAINTENANCE",
    facade: "openclaw_service_authorize_retention_delete_v1",
  },
]);

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
  "authorization",
  "cookie",
  "privatekey",
  "signingkey",
]);

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function findSecretLikeField(value: unknown, depth = 0): string | null {
  if (depth > 12 || !isPlainObject(value)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        const found = findSecretLikeField(entry, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_FIELD_NAMES.has(normalizedKey(key))) return key;
    const found = findSecretLikeField(entry, depth + 1);
    if (found) return found;
  }
  return null;
}

export interface InboundBatchValidation {
  ok: boolean;
  reason?: string;
}

/**
 * Inbound batches carry provider evidence, so they get their own structural
 * checks before any DB call: bounded count, one organization/account, and no
 * duplicate event id that disagrees with itself.
 */
export function validateInboundBatch(body: unknown): InboundBatchValidation {
  if (!isPlainObject(body)) return { ok: false, reason: "BATCH_INVALID" };
  const events = body.events;
  if (!Array.isArray(events) || events.length === 0) {
    return { ok: false, reason: "BATCH_INVALID" };
  }
  if (events.length > OPENCLAW_MAX_INBOUND_BATCH_COUNT) {
    return { ok: false, reason: "BATCH_TOO_LARGE" };
  }

  const organizationIds = new Set<string>();
  const accountIds = new Set<string>();
  const hashByEventId = new Map<string, string>();

  for (const event of events) {
    if (!isPlainObject(event)) return { ok: false, reason: "BATCH_INVALID" };
    const organizationId = event.organizationId;
    const accountId = event.accountId;
    const eventId = event.providerEventId;
    const hash = event.payloadSha256;
    if (
      typeof organizationId !== "string" || !UUID_PATTERN.test(organizationId) ||
      typeof accountId !== "string" || !UUID_PATTERN.test(accountId) ||
      typeof eventId !== "string" || eventId.length === 0 ||
      typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)
    ) {
      return { ok: false, reason: "BATCH_INVALID" };
    }
    organizationIds.add(organizationId);
    accountIds.add(accountId);
    const existing = hashByEventId.get(eventId);
    if (existing !== undefined && existing !== hash) {
      return { ok: false, reason: "BATCH_DUPLICATE_CONFLICT" };
    }
    hashByEventId.set(eventId, hash);
  }

  if (organizationIds.size !== 1 || accountIds.size !== 1) {
    return { ok: false, reason: "BATCH_MIXED_TENANT" };
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