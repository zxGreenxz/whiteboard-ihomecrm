import { createHash } from "node:crypto";

import { canonicalJson } from "../spool/checksum.js";
import {
  parseOutboxClaim,
  parseOutboundAuthorizationMarker,
  snapshotCanonicalSendPayload,
  type OutboundAuthorizationMarker,
  type OutboxClaim,
  type PreHandoffReasonCodeV1,
} from "../runtime-api/schemas.js";

const DELIVERY_DOMAIN = "ihome-openclaw-delivery-evidence-v1\0";
const PRE_HANDOFF_DOMAIN = "ihome-openclaw-pre-handoff-evidence-v1\0";

function domainHash(domain: string, value: unknown): string {
  return createHash("sha256").update(domain, "utf8").update(canonicalJson(value), "utf8")
    .digest("hex");
}

export function deliveryEvidenceHash(value: unknown): string {
  return domainHash(DELIVERY_DOMAIN, value);
}

export function preHandoffEvidenceHash(value: unknown): string {
  return domainHash(PRE_HANDOFF_DOMAIN, value);
}

interface RuntimeApi {
  post<T = unknown>(path: string, body: unknown): Promise<T>;
}

export class OutboxCompletionReplayError extends Error {
  readonly code = "OUTBOX_COMPLETION_REPLAY_FAILED";

  constructor() {
    super("outbox completion replay failed");
    this.name = "OutboxCompletionReplayError";
  }
}

interface CellRpc {
  invoke(method: string, params: unknown): Promise<unknown>;
}

const SAFE_RETRY_PREFLIGHT_DECISIONS = [
  "GLOBAL_STOP",
  "MODE_PAUSED",
  "ACCOUNT_PAUSED",
  "TAKEOVER_ACTIVE",
  "SUPPRESSED",
  "CONSENT_MISSING",
  "POLICY_STALE",
  "QUIET_HOURS",
  "RATE_LIMITED",
  "GROUP_DIRECTORY_STALE",
  "GROUP_NOT_ALLOWLISTED",
] as const;

type SafeRetryPreflightDecision = typeof SAFE_RETRY_PREFLIGHT_DECISIONS[number];

interface AllowedPreflightResult {
  version: 1;
  outboxId: string;
  decision: "ALLOWED";
  disposition: "HANDOFF_AUTHORIZED";
  transitionApplied: false;
  canonicalPayload: OutboxClaim["payload"];
  authorizationMarker: OutboundAuthorizationMarker;
  databaseTime: string;
  retryNotBefore: null;
}

interface SafeRetryPreflightResult {
  version: 1;
  outboxId: string;
  decision: SafeRetryPreflightDecision;
  disposition: "SAFE_RETRY";
  transitionApplied: true;
  canonicalPayload: null;
  authorizationMarker: null;
  databaseTime: string;
  retryNotBefore: string;
}

interface TerminalNoSendPreflightResult {
  version: 1;
  outboxId: string;
  decision: "CAMPAIGN_CANCELLED";
  disposition: "TERMINAL_NO_SEND";
  transitionApplied: true;
  canonicalPayload: null;
  authorizationMarker: null;
  databaseTime: string;
  retryNotBefore: null;
}

type PreflightResult =
  | AllowedPreflightResult
  | SafeRetryPreflightResult
  | TerminalNoSendPreflightResult;

