/**
 * The outbox state machine.
 *
 * The single most important rule: `DISPATCHING` begins only when the
 * authorize-send CAS wins, immediately before the first possible provider
 * handoff, and it never returns to `QUEUED`. Anything unresolved after that
 * point becomes `UNKNOWN`, which is terminal for automatic processing.
 */

export type OutboxState =
  | "QUEUED"
  | "LEASED"
  | "DISPATCHING"
  | "SENT"
  | "FAILED"
  | "UNKNOWN"
  | "CANCELLED";

export type OutboxTransitionReason =
  | "CLAIM"
  | "LEASE_EXPIRED"
  | "AUTHORIZED"
  | "PRE_HANDOFF_FAILURE"
  | "PROVIDER_SUCCESS"
  | "PROVIDER_REJECT"
  | "POST_HANDOFF_TIMEOUT"
  | "CRASH_IN_DISPATCHING"
  | "SWEEPER_UNRESOLVED"
  | "CANCELLED";

export interface Transition {
  from: OutboxState;
  reason: OutboxTransitionReason;
  to: OutboxState;
}

const TRANSITIONS: readonly Transition[] = Object.freeze([
  { from: "QUEUED", reason: "CLAIM", to: "LEASED" },
  { from: "QUEUED", reason: "CANCELLED", to: "CANCELLED" },

  // An expired lease returns work to the queue, but only from LEASED: a row that
  // already reached DISPATCHING can never go back.
  { from: "LEASED", reason: "LEASE_EXPIRED", to: "QUEUED" },
  { from: "LEASED", reason: "AUTHORIZED", to: "DISPATCHING" },
  // A proven pre-handoff failure means no provider frame was emitted, so the
  // row may safely requeue.
  { from: "LEASED", reason: "PRE_HANDOFF_FAILURE", to: "QUEUED" },
  { from: "LEASED", reason: "CANCELLED", to: "CANCELLED" },

  { from: "DISPATCHING", reason: "PROVIDER_SUCCESS", to: "SENT" },
  { from: "DISPATCHING", reason: "PROVIDER_REJECT", to: "FAILED" },
  { from: "DISPATCHING", reason: "POST_HANDOFF_TIMEOUT", to: "UNKNOWN" },
  { from: "DISPATCHING", reason: "CRASH_IN_DISPATCHING", to: "UNKNOWN" },
  { from: "DISPATCHING", reason: "SWEEPER_UNRESOLVED", to: "UNKNOWN" },
]);

export function nextState(
  from: OutboxState,
  reason: OutboxTransitionReason,
): OutboxState | null {
  const match = TRANSITIONS.find(
    (transition) => transition.from === from && transition.reason === reason,
  );
  return match ? match.to : null;
}

export function isTerminal(state: OutboxState): boolean {
  return state === "SENT" || state === "FAILED" || state === "UNKNOWN" ||
    state === "CANCELLED";
}

/** UNKNOWN is never retried automatically; only an operator may reconcile it. */
export function mayRetryAutomatically(state: OutboxState): boolean {
  return state === "QUEUED" || state === "LEASED";
}

export interface MarkerFields {
  outboxId: string;
  claimGeneration: number;
  payloadSha256: string;
  fencingToken: number;
  sessionGeneration: number;
  controlVersion: number;
  takeoverVersion: number;
  markerNonce: string;
  expiresAtEpochMs: number;
}

export const MARKER_MAX_TTL_MS = 15_000;

export type MarkerFailure =
  | "MARKER_INCOMPLETE"
  | "MARKER_EXPIRED"
  | "MARKER_TTL_TOO_LONG"
  | "MARKER_BEYOND_LEASE"
  | "MARKER_PAYLOAD_MISMATCH"
  | "MARKER_STALE_VERSION"
  | "MARKER_REPLAYED";

/**
 * Revalidates the authorization marker at the last possible moment. Every field
 * must still match live state: a marker minted a moment ago against a now-stale
 * fencing token, session, control, or takeover version must not authorize a send.
 */
export function evaluateMarker({
  marker,
  nowEpochMs,
  leaseExpiresAtEpochMs,
  expectedPayloadSha256,
  currentFencingToken,
  currentSessionGeneration,
  currentControlVersion,
  currentTakeoverVersion,
  nonceAlreadyConsumed,
}: {
  marker: Partial<MarkerFields>;
  nowEpochMs: number;
  leaseExpiresAtEpochMs: number;
  expectedPayloadSha256: string;
  currentFencingToken: number;
  currentSessionGeneration: number;
  currentControlVersion: number;
  currentTakeoverVersion: number;
  nonceAlreadyConsumed: boolean;
}): { ok: boolean; failure?: MarkerFailure } {
  const required: Array<keyof MarkerFields> = [
    "outboxId",
    "claimGeneration",
    "payloadSha256",
    "fencingToken",
    "sessionGeneration",
    "controlVersion",
    "takeoverVersion",
    "markerNonce",
    "expiresAtEpochMs",
  ];
  for (const field of required) {
    if (marker[field] === undefined || marker[field] === null) {
      return { ok: false, failure: "MARKER_INCOMPLETE" };
    }
  }
  const complete = marker as MarkerFields;

  if (nonceAlreadyConsumed) return { ok: false, failure: "MARKER_REPLAYED" };
  if (complete.expiresAtEpochMs <= nowEpochMs) return { ok: false, failure: "MARKER_EXPIRED" };
  if (complete.expiresAtEpochMs - nowEpochMs > MARKER_MAX_TTL_MS) {
    return { ok: false, failure: "MARKER_TTL_TOO_LONG" };
  }
  if (complete.expiresAtEpochMs > leaseExpiresAtEpochMs) {
    return { ok: false, failure: "MARKER_BEYOND_LEASE" };
  }
  if (complete.payloadSha256 !== expectedPayloadSha256) {
    return { ok: false, failure: "MARKER_PAYLOAD_MISMATCH" };
  }
  if (
    complete.fencingToken !== currentFencingToken ||
    complete.sessionGeneration !== currentSessionGeneration ||
    complete.controlVersion !== currentControlVersion ||
    complete.takeoverVersion !== currentTakeoverVersion
  ) {
    return { ok: false, failure: "MARKER_STALE_VERSION" };
  }
  return { ok: true };
}