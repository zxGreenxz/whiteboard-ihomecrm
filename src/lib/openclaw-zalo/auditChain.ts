/**
 * Verification of the audit hash chain, from the browser.
 *
 * `app_private.append_openclaw_audit_v1` computes each event hash as
 *
 *   sha256(previousHash ‖ 0x00 ‖ sequence ‖ 0x00 ‖ eventType ‖ 0x00 ‖ evidenceHash)
 *
 * and `openclaw_list_audit_events_v1` returns every one of those four inputs
 * alongside the stored hash. So the chain is not merely inspectable here - it is
 * recomputable, and a tampered row shows up as a hash that does not match its own
 * contents rather than as a link that happens to disagree.
 */

/** The `previous_hash` the server writes for the very first event of an org. */
export const AUDIT_GENESIS_PREVIOUS_HASH = "0".repeat(64);

/**
 * What recomputing the chain does NOT establish.
 *
 * `evidenceHash` is a digest of `redacted_evidence_bytes`, which no read path
 * returns. A server that fabricated an event AND its evidence hash would produce a
 * chain that verifies perfectly here. Saying "audit verified" without this caveat
 * would overstate what the browser can see, so the UI is required to carry it.
 */
export const AUDIT_CHAIN_LIMITATION =
  "Phép kiểm này tính lại hash từ chính bốn trường server trả về, nên bắt được sửa đổi "
  + "sau khi ghi. Nó KHÔNG chứng minh được nội dung bằng chứng khớp với evidenceHash — "
  + "trình duyệt không đọc được phần nội dung đó.";

export interface AuditChainEvent {
  auditEventId: string;
  organizationSequence: number;
  eventType: string;
  evidenceHash: string;
  previousHash: string;
  eventHash: string;
}

export type AuditChainFinding =
  | { kind: "HASH_MISMATCH"; auditEventId: string; organizationSequence: number }
  | { kind: "LINK_BROKEN"; auditEventId: string; organizationSequence: number }
  | { kind: "SEQUENCE_GAP"; fromSequence: number; toSequence: number };

export interface AuditChainVerdict {
  /** How many events were recomputed. */
  checkedCount: number;
  /** How many adjacent pairs had their linkage checked. */
  linkedCount: number;
  fromSequence: number | null;
  toSequence: number | null;
  findings: readonly AuditChainFinding[];
  intact: boolean;
}

const NUL = new Uint8Array([0]);

function concat(parts: readonly Uint8Array[]) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * The event hash the server would have written for this event's own contents.
 *
 * Byte-for-byte the expression in append_openclaw_audit_v1: three NUL separators,
 * no trailing one, and the sequence rendered as text exactly as `::text` does.
 */
export async function auditEventHash(event: {
  organizationSequence: number;
  eventType: string;
  evidenceHash: string;
  previousHash: string;
}): Promise<string> {
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", concat([
    encoder.encode(event.previousHash), NUL,
    encoder.encode(String(event.organizationSequence)), NUL,
    encoder.encode(event.eventType), NUL,
    encoder.encode(event.evidenceHash),
  ]));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Recomputes and links a page of audit events.
 *
 * The list RPC returns a window, not the whole chain, so linkage is only asserted
 * between events actually present. A gap in `organizationSequence` is reported
 * rather than silently bridged: two events that do not link are indistinguishable
 * from two events with a third missing between them, and the operator needs to know
 * which question they are looking at.
 */
export async function verifyAuditChain(
  events: readonly AuditChainEvent[],
): Promise<AuditChainVerdict> {
  const ordered = [...events].sort(
    (left, right) => left.organizationSequence - right.organizationSequence,
  );
  const findings: AuditChainFinding[] = [];

  for (const event of ordered) {
    if (await auditEventHash(event) !== event.eventHash) {
      findings.push({
        kind: "HASH_MISMATCH",
        auditEventId: event.auditEventId,
        organizationSequence: event.organizationSequence,
      });
    }
  }

  let linkedCount = 0;
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (current.organizationSequence !== previous.organizationSequence + 1) {
      findings.push({
        kind: "SEQUENCE_GAP",
        fromSequence: previous.organizationSequence,
        toSequence: current.organizationSequence,
      });
      continue;
    }
    linkedCount += 1;
    if (current.previousHash !== previous.eventHash) {
      findings.push({
        kind: "LINK_BROKEN",
        auditEventId: current.auditEventId,
        organizationSequence: current.organizationSequence,
      });
    }
  }

  // Sequence 1 is the only event whose previousHash the server fixes, so it is the
  // only one that can be checked without a predecessor in the window.
  const genesis = ordered.find(event => event.organizationSequence === 1);
  if (genesis !== undefined && genesis.previousHash !== AUDIT_GENESIS_PREVIOUS_HASH) {
    findings.push({
      kind: "LINK_BROKEN",
      auditEventId: genesis.auditEventId,
      organizationSequence: genesis.organizationSequence,
    });
  }

  return {
    checkedCount: ordered.length,
    linkedCount,
    fromSequence: ordered.at(0)?.organizationSequence ?? null,
    toSequence: ordered.at(-1)?.organizationSequence ?? null,
    findings,
    intact: findings.length === 0,
  };
}