function parsePreflight(value: unknown, claim: OutboxClaim): PreflightResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("outbox preflight result is invalid");
  }
  const result = value as Record<string, unknown>;
  const keys = Object.keys(result).sort();
  const expected = [
    "version", "outboxId", "decision", "disposition", "transitionApplied",
    "canonicalPayload", "authorizationMarker", "databaseTime", "retryNotBefore",
  ].sort();
  if (
    keys.length !== expected.length || keys.some((key, index) => key !== expected[index]) ||
    result.version !== 1 || result.outboxId !== claim.outboxId ||
    typeof result.databaseTime !== "string" || !Number.isFinite(Date.parse(result.databaseTime))
  ) {
    throw new TypeError("outbox preflight result is invalid");
  }

  if (result.decision === "CAMPAIGN_CANCELLED") {
    if (
      result.disposition !== "TERMINAL_NO_SEND" || result.transitionApplied !== true ||
      result.canonicalPayload !== null || result.authorizationMarker !== null ||
      result.retryNotBefore !== null
    ) throw new TypeError("outbox preflight result is invalid");
    return result as unknown as TerminalNoSendPreflightResult;
  }

  if ((SAFE_RETRY_PREFLIGHT_DECISIONS as readonly unknown[]).includes(result.decision)) {
    if (
      result.disposition !== "SAFE_RETRY" || result.transitionApplied !== true ||
      result.canonicalPayload !== null || result.authorizationMarker !== null ||
      typeof result.retryNotBefore !== "string" ||
      !Number.isFinite(Date.parse(result.retryNotBefore)) ||
      Date.parse(result.retryNotBefore) < Date.parse(result.databaseTime)
    ) throw new TypeError("outbox preflight result is invalid");
    return result as unknown as SafeRetryPreflightResult;
  }

  if (
    result.decision !== "ALLOWED" || result.disposition !== "HANDOFF_AUTHORIZED" ||
    result.transitionApplied !== false || result.retryNotBefore !== null
  ) throw new TypeError("outbox preflight result is invalid");
  const payload = snapshotCanonicalSendPayload(result.canonicalPayload);
  if (canonicalJson(payload) !== canonicalJson(claim.payload)) {
    throw new TypeError("outbox preflight payload changed");
  }
  const marker = parseOutboundAuthorizationMarker(result.authorizationMarker);
  if (
    marker.outboxId !== claim.outboxId || marker.claimGeneration !== claim.claimGeneration ||
    marker.payloadHash !== claim.payloadHash ||
    Date.parse(marker.expiresAt) <= Date.parse(result.databaseTime) ||
    Date.parse(marker.expiresAt) > Date.parse(claim.leaseExpiresAt)
  ) {
    throw new TypeError("outbox preflight marker binding mismatch");
  }
  return {
    version: 1,
    outboxId: claim.outboxId,
    decision: "ALLOWED",
    disposition: "HANDOFF_AUTHORIZED",
    transitionApplied: false,
    canonicalPayload: payload,
    authorizationMarker: marker,
    databaseTime: result.databaseTime,
    retryNotBefore: null,
  };
}

function preHandoffReason(error: unknown): PreHandoffReasonCodeV1 | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { code?: unknown; authorizedHandoffRecorded?: unknown };
  if (candidate.authorizedHandoffRecorded !== false || typeof candidate.code !== "string") return null;
  const allowed: readonly PreHandoffReasonCodeV1[] = [
    "AUTHORIZATION_EXPIRED", "LEASE_EXPIRED", "CELL_FENCED", "SESSION_GENERATION_CHANGED",
    "CONTROL_VERSION_CHANGED", "TAKEOVER_VERSION_CHANGED", "POLICY_CHANGED_BEFORE_HANDOFF",
    "ADAPTER_NOT_READY", "EGRESS_BLOCKED_BEFORE_HANDOFF",
  ];
  return allowed.includes(candidate.code as PreHandoffReasonCodeV1)
    ? candidate.code as PreHandoffReasonCodeV1
    : null;
}

function parseCellOutcome(value: unknown, totalParts: number) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("private send result is invalid");
  }
  const result = value as Record<string, unknown>;
  const status = result.status;
  const reasonCode = result.reasonCode;
  const knownProviderMessageIds = result.knownProviderMessageIds;
  const prefix = result.possibleHandoffPrefixLength;
  if (
    !["SENT", "FAILED", "UNKNOWN"].includes(String(status)) ||
    !Array.isArray(knownProviderMessageIds) ||
    knownProviderMessageIds.some((entry) => typeof entry !== "string" || entry.length === 0) ||
    !Number.isSafeInteger(prefix) || Number(prefix) < 0 || Number(prefix) > totalParts ||
    knownProviderMessageIds.length > Number(prefix) ||
    result.totalPartCount !== totalParts
  ) throw new TypeError("private send result is invalid");
  if (
    (status === "SENT" && (reasonCode !== "ALL_PARTS_ACKNOWLEDGED" || prefix !== totalParts ||
      knownProviderMessageIds.length !== totalParts)) ||
    (status === "FAILED" && (reasonCode !== "PROVIDER_REJECTED_BEFORE_ACCEPT" || prefix !== 0 ||
      knownProviderMessageIds.length !== 0)) ||
    (status === "UNKNOWN" && (![
      "PROVIDER_TIMEOUT_AFTER_POSSIBLE_HANDOFF", "PROVIDER_DISCONNECT_AFTER_POSSIBLE_HANDOFF",
      "ACK_LOST_AFTER_HANDOFF",
    ].includes(String(reasonCode)) || Number(prefix) < 1))
  ) throw new TypeError("private send outcome is inconsistent");
  return {
    status: status as "SENT" | "FAILED" | "UNKNOWN",
    reasonCode: reasonCode as string,
    knownProviderMessageIds: [...knownProviderMessageIds] as string[],
    possibleHandoffPrefixLength: Number(prefix),
  };
}

