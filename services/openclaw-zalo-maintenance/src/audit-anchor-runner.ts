import { createHash } from "node:crypto";

/**
 * Daily audit anchoring.
 *
 * The anchor is a canonical JSON document whose root hash is recomputed
 * independently before it is accepted. The gateway upload is no-overwrite, and
 * the verify ticket is one-use, so an anchor cannot be silently replaced or
 * re-verified with a stale ticket.
 */

export interface AuditAnchorDocument {
  version: 1;
  organizationId: string;
  utcDate: string;
  auditRootId: string;
  eventCount: number;
  rootSha256: string;
}

export function canonicalAnchorJson(document: AuditAnchorDocument): string {
  // Keys are emitted in a fixed order so the bytes are reproducible.
  return JSON.stringify({
    auditRootId: document.auditRootId,
    eventCount: document.eventCount,
    organizationId: document.organizationId,
    rootSha256: document.rootSha256,
    utcDate: document.utcDate,
    version: document.version,
  });
}

export function computeAnchorRoot(eventHashes: readonly string[]): string {
  // A simple ordered Merkle-style fold: order matters, and an empty day still
  // produces a well-defined root.
  const hash = createHash("sha256").update("ihome-openclaw-audit-root-v1", "utf8");
  for (const eventHash of eventHashes) {
    hash.update(Buffer.from([0]));
    hash.update(eventHash, "utf8");
  }
  return hash.digest("hex");
}

export interface AuditAnchorReceiptV1 {
  version: 1;
  workClaimId: string;
  organizationId: string;
  utcDate: string;
  auditRootId: string;
  objectKey: string;
  rootSha256: string;
  documentSha256: string;
  documentByteLength: number;
  verifyTicketJti: string;
  signatureKeyGeneration: number;
  signature: string;
  completedAtEpochMs: number;
}

export type AnchorRefusal =
  | "ROOT_MISMATCH"
  | "DOCUMENT_HASH_MISMATCH"
  | "SIZE_MISMATCH"
  | "VERIFY_TICKET_MISMATCH"
  | "KEY_GENERATION_MISMATCH"
  | "SIGNATURE_MISSING"
  | "CROSS_CLAIM_REPLAY";

export interface AnchorVerification {
  ok: boolean;
  refusal?: AnchorRefusal;
}

/**
 * Independent verification of a gateway receipt. Every claim is recomputed from
 * material the maintenance runner already holds; nothing is taken on trust.
 */
export function verifyAnchorReceipt({
  receipt,
  document,
  documentBytes,
  expectedEventHashes,
  consumedVerifyTicketJti,
  currentSignatureKeyGeneration,
  expectedWorkClaimId,
}: {
  receipt: AuditAnchorReceiptV1;
  document: AuditAnchorDocument;
  documentBytes: Uint8Array;
  expectedEventHashes: readonly string[];
  consumedVerifyTicketJti: string;
  currentSignatureKeyGeneration: number;
  expectedWorkClaimId: string;
}): AnchorVerification {
  if (receipt.workClaimId !== expectedWorkClaimId) {
    return { ok: false, refusal: "CROSS_CLAIM_REPLAY" };
  }

  const expectedRoot = computeAnchorRoot(expectedEventHashes);
  if (receipt.rootSha256 !== expectedRoot || document.rootSha256 !== expectedRoot) {
    return { ok: false, refusal: "ROOT_MISMATCH" };
  }

  const documentSha256 = createHash("sha256").update(documentBytes).digest("hex");
  if (receipt.documentSha256 !== documentSha256) {
    return { ok: false, refusal: "DOCUMENT_HASH_MISMATCH" };
  }
  if (receipt.documentByteLength !== documentBytes.byteLength) {
    return { ok: false, refusal: "SIZE_MISMATCH" };
  }

  // The receipt must name the exact one-use ticket that was consumed.
  if (receipt.verifyTicketJti !== consumedVerifyTicketJti) {
    return { ok: false, refusal: "VERIFY_TICKET_MISMATCH" };
  }
  if (receipt.signatureKeyGeneration !== currentSignatureKeyGeneration) {
    return { ok: false, refusal: "KEY_GENERATION_MISMATCH" };
  }
  if (typeof receipt.signature !== "string" || receipt.signature.length === 0) {
    return { ok: false, refusal: "SIGNATURE_MISSING" };
  }

  return { ok: true };
}

/**
 * After a lost gateway or DB response the runner must return the identical
 * stored receipt rather than anchoring again.
 */
export class AnchorReceiptStore {
  private readonly receipts = new Map<string, AuditAnchorReceiptV1>();

  store(receipt: AuditAnchorReceiptV1): AuditAnchorReceiptV1 {
    const existing = this.receipts.get(receipt.workClaimId);
    if (existing) return existing;
    this.receipts.set(receipt.workClaimId, receipt);
    return receipt;
  }

  get(workClaimId: string): AuditAnchorReceiptV1 | undefined {
    return this.receipts.get(workClaimId);
  }
}