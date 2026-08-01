/**
 * Outbound error classification.
 *
 * The only question that matters after a send attempt fails: did any provider
 * frame possibly leave the process? If we cannot prove it did not, the outbox
 * row must become UNKNOWN rather than being retried, because a retry would risk
 * sending the same message to a customer twice.
 */

export type HandoffPhase = "PRE_HANDOFF" | "POST_HANDOFF";

export type ErrorClass =
  | "RETRYABLE_PRE_HANDOFF"
  | "PERMANENT_REJECT"
  | "AMBIGUOUS_UNKNOWN";

export interface ClassifiedError {
  errorClass: ErrorClass;
  /** True only when we can prove zero provider frames were emitted. */
  provenNoProviderFrame: boolean;
}

/**
 * Failures that happen strictly before the first provider I/O. Each of these is
 * raised by our own code paths, so "no frame was emitted" is a fact, not a
 * guess.
 */
const PRE_HANDOFF_FAILURES = new Set([
  "AUTHORIZATION_DENIED",
  "AUTHORIZATION_MISSING",
  "MARKER_EXPIRED",
  "MARKER_REPLAYED",
  "MARKER_STALE_VERSION",
  "MARKER_PAYLOAD_MISMATCH",
  "POLICY_DENIED",
  "PAYLOAD_VALIDATION_FAILED",
  "MEDIA_VERIFICATION_FAILED",
  "EDGE_UNAVAILABLE",
  "EDGE_TIMEOUT",
  "BRIDGE_UNAVAILABLE",
  "LEASE_EXPIRED_BEFORE_AUTHORIZATION",
]);

/**
 * Provider answers that definitively mean the message was not accepted and no
 * duplicate can exist.
 */
const PERMANENT_REJECTS = new Set([
  "PROVIDER_REJECTED",
  "TARGET_NOT_FOUND",
  "TARGET_BLOCKED",
  "CONTENT_REFUSED",
  "ACCOUNT_RESTRICTED",
]);

export function classifyOutboundError(input: {
  code: string;
  phase: HandoffPhase;
}): ClassifiedError {
  // Anything at all after the first possible handoff is ambiguous, including a
  // "reject": the provider may have accepted an earlier part of the batch.
  if (input.phase === "POST_HANDOFF") {
    if (PERMANENT_REJECTS.has(input.code)) {
      return { errorClass: "AMBIGUOUS_UNKNOWN", provenNoProviderFrame: false };
    }
    return { errorClass: "AMBIGUOUS_UNKNOWN", provenNoProviderFrame: false };
  }

  if (PRE_HANDOFF_FAILURES.has(input.code)) {
    return { errorClass: "RETRYABLE_PRE_HANDOFF", provenNoProviderFrame: true };
  }
  if (PERMANENT_REJECTS.has(input.code)) {
    return { errorClass: "PERMANENT_REJECT", provenNoProviderFrame: true };
  }
  // An unrecognised failure before handoff is still treated as unproven: fail
  // closed rather than assume nothing was sent.
  return { errorClass: "AMBIGUOUS_UNKNOWN", provenNoProviderFrame: false };
}

export function mayRequeue(classified: ClassifiedError): boolean {
  return classified.errorClass === "RETRYABLE_PRE_HANDOFF" &&
    classified.provenNoProviderFrame;
}

export function becomesUnknown(classified: ClassifiedError): boolean {
  return classified.errorClass === "AMBIGUOUS_UNKNOWN";
}