async function submitUnknown(
  runtime: RuntimeApi,
  claim: OutboxClaim,
  marker: OutboundAuthorizationMarker,
  knownProviderMessageIds: string[] = [],
  possibleHandoffPrefixLength = 1,
) {
  const authorization = { version: 1 as const, claimToken: claim.claimToken, authorizationMarker: marker };
  const deliveryEvidence = {
    version: 1 as const,
    evidenceKind: "OUTBOX_DELIVERY" as const,
    outboxId: claim.outboxId,
    claimGeneration: claim.claimGeneration,
    payloadHash: claim.payloadHash,
    authorizationMarker: marker,
    totalPartCount: claim.payload.parts.length,
    knownProviderMessageIds,
    possibleHandoffPrefixLength,
    outcome: "UNKNOWN" as const,
    reasonCode: "ACK_LOST_AFTER_HANDOFF" as const,
  };
  await submitCompletion(runtime, {
    version: 1,
    authorization,
    deliveryEvidence,
    deliveryEvidenceHash: deliveryEvidenceHash(deliveryEvidence),
    outcome: "UNKNOWN",
    reasonCode: "ACK_LOST_AFTER_HANDOFF",
  });
}

/**
 * Completion is an idempotent CAS keyed by its authorization/evidence. If the
 * response is lost after commit, replay the exact same canonical body. Never
 * reinterpret a completion transport failure as a new delivery outcome.
 */
async function submitCompletion(runtime: RuntimeApi, completion: unknown): Promise<void> {
  const snapshot = JSON.parse(canonicalJson(completion)) as unknown;
  const expected = snapshot as {
    outcome: unknown;
    deliveryEvidenceHash: unknown;
    deliveryEvidence: {
      outboxId?: unknown;
      knownProviderMessageIds?: unknown;
      possibleHandoffPrefixLength?: unknown;
    };
  };
  const submit = async (): Promise<void> => {
    const value = await runtime.post("/v1/outbox/complete", snapshot);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("outbox completion result is invalid");
    }
    const result = value as Record<string, unknown>;
    const keys = Object.keys(result).sort();
    const expectedKeys = [
      "version", "outboxId", "state", "knownProviderMessageIds",
      "possibleHandoffPrefixLength", "deliveryEvidenceHash",
    ].sort();
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key, index) => key !== expectedKeys[index]) ||
      result.version !== 1 ||
      result.outboxId !== expected.deliveryEvidence.outboxId ||
      result.state !== expected.outcome ||
      result.deliveryEvidenceHash !== expected.deliveryEvidenceHash ||
      result.possibleHandoffPrefixLength !== expected.deliveryEvidence.possibleHandoffPrefixLength ||
      canonicalJson(result.knownProviderMessageIds) !==
        canonicalJson(expected.deliveryEvidence.knownProviderMessageIds)
    ) {
      throw new TypeError("outbox completion result is invalid");
    }
  };
  try {
    await submit();
  } catch {
    try {
      await submit();
    } catch {
      throw new OutboxCompletionReplayError();
    }
  }
}

export type OutboxBatchResult =
  | { outboxId: string; outcome: "SENT" | "FAILED" | "UNKNOWN" }
  | { outboxId: string; outcome: "SAFE_RETRY"; reasonCode: string; retryNotBefore: string }
  | { outboxId: string; outcome: "TERMINAL_NO_SEND"; reasonCode: "CAMPAIGN_CANCELLED" };

