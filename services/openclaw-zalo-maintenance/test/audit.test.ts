import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  AnchorReceiptStore,
  canonicalAnchorJson,
  computeAnchorRoot,
  verifyAnchorReceipt,
  type AuditAnchorDocument,
  type AuditAnchorReceiptV1,
} from "../src/audit-anchor-runner.js";

const NOW = 1_785_062_400_000;
const ORGANIZATION_ID = "dddd0000-0000-4000-8000-000000000001";
const AUDIT_ROOT_ID = "dddd7000-0000-4000-8000-000000000001";
const WORK_CLAIM_ID = "dddd8000-0000-4000-8000-000000000001";
const VERIFY_TICKET_JTI = "dddd9000-0000-4000-8000-000000000001";

const eventHashes = ["a".repeat(64), "b".repeat(64), "c".repeat(64)];

function document(): AuditAnchorDocument {
  return {
    version: 1,
    organizationId: ORGANIZATION_ID,
    utcDate: "2026-08-01",
    auditRootId: AUDIT_ROOT_ID,
    eventCount: eventHashes.length,
    rootSha256: computeAnchorRoot(eventHashes),
  };
}

function bytesOf(doc: AuditAnchorDocument): Uint8Array {
  return new TextEncoder().encode(canonicalAnchorJson(doc));
}

function receipt(overrides: Partial<AuditAnchorReceiptV1> = {}): AuditAnchorReceiptV1 {
  const doc = document();
  const bytes = bytesOf(doc);
  return {
    version: 1,
    workClaimId: WORK_CLAIM_ID,
    organizationId: ORGANIZATION_ID,
    utcDate: "2026-08-01",
    auditRootId: AUDIT_ROOT_ID,
    objectKey: `v1/org/${ORGANIZATION_ID}/audit/2026-08-01/${AUDIT_ROOT_ID}.json`,
    rootSha256: doc.rootSha256,
    documentSha256: createHash("sha256").update(bytes).digest("hex"),
    documentByteLength: bytes.byteLength,
    verifyTicketJti: VERIFY_TICKET_JTI,
    signatureKeyGeneration: 3,
    signature: "s".repeat(86),
    completedAtEpochMs: NOW,
    ...overrides,
  };
}

function verify(overrides: Record<string, unknown> = {}) {
  const doc = document();
  return verifyAnchorReceipt({
    receipt: receipt(),
    document: doc,
    documentBytes: bytesOf(doc),
    expectedEventHashes: eventHashes,
    consumedVerifyTicketJti: VERIFY_TICKET_JTI,
    currentSignatureKeyGeneration: 3,
    expectedWorkClaimId: WORK_CLAIM_ID,
    ...overrides,
  } as Parameters<typeof verifyAnchorReceipt>[0]);
}

describe("Canonical audit root", () => {
  it("is order dependent and reproducible", () => {
    expect(computeAnchorRoot(eventHashes)).toBe(computeAnchorRoot([...eventHashes]));
    expect(computeAnchorRoot(eventHashes)).not.toBe(
      computeAnchorRoot([...eventHashes].reverse()),
    );
  });

  it("is defined for an empty day", () => {
    expect(computeAnchorRoot([])).toMatch(/^[0-9a-f]{64}$/);
  });

  it("emits canonical document bytes in a fixed key order", () => {
    expect(canonicalAnchorJson(document())).toBe(canonicalAnchorJson({ ...document() }));
    expect(canonicalAnchorJson(document()).indexOf("auditRootId")).toBeLessThan(
      canonicalAnchorJson(document()).indexOf("version"),
    );
  });
});

describe("Independent anchor receipt verification", () => {
  it("accepts a fully consistent receipt", () => {
    expect(verify()).toEqual({ ok: true });
  });

  it("rejects a root that does not match the recomputed events", () => {
    expect(verify({ expectedEventHashes: ["d".repeat(64)] }).refusal).toBe("ROOT_MISMATCH");
  });

  it("rejects a document hash or size that disagrees", () => {
    expect(verify({ receipt: receipt({ documentSha256: "f".repeat(64) }) }).refusal)
      .toBe("DOCUMENT_HASH_MISMATCH");
    expect(verify({ receipt: receipt({ documentByteLength: 1 }) }).refusal)
      .toBe("SIZE_MISMATCH");
  });

  it("requires the receipt to name the exact consumed one-use verify ticket", () => {
    expect(
      verify({ consumedVerifyTicketJti: "dddd9000-0000-4000-8000-000000000002" }).refusal,
    ).toBe("VERIFY_TICKET_MISMATCH");
  });

  it("rejects a stale signature key generation", () => {
    expect(verify({ currentSignatureKeyGeneration: 4 }).refusal)
      .toBe("KEY_GENERATION_MISMATCH");
  });

  it("rejects a forged receipt with no signature", () => {
    expect(verify({ receipt: receipt({ signature: "" }) }).refusal).toBe("SIGNATURE_MISSING");
  });

  it("rejects a receipt replayed from another work claim", () => {
    expect(
      verify({ expectedWorkClaimId: "dddd8000-0000-4000-8000-000000000002" }).refusal,
    ).toBe("CROSS_CLAIM_REPLAY");
  });
});

describe("Lost-response recovery", () => {
  it("returns the identical stored receipt after a lost gateway or DB response", () => {
    const store = new AnchorReceiptStore();
    const first = store.store(receipt());

    const retry = store.store(receipt({ signature: "z".repeat(86), completedAtEpochMs: NOW + 1 }));

    expect(retry).toEqual(first);
    expect(retry.signature).toBe("s".repeat(86));
    expect(store.get(WORK_CLAIM_ID)).toEqual(first);
  });

  it("keeps receipts isolated per work claim", () => {
    const store = new AnchorReceiptStore();
    store.store(receipt());
    expect(store.get("dddd8000-0000-4000-8000-000000000002")).toBeUndefined();
  });
});