import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  AUDIT_GENESIS_PREVIOUS_HASH,
  auditEventHash,
  verifyAuditChain,
  type AuditChainEvent,
} from "../auditChain";

const AUDIT_SQL = readFileSync(
  "supabase/migrations/20260727040000_openclaw_delivery_audit_ops.sql",
  "utf8",
);
const RPC_SQL = readFileSync(
  "supabase/migrations/20260727060000_openclaw_rpc_surface.sql",
  "utf8",
);

/**
 * Golden vectors produced by running the server's own digest expression against
 * the live database. They pin this implementation to the real formula rather than
 * to a second reading of the SQL - a reading that could be wrong in exactly the way
 * the implementation is wrong.
 */
const GOLDEN = [
  {
    previousHash: AUDIT_GENESIS_PREVIOUS_HASH,
    organizationSequence: 1,
    eventType: "OPENCLAW_LEGAL_HOLD_CREATED",
    evidenceHash: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    expected: "926f58734d3580416880c736d80550fa7541312db2b619c436be244d4bc28d1f",
  },
  {
    previousHash: "11111111111111111111111111111111111111111111111111111111111111ff",
    organizationSequence: 42,
    eventType: "OPENCLAW_GLOBAL_STOP_SET",
    evidenceHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    expected: "f491de458715ea34a8fca7a089273d5ff74002fe7c1a9a311ae60ec85eec2561",
  },
] as const;

/** Builds a chain whose hashes are genuine, so only deliberate damage shows up. */
async function buildChain(
  specs: readonly { sequence: number; eventType: string; evidenceHash: string }[],
): Promise<AuditChainEvent[]> {
  const events: AuditChainEvent[] = [];
  let previousHash = AUDIT_GENESIS_PREVIOUS_HASH;
  for (const spec of specs) {
    const event = {
      auditEventId: `ev-${spec.sequence}`,
      organizationSequence: spec.sequence,
      eventType: spec.eventType,
      evidenceHash: spec.evidenceHash,
      previousHash,
      eventHash: await auditEventHash({
        organizationSequence: spec.sequence,
        eventType: spec.eventType,
        evidenceHash: spec.evidenceHash,
        previousHash,
      }),
    };
    events.push(event);
    previousHash = event.eventHash;
  }
  return events;
}

const SPECS = [
  { sequence: 1, eventType: "OPENCLAW_LEGAL_HOLD_CREATED", evidenceHash: "a".repeat(64) },
  { sequence: 2, eventType: "OPENCLAW_GLOBAL_STOP_SET", evidenceHash: "b".repeat(64) },
  { sequence: 3, eventType: "OPENCLAW_UNKNOWN_RESOLVED", evidenceHash: "c".repeat(64) },
];

