/**
 * Retention runner.
 *
 * Two phases with very different privileges:
 *   QUARANTINE  - control-plane only. It marks rows and never touches R2.
 *   FINAL_DELETE - requires a delete ticket plus a separate five-second
 *                  authorization proof, and always ends with one signed receipt.
 */

export type DeletePhase = "QUARANTINE" | "FINAL_DELETE";

export type RetentionOutcome = "DELETED" | "NOT_FOUND";

export interface RetentionWorkItem {
  workClaimId: string;
  organizationId: string;
  deletePhase: DeletePhase;
  objectKey: string | null;
  quarantineVersion: number;
  finalDeleteNotBeforeEpochMs: number;
}

export type RetentionRefusal =
  | "QUARANTINE_MUST_NOT_TOUCH_R2"
  | "GRACE_NOT_ELAPSED"
  | "MISSING_QUARANTINE_VERSION"
  | "AUTHORIZATION_MISSING"
  | "AUTHORIZATION_EXPIRED"
  | "AUTHORIZATION_REPLAYED"
  | "AUTHORIZATION_MISMATCH";

export const DELETE_AUTHORIZATION_MAX_TTL_MS = 5_000;

export interface DeleteAuthorization {
  version: 1;
  workClaimId: string;
  objectKey: string;
  issuedAtEpochMs: number;
  expiresAtEpochMs: number;
  nonce: string;
}

export interface RetentionDecision {
  ok: boolean;
  refusal?: RetentionRefusal;
  mayCallR2: boolean;
}

/**
 * QUARANTINE performs no gateway request at all: it only records the hold. That
 * is what makes the grace period meaningful, since the bytes still exist.
 */
export function planRetentionWork({
  item,
  authorization,
  nowEpochMs,
  authorizationNonceAlreadyUsed = false,
}: {
  item: RetentionWorkItem;
  authorization: DeleteAuthorization | null;
  nowEpochMs: number;
  authorizationNonceAlreadyUsed?: boolean;
}): RetentionDecision {
  if (item.deletePhase === "QUARANTINE") {
    if (authorization !== null) {
      return { ok: false, refusal: "QUARANTINE_MUST_NOT_TOUCH_R2", mayCallR2: false };
    }
    return { ok: true, mayCallR2: false };
  }

  if (item.quarantineVersion < 1) {
    return { ok: false, refusal: "MISSING_QUARANTINE_VERSION", mayCallR2: false };
  }
  if (nowEpochMs < item.finalDeleteNotBeforeEpochMs) {
    return { ok: false, refusal: "GRACE_NOT_ELAPSED", mayCallR2: false };
  }
  if (authorization === null) {
    return { ok: false, refusal: "AUTHORIZATION_MISSING", mayCallR2: false };
  }
  if (authorizationNonceAlreadyUsed) {
    return { ok: false, refusal: "AUTHORIZATION_REPLAYED", mayCallR2: false };
  }
  if (
    authorization.expiresAtEpochMs <= nowEpochMs ||
    authorization.expiresAtEpochMs - authorization.issuedAtEpochMs >
      DELETE_AUTHORIZATION_MAX_TTL_MS
  ) {
    return { ok: false, refusal: "AUTHORIZATION_EXPIRED", mayCallR2: false };
  }
  if (
    authorization.workClaimId !== item.workClaimId ||
    item.objectKey === null ||
    authorization.objectKey !== item.objectKey
  ) {
    return { ok: false, refusal: "AUTHORIZATION_MISMATCH", mayCallR2: false };
  }

  return { ok: true, mayCallR2: true };
}

export interface RetentionReceipt {
  version: 1;
  workClaimId: string;
  objectKey: string;
  outcome: RetentionOutcome;
  r2VersionId: string | null;
  r2ETag: string | null;
  completedAtEpochMs: number;
}

/**
 * A DELETED receipt must carry the captured R2 version and ETag; an
 * authenticated NOT_FOUND must carry neither. Any other combination is
 * impossible and is rejected rather than stored.
 */
export function validateRetentionReceipt(receipt: RetentionReceipt): boolean {
  if (receipt.version !== 1) return false;
  if (receipt.outcome === "DELETED") {
    return typeof receipt.r2VersionId === "string" && receipt.r2VersionId.length > 0 &&
      typeof receipt.r2ETag === "string" && receipt.r2ETag.length > 0;
  }
  return receipt.r2VersionId === null && receipt.r2ETag === null;
}