export async function runOutboxBatch({
  runtime,
  cellRpc,
  claimToken,
  now,
  retryNotBefore,
  limit,
}: {
  runtime: RuntimeApi;
  cellRpc: CellRpc;
  claimToken(): string;
  now(): Date;
  retryNotBefore(): string;
  limit: number;
}): Promise<OutboxBatchResult[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) throw new RangeError("limit must be 1-25");
  const claimed = await runtime.post<{ version: 1; items: unknown[] }>("/v1/outbox/claim", {
    version: 1,
    claimToken: claimToken(),
    limit,
    leaseSeconds: 30,
  });
  if (claimed?.version !== 1 || !Array.isArray(claimed.items)) {
    throw new TypeError("outbox claim response is invalid");
  }
  const unique = new Map<string, OutboxClaim>();
  for (const item of claimed.items) {
    const parsed = parseOutboxClaim(item);
    const key = `${parsed.outboxId}:${parsed.claimGeneration}`;
    if (!unique.has(key)) unique.set(key, parsed);
  }
  const results: OutboxBatchResult[] = [];
  for (const claim of unique.values()) {
    const preflightValue = await runtime.post("/v1/outbox/preflight", {
      version: 1,
      outboxId: claim.outboxId,
      claimGeneration: claim.claimGeneration,
      claimToken: claim.claimToken,
    });
    const preflight = parsePreflight(preflightValue, claim);
    if (preflight.disposition === "SAFE_RETRY") {
      results.push({
        outboxId: claim.outboxId,
        outcome: "SAFE_RETRY",
        reasonCode: preflight.decision,
        retryNotBefore: preflight.retryNotBefore,
      });
      continue;
    }
    if (preflight.disposition === "TERMINAL_NO_SEND") {
      results.push({
        outboxId: claim.outboxId,
        outcome: "TERMINAL_NO_SEND",
        reasonCode: preflight.decision,
      });
      continue;
    }
    const marker = preflight.authorizationMarker;
    const authorization = { version: 1 as const, claimToken: claim.claimToken, authorizationMarker: marker };
    let send: ReturnType<typeof parseCellOutcome>;
    try {
      const raw = await cellRpc.invoke("zalouser.bridge.send", {
        version: 1,
        payload: preflight.canonicalPayload,
        authorization,
      });
      send = parseCellOutcome(raw, claim.payload.parts.length);
    } catch (error) {
      const safeReason = preHandoffReason(error);
      if (safeReason) {
        const notBefore = retryNotBefore();
        const evidence = {
          version: 1 as const,
          evidenceKind: "OUTBOX_PRE_HANDOFF" as const,
          outboxId: claim.outboxId,
          claimGeneration: claim.claimGeneration,
          payloadHash: claim.payloadHash,
          authorizationMarker: marker,
          reasonCode: safeReason,
          authorizedHandoffRecorded: false as const,
        };
        await runtime.post("/v1/outbox/requeue", {
          version: 1,
          authorization,
          outcome: "SAFE_RETRY",
          reasonCode: safeReason,
          preHandoffEvidence: evidence,
          preHandoffEvidenceHash: preHandoffEvidenceHash(evidence),
          retryNotBefore: notBefore,
        });
        results.push({
          outboxId: claim.outboxId,
          outcome: "SAFE_RETRY",
          reasonCode: safeReason,
          retryNotBefore: notBefore,
        });
      } else {
        await submitUnknown(runtime, claim, marker);
        results.push({ outboxId: claim.outboxId, outcome: "UNKNOWN" });
      }
      if (!Number.isFinite(now().valueOf())) throw new TypeError("worker clock is invalid");
      continue;
    }

    const deliveryEvidence = {
      version: 1 as const,
      evidenceKind: "OUTBOX_DELIVERY" as const,
      outboxId: claim.outboxId,
      claimGeneration: claim.claimGeneration,
      payloadHash: claim.payloadHash,
      authorizationMarker: marker,
      totalPartCount: claim.payload.parts.length,
      knownProviderMessageIds: send.knownProviderMessageIds,
      possibleHandoffPrefixLength: send.possibleHandoffPrefixLength,
      outcome: send.status,
      reasonCode: send.reasonCode,
    };
    await submitCompletion(runtime, {
      version: 1,
      authorization,
      deliveryEvidence,
      deliveryEvidenceHash: deliveryEvidenceHash(deliveryEvidence),
      outcome: send.status,
      reasonCode: send.reasonCode,
    });
    results.push({ outboxId: claim.outboxId, outcome: send.status });
    // The injected clock is read to make each iteration's sequencing explicit.
    if (!Number.isFinite(now().valueOf())) throw new TypeError("worker clock is invalid");
  }
  return results;
}
