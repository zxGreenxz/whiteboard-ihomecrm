import type { OpenClawUnknownResolutionOutcome } from "./types";

/**
 * The exact phrase an operator must type to stop every send in the organization.
 *
 * Unaccented on purpose: the operator may be on a keyboard without Vietnamese input,
 * and a confirmation nobody can type is a confirmation that gets worked around. The
 * comparison is exact - no trimming of interior spaces, no case folding - because
 * the point of the phrase is deliberateness, not convenience.
 */
export const GLOBAL_STOP_CONFIRMATION = "DUNG TOAN BO GUI CUA CONG TY";

/**
 * Whether the typed text authorises the stop.
 *
 * Leading and trailing whitespace is forgiven because it comes from paste and from
 * mobile keyboards, and forgiving it changes nothing about intent. Anything else -
 * different case, missing word, extra word - does not.
 */
export function globalStopConfirmationMatches(typed: string) {
  return typed.trim() === GLOBAL_STOP_CONFIRMATION;
}

export type GlobalStopBlockedBy = "PERMISSION" | "CONFIRMATION" | "ALREADY_STOPPED";

export interface GlobalStopGateInput {
  canManageOperations: boolean;
  typedConfirmation: string;
  alreadyStopped: boolean;
}

export function globalStopGate(input: GlobalStopGateInput): {
  canStop: boolean;
  blockedBy: GlobalStopBlockedBy | null;
} {
  const blockedBy: GlobalStopBlockedBy | null = !input.canManageOperations
    ? "PERMISSION"
    : input.alreadyStopped
      ? "ALREADY_STOPPED"
      : globalStopConfirmationMatches(input.typedConfirmation)
        ? null
        : "CONFIRMATION";
  return { canStop: blockedBy === null, blockedBy };
}

/**
 * The three outcomes an UNKNOWN may be resolved to, and what each one asserts.
 *
 * `fabricatesProviderSuccess` is false for every one of them, and the test pins that:
 * the operator is recording what they OBSERVED, not instructing the system to claim
 * a delivery. CONFIRMED_SENT means "I checked the phone and the customer has it",
 * not "mark it sent".
 */
export const UNKNOWN_OUTCOMES = [
  {
    outcome: "CONFIRMED_SENT",
    reasonCode: "OPERATOR_CONFIRMED_SENT",
    label: "Đã xác nhận khách nhận được",
    detail: "Bạn đã tự kiểm tra trên điện thoại và thấy tin đã tới khách.",
    createsNewSend: false,
  },
  {
    outcome: "CONFIRMED_FAILED",
    reasonCode: "OPERATOR_CONFIRMED_FAILED",
    label: "Đã xác nhận không tới khách",
    detail: "Bạn đã tự kiểm tra và thấy tin KHÔNG tới khách. Việc này không tự gửi lại.",
    createsNewSend: false,
  },
  {
    outcome: "NEW_INTENT_CREATED",
    reasonCode: "OPERATOR_CREATED_NEW_INTENT",
    label: "Tạo lần gửi mới",
    detail: "Dùng khi đã xác nhận tin cũ không tới. Sẽ tạo một lần gửi mới, có kiểm chính sách lại.",
    createsNewSend: true,
  },
] as const satisfies readonly {
  outcome: OpenClawUnknownResolutionOutcome;
  reasonCode: string;
  label: string;
  detail: string;
  createsNewSend: boolean;
}[];

/**
 * An UNKNOWN keeps its historical badge forever; resolving it adds a SECOND badge.
 *
 * The row is evidence of what the system observed at the time, and a resolution is
 * evidence of what an operator later established. Replacing the first with the
 * second would erase the fact that the outcome was ever in doubt - which is exactly
 * the fact an audit needs.
 */
export function unknownBadges(input: {
  resolutionOutcome: OpenClawUnknownResolutionOutcome | null;
}): readonly string[] {
  const badges = ["UNKNOWN"];
  if (input.resolutionOutcome !== null) badges.push(input.resolutionOutcome);
  return badges;
}

export type ResolutionFailure =
  | "ALREADY_RESOLVED"
  | "PERMISSION_DENIED"
  | "STALE_EVIDENCE"
  | "NEW_SEND_FAILED"
  | "MALFORMED_REQUEST"
  | "UNKNOWN";

/**
 * What a failed resolution means, derived from what the server actually raises.
 *
 * `openclaw_resolve_unknown_v1` throws 40001 for three different situations and
 * 22023 for two, so the SQLSTATE alone cannot say what happened - the message has
 * to be read as well:
 *
 *   40001 concurrent winner / lost CAS  -> somebody else resolved it first
 *   40001 authority evidence mismatch   -> the evidence we sent is stale
 *   40001 intent was not created        -> the resolution stands, the new send failed
 *   22023 outcome/reason mismatch       -> our own request was malformed
 *   22023 newIntent must be null ...    -> our own request was malformed
 *
 * These are not interchangeable to an operator. "Someone else already handled it"
 * means reload and read their outcome; "the request was malformed" is our bug and
 * retrying it will fail identically.
 */