describe("audit event hash", () => {
  it("reproduces the digest the server computes", async () => {
    for (const vector of GOLDEN) {
      expect(await auditEventHash(vector), vector.eventType).toBe(vector.expected);
    }
  });

  it("hashes the four fields the read path actually returns", () => {
    // If the server ever hashed something the browser cannot read, this whole
    // verification would become impossible rather than merely wrong - so the two
    // sides are checked against each other here.
    const append = /create or replace function app_private\.append_openclaw_audit_v1[\s\S]*?\n\$function\$;/u
      .exec(AUDIT_SQL);
    expect(append, "append_openclaw_audit_v1 not found").not.toBeNull();
    const digest = /v_event_hash := encode\(extensions\.digest\(([\s\S]*?)'sha256'/u.exec(append![0]);
    expect(digest, "event hash expression not found").not.toBeNull();
    const inputs = [...digest![1].matchAll(/convert_to\((\w+|p_\w+)/gu)].map(match => match[1]);
    expect(inputs).toEqual(["v_previous_hash", "v_sequence", "p_event_type", "v_evidence_hash"]);

    const list = /create or replace function public\.openclaw_list_audit_events_v1[\s\S]*?\n\$function\$;/u
      .exec(RPC_SQL);
    expect(list, "list RPC not found").not.toBeNull();
    for (const field of ["previousHash", "organizationSequence", "eventType", "evidenceHash"]) {
      expect(list![0], field).toContain(`'${field}'`);
    }
  });

  it("separates the fields, so a shifted boundary changes the hash", async () => {
    // The NUL separators are what stop "AB"+"C" and "A"+"BC" hashing alike. Without
    // them a crafted event type could absorb part of a hash and still verify.
    const left = await auditEventHash({
      previousHash: AUDIT_GENESIS_PREVIOUS_HASH,
      organizationSequence: 12,
      eventType: "AB",
      evidenceHash: "c".repeat(64),
    });
    const right = await auditEventHash({
      previousHash: AUDIT_GENESIS_PREVIOUS_HASH,
      organizationSequence: 1,
      eventType: "2AB",
      evidenceHash: "c".repeat(64),
    });
    expect(left).not.toBe(right);
  });
});

describe("audit chain verification", () => {
  it("accepts a chain the server would have written", async () => {
    const verdict = await verifyAuditChain(await buildChain(SPECS));
    expect(verdict.intact).toBe(true);
    expect(verdict.findings).toEqual([]);
    expect(verdict.checkedCount).toBe(3);
    expect(verdict.linkedCount).toBe(2);
    expect(verdict.fromSequence).toBe(1);
    expect(verdict.toSequence).toBe(3);
  });

  it("catches an event edited after it was written", async () => {
    // Editing the row changes what it says without changing its stored hash, which
    // is precisely what recomputation catches and linkage alone would not.
    const chain = await buildChain(SPECS);
    const tampered = chain.map((event, index) =>
      index === 1 ? { ...event, eventType: "OPENCLAW_NOTHING_HAPPENED" } : event);
    const verdict = await verifyAuditChain(tampered);
    expect(verdict.intact).toBe(false);
    expect(verdict.findings).toContainEqual({
      kind: "HASH_MISMATCH", auditEventId: "ev-2", organizationSequence: 2,
    });
  });

  it("catches a link that points at the wrong predecessor", async () => {
    const chain = await buildChain(SPECS);
    const broken = chain.map((event, index) =>
      index === 2 ? { ...event, previousHash: "d".repeat(64) } : event);
    const verdict = await verifyAuditChain(broken);
    expect(verdict.findings.some(finding => finding.kind === "LINK_BROKEN")).toBe(true);
  });

  it("reports a missing event as a gap, not as a broken link", async () => {
    // A window with an event missing and a window with a forged link look the same
    // to a naive check, and they call for different responses.
    const chain = await buildChain(SPECS);
    const verdict = await verifyAuditChain([chain[0], chain[2]]);
    expect(verdict.findings).toContainEqual({
      kind: "SEQUENCE_GAP", fromSequence: 1, toSequence: 3,
    });
    expect(verdict.findings.some(finding => finding.kind === "LINK_BROKEN")).toBe(false);
    // Nothing was linked, and the verdict must not imply otherwise.
    expect(verdict.linkedCount).toBe(0);
  });

  it("checks the genesis previousHash only for sequence 1", async () => {
    const chain = await buildChain(SPECS);
    // A window that does not include the first event cannot check the genesis, and
    // must not invent a failure for it.
    const window = await verifyAuditChain([chain[1], chain[2]]);
    expect(window.intact).toBe(true);

    const forgedGenesis = [{ ...chain[0], previousHash: "e".repeat(64) }];
    const verdict = await verifyAuditChain(forgedGenesis);
    expect(verdict.intact).toBe(false);
  });

  it("says nothing was checked when nothing was read", async () => {
    const verdict = await verifyAuditChain([]);
    expect(verdict.checkedCount).toBe(0);
    expect(verdict.fromSequence).toBeNull();
    // `intact: true` on an empty page would read as "the audit log is fine".
    expect(verdict.linkedCount).toBe(0);
  });
});
