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
  | "NO_TARGET"
  | "NO_REASON";

export interface LegalHoldGateInput {
  canAudit: boolean;
  canManageOperations: boolean;
  targetId: string;
  reason: string;
}

/**
 * Both permissions, not either.
 *
 * A legal hold stops evidence from being deleted, which is simultaneously an
 * operational act and an audit act - the plan requires `audit` AND
 * `manage_operations`, and the two refusals are reported separately so the operator
 * knows which one to go and ask for.
 */
export function legalHoldGate(input: LegalHoldGateInput): {
  canCreate: boolean;
  blockedBy: LegalHoldBlockedBy | null;
} {
  const blockedBy: LegalHoldBlockedBy | null = !input.canAudit
    ? "PERMISSION_AUDIT"
    : !input.canManageOperations
      ? "PERMISSION_OPERATIONS"
      : input.targetId.trim() === ""
        ? "NO_TARGET"
        : input.reason.trim() === ""
          ? "NO_REASON"
          : null;
  return { canCreate: blockedBy === null, blockedBy };
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
