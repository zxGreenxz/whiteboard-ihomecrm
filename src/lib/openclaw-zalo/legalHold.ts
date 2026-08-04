/**
 * Legal-hold target kinds, exactly as the request schema enumerates them.
 *
 * Ordered with ORGANIZATION first because it is the widest and the one most likely
 * to be picked by accident; everything else is alphabetical so the list is
 * scannable rather than arbitrary.
 */
export const LEGAL_HOLD_TARGET_KINDS = [
  "ORGANIZATION",
  "AI_DRAFT", "AUDIT", "CONSENT", "CONTROL", "CONVERSATION", "DELIVERY", "HEALTH",
  "KNOWLEDGE", "MEDIA", "MESSAGE", "POLICY", "QR", "RISK", "SECURITY", "UNKNOWN",
] as const;

export type LegalHoldTargetKind = (typeof LEGAL_HOLD_TARGET_KINDS)[number];

export type LegalHoldBlockedBy =
  | "PERMISSION_AUDIT"
  | "PERMISSION_OPERATIONS"
  | "NOT_OWNER"
  | "NO_TARGET"
  | "BAD_TARGET"
  | "NO_REASON";

/**
 * The target is a UUID, and the request schema enforces that BEFORE the RPC runs.
 *
 * Without this check the field accepts any text, the button enables, and the write
 * dies inside the client on a ZodError - which carries no SQLSTATE, so the failure
 * classifier reads it as "unknown, try again later". Retrying a mistyped id fails
 * identically every time, so that advice sends an operator round a loop.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface LegalHoldGateInput {
  canAudit: boolean;
  canManageOperations: boolean;
  /** ACTIVE OWNER membership, read from the bootstrap. */
  isActiveOwner: boolean;
  targetId: string;
  reason: string;
}

/**
 * Both permissions AND an active owner membership - not any one of the three.
 *
 * A legal hold stops evidence from being deleted, which is simultaneously an
 * operational act and an audit act, so `openclaw_create_legal_hold_v1` demands
 * `audit` and `manage_operations`; on top of that it checks
 * organization_memberships for status='ACTIVE' and member_type='OWNER' and raises
 * 42501 without one. All three refusals are reported separately, because they send
 * the operator to three different people to ask.
 */
export function legalHoldGate(input: LegalHoldGateInput): {
  canCreate: boolean;
  blockedBy: LegalHoldBlockedBy | null;
} {
  const blockedBy: LegalHoldBlockedBy | null = !input.canAudit
    ? "PERMISSION_AUDIT"
    : !input.canManageOperations
      ? "PERMISSION_OPERATIONS"
      : !input.isActiveOwner
        ? "NOT_OWNER"
        : input.targetId.trim() === ""
          ? "NO_TARGET"
          : !UUID.test(input.targetId.trim())
            ? "BAD_TARGET"
            : input.reason.trim() === ""
              ? "NO_REASON"
              : null;
  return { canCreate: blockedBy === null, blockedBy };
}

export type LegalHoldReleaseBlockedBy =
  | "PERMISSION_AUDIT"
  | "PERMISSION_OPERATIONS"
  | "NOT_OWNER"
  | "ALREADY_RELEASED"
  | "NO_REASON";

/**
 * Releasing has the same three-way authorisation as creating.
 *
 * The server also refuses a release of an already-released hold with 40001, so a
 * hold that carries `releasedAt` is blocked here rather than offered and refused.
 */
export function legalHoldReleaseGate(input: {
  canAudit: boolean;
  canManageOperations: boolean;
  isActiveOwner: boolean;
  releasedAt: string | null;
  releaseReason: string;
}): { canRelease: boolean; blockedBy: LegalHoldReleaseBlockedBy | null } {
  const blockedBy: LegalHoldReleaseBlockedBy | null = !input.canAudit
    ? "PERMISSION_AUDIT"
    : !input.canManageOperations
      ? "PERMISSION_OPERATIONS"
      : !input.isActiveOwner
        ? "NOT_OWNER"
        : input.releasedAt !== null
          ? "ALREADY_RELEASED"
          : input.releaseReason.trim() === ""
            ? "NO_REASON"
            : null;
  return { canRelease: blockedBy === null, blockedBy };
}

/**
 * What a legal-hold write failed with, from what the server actually raises.
 *
 * 23505 is the one an operator can act on directly: a hold already covers this
 * target, so there is nothing to create and nothing is wrong. Reporting it as a
 * generic failure would send someone looking for a problem that does not exist.
 */
export type LegalHoldFailure =
  | "ALREADY_HELD"
  | "PERMISSION_DENIED"
  | "VERSION_CONFLICT"
  | "NOT_FOUND"
  | "UNKNOWN";

export function classifyLegalHoldFailure(error: unknown): LegalHoldFailure {
  if (error === null || typeof error !== "object") return "UNKNOWN";
  const code = (error as { code?: unknown }).code;
  if (code === "23505") return "ALREADY_HELD";
  if (code === "42501") return "PERMISSION_DENIED";
  if (code === "40001") return "VERSION_CONFLICT";
  // `select ... into strict` raises no_data_found when the hold id is unknown.
  if (code === "P0002") return "NOT_FOUND";
  return "UNKNOWN";
}

/**
 * What a dead-letter replay produced.
 *
 * The RPC returns one of TWO shapes, and they mean different things: a
 * `sendWorkItemId` is a maintenance work item queued for the runtime, while a
 * `newOutboxId` is a fresh outbound message. Presenting both as "replayed" would
 * lose the distinction between "the system will retry" and "a new message now
 * exists addressed to a customer".
 */
export type ReplayOutcome =
  | { kind: "WORK_ITEM"; workItemId: string }
  | { kind: "NEW_OUTBOX"; outboxId: string };

export function classifyReplayResult(result: unknown): ReplayOutcome | null {
  if (result === null || typeof result !== "object") return null;
  const record = result as Record<string, unknown>;
  if (typeof record.sendWorkItemId === "string") {
    return { kind: "WORK_ITEM", workItemId: record.sendWorkItemId };
  }
  if (typeof record.newOutboxId === "string") {
    return { kind: "NEW_OUTBOX", outboxId: record.newOutboxId };
  }
  return null;
}