export function classifyResolutionFailure(error: unknown): ResolutionFailure {
  if (error === null || typeof error !== "object") return "UNKNOWN";
  const code = (error as { code?: unknown }).code;
  const message = String((error as { message?: unknown }).message ?? "");

  if (code === "42501") return "PERMISSION_DENIED";
  if (code === "22023") return "MALFORMED_REQUEST";
  if (code === "40001") {
    if (/concurrent winner|lost CAS/u.test(message)) return "ALREADY_RESOLVED";
    if (/evidence mismatch/u.test(message)) return "STALE_EVIDENCE";
    if (/intent was not created/u.test(message)) return "NEW_SEND_FAILED";
    // A 40001 the server can raise but this list does not name yet. Saying
    // "already resolved" here would send the operator to look for a winner that
    // does not exist.
    return "UNKNOWN";
  }
  return "UNKNOWN";
}

/**
 * The authority evidence an operator must echo back to resolve an UNKNOWN.
 *
 * Both fields come from `openclaw_get_unknown_resolution_v1` and are echoed
 * verbatim: the server recomputes the hash and refuses anything that differs, so
 * constructing either value on the client would only produce a 40001. The domain
 * carries a literal trailing "\0" that the server compares exactly - one more
 * reason to pass it through untouched rather than rebuild it.
 */
export interface UnknownAuthorityEvidence {
  authoritativeEvidenceDomain: string;
  authoritativeEvidenceHash: string;
  resolutionVersion: number;
}

export interface UnknownNewIntentInput {
  clientOperationId: string;
  targetId: string;
  sourceDraftId: string;
  expectedDraftVersion: number;
  replyToMessageId: string | null;
}

export interface UnknownResolutionRequestInput {
  organizationId: string;
  outboxId: string;
  outcome: OpenClawUnknownResolutionOutcome;
  authority: UnknownAuthorityEvidence;
  /** 64 lowercase hex characters; the server stores it and checks only the shape. */
  operatorEvidenceHash: string;
  newIntent: UnknownNewIntentInput | null;
}

/**
 * Builds the request body `openclaw_resolve_unknown_v1` accepts.
 *
 * The server validates the object strictly - an unexpected key or a missing one is
 * refused before anything else runs - so this returns exactly the ten documented
 * keys and derives `reasonCode` from the outcome rather than letting a caller pair
 * them, because a mismatched pair is a 22023 the operator cannot act on.
 */
export function buildUnknownResolutionRequest(
  input: UnknownResolutionRequestInput,
): Record<string, unknown> {
  const outcome = UNKNOWN_OUTCOMES.find(entry => entry.outcome === input.outcome);
  if (outcome === undefined) throw new Error(`unknown resolution outcome: ${input.outcome}`);
  if (!/^[0-9a-f]{64}$/u.test(input.operatorEvidenceHash)) {
    throw new Error("operatorEvidenceHash must be 64 lowercase hex characters");
  }
  if (outcome.createsNewSend !== (input.newIntent !== null)) {
    throw new Error(
      outcome.createsNewSend
        ? "NEW_INTENT_CREATED requires newIntent"
        : `${input.outcome} must not carry newIntent`,
    );
  }

  return {
    version: 1,
    organizationId: input.organizationId,
    outboxId: input.outboxId,
    expectedResolutionVersion: input.authority.resolutionVersion,
    expectedEvidenceDomain: input.authority.authoritativeEvidenceDomain,
    expectedEvidenceHash: input.authority.authoritativeEvidenceHash,
    outcome: input.outcome,
    reasonCode: outcome.reasonCode,
    operatorEvidenceHash: input.operatorEvidenceHash,
    newIntent: input.newIntent === null ? null : {
      clientOperationId: input.newIntent.clientOperationId,
      targetId: input.newIntent.targetId,
      sourceDraftId: input.newIntent.sourceDraftId,
      expectedDraftVersion: input.newIntent.expectedDraftVersion,
      replyToMessageId: input.newIntent.replyToMessageId,
    },
  };
}

/**
 * Hashes what the operator says they observed.
 *
 * The server only checks that this is 64 hex characters - it never recomputes it -
 * so the value is worth nothing unless the client derives it from the actual
 * observation. Hashing a canonical statement means two operators who checked the
 * same thing produce the same hash, and the audit row can be matched back to a
 * statement rather than to an arbitrary number.
 */
export async function operatorEvidenceHash(input: {
  outboxId: string;
  outcome: OpenClawUnknownResolutionOutcome;
  observedAt: string;
  observation: string;
}): Promise<string> {
  const statement = [
    "ihome-openclaw-operator-observation-v1",
    input.outboxId,
    input.outcome,
    input.observedAt,
    input.observation.trim(),
  ].join("\n");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(statement));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
