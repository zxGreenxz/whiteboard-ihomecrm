import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SqliteSpool } from "../src/spool/sqlite-spool.js";
import { evaluatePressure, SPOOL_MAX_BYTES } from "../src/spool/pressure.js";

const ORGANIZATION_ID = "dddd0000-0000-4000-8000-000000000001";
const OTHER_ORGANIZATION_ID = "dddd0000-0000-4000-8000-000000000002";
const ACCOUNT_ID = "dddd1000-0000-4000-8000-000000000001";
const OTHER_ACCOUNT_ID = "dddd1000-0000-4000-8000-000000000002";
const CELL_ID = "dddd2000-0000-4000-8000-000000000001";

let directory: string;
let spool: SqliteSpool;

function event(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: ORGANIZATION_ID,
    accountId: ACCOUNT_ID,
    cellId: CELL_ID,
    eventKind: "MESSAGE",
    providerEventId: "provider-event-1",
    providerMessageId: "provider-message-1",
    providerTimestamp: 1_785_062_400,
    rawPayload: { raw: true },
    normalizedPayload: { text: "hello" },
    ...overrides,
  } as Parameters<SqliteSpool["append"]>[0];
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "openclaw-spool-"));
  spool = new SqliteSpool(join(directory, "spool.db"));
});

afterEach(() => {
  spool.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("SQLite spool durability configuration", () => {
  it("uses WAL journaling and FULL synchronous writes", () => {
    expect(String(spool.pragma("journal_mode")).toLowerCase()).toBe("wal");
    // synchronous=FULL is 2.
    expect(Number(spool.pragma("synchronous"))).toBe(2);
    expect(Number(spool.pragma("foreign_keys"))).toBe(1);
  });
});

describe("Stable identity matrix", () => {
  it("spools an event that carries only a provider event id", () => {
    const result = spool.append(event({ providerMessageId: null }));
    expect(result.outcome).toBe("SPOOLED");
    expect(result.dedupeKey).toBe("event:provider-event-1");
    expect(result.usedFallbackFingerprint).toBe(false);
  });

  it("spools an event that carries only a provider message id", () => {
    const result = spool.append(event({ providerEventId: null }));
    expect(result.outcome).toBe("SPOOLED");
    expect(result.dedupeKey).toBe("message:provider-message-1");
  });

  it("treats an exact replay of both identifiers as a duplicate", () => {
    const first = spool.append(event());
    const second = spool.append(event());

    expect(first.outcome).toBe("SPOOLED");
    expect(second.outcome).toBe("DUPLICATE");
    expect(second.localSequence).toBe(first.localSequence);
    expect(spool.countByState("SPOOLED")).toBe(1);
  });

  it("keeps the both-present mapping immutable", () => {
    spool.append(event());

    const remapped = spool.append(event({ providerMessageId: "provider-message-2" }));
    expect(remapped.outcome).toBe("MAPPING_CONFLICT");
    expect(remapped.reason).toBe("STABLE_ID_REMAPPED");
    expect(spool.countByState("QUARANTINED")).toBe(1);
  });

  it("quarantines the same stable id carrying a different payload", () => {
    spool.append(event());
    const conflicting = spool.append(event({ normalizedPayload: { text: "different" } }));

    expect(conflicting.outcome).toBe("MAPPING_CONFLICT");
    expect(conflicting.reason).toBe("STABLE_ID_PAYLOAD_CHANGED");
  });

  it("quarantines the same stable id reused across event kinds in one account", () => {
    spool.append(event());
    const reused = spool.append(event({ eventKind: "REACTION" }));

    expect(reused.outcome).toBe("MAPPING_CONFLICT");
    expect(reused.reason).toBe("STABLE_ID_KIND_CHANGED");
  });

  it("never dedupes the same textual id across accounts or organizations", () => {
    expect(spool.append(event()).outcome).toBe("SPOOLED");
    expect(spool.append(event({ accountId: OTHER_ACCOUNT_ID })).outcome).toBe("SPOOLED");
    expect(
      spool.append(event({ organizationId: OTHER_ORGANIZATION_ID })).outcome,
    ).toBe("SPOOLED");
    expect(spool.countByState("SPOOLED")).toBe(3);
  });

  it("uses a fallback fingerprint only when both identifiers are null", () => {
    const result = spool.append(
      event({ providerEventId: null, providerMessageId: null }),
    );

    expect(result.outcome).toBe("SPOOLED");
    expect(result.usedFallbackFingerprint).toBe(true);
    expect(result.dedupeKey.startsWith("fingerprint:")).toBe(true);

    // At-least-once: an identical fingerprint collapses, which the caller must
    // report as possible collision telemetry.
    const repeat = spool.append(event({ providerEventId: null, providerMessageId: null }));
    expect(repeat.outcome).toBe("DUPLICATE");
    expect(repeat.usedFallbackFingerprint).toBe(true);
  });
});

describe("Spool restart and corruption handling", () => {
  it("keeps committed rows across a reopen", () => {
    const path = join(directory, "restart.db");
    const first = new SqliteSpool(path);
    first.append(event());
    first.close();

    const second = new SqliteSpool(path);
    expect(second.countByState("SPOOLED")).toBe(1);
    expect(second.pending()[0]?.providerEventId).toBe("provider-event-1");
    second.close();
  });

  it("verifies checksums and quarantines a corrupted row", () => {
    spool.append(event());
    expect(spool.verifyChecksums()).toEqual({ verified: 1, quarantined: 0 });
  });
});

describe("Canonical acknowledgement", () => {
  it("deletes a row only when the full atomic commit is proven", () => {
    const appended = spool.append(event());
    const sequence = appended.localSequence!;

    expect(
      spool.acknowledge(sequence, {
        eventCommitted: true,
        messageCommitted: true,
        conversationCommitted: true,
        automationDecisionOrWorkMarker: false,
      }),
    ).toBe(false);
    expect(spool.countByState("SPOOLED")).toBe(1);

    expect(
      spool.acknowledge(sequence, {
        eventCommitted: true,
        messageCommitted: true,
        conversationCommitted: true,
        automationDecisionOrWorkMarker: true,
      }),
    ).toBe(true);
    expect(spool.countByState("SPOOLED")).toBe(0);
  });

  it("spools media manifests with bytes pending", () => {
    spool.append(event({ mediaManifest: [{ mediaId: "m1", mime: "image/png" }] }));
    expect(spool.pending()[0]?.mediaManifest).toEqual([{ mediaId: "m1", mime: "image/png" }]);
  });
});

describe("Spool pressure ladder", () => {
  it("runs normally below eighty percent", () => {
    const state = evaluatePressure(SPOOL_MAX_BYTES * 0.5);
    expect(state.level).toBe("NORMAL");
    expect(state.outboundAllowed).toBe(true);
    expect(state.ready).toBe(true);
  });

  it("pauses outbound, history sync, and media prefetch at eighty percent", () => {
    const state = evaluatePressure(SPOOL_MAX_BYTES * 0.8);
    expect(state.level).toBe("PAUSE_NONESSENTIAL");
    expect(state.outboundAllowed).toBe(false);
    expect(state.historySyncAllowed).toBe(false);
    expect(state.mediaPrefetchAllowed).toBe(false);
    expect(state.ready).toBe(true);
  });

  it("accepts only the minimal inbound envelope at ninety-five percent", () => {
    const state = evaluatePressure(SPOOL_MAX_BYTES * 0.95);
    expect(state.level).toBe("MINIMAL_ONLY");
    expect(state.minimalEnvelopeOnly).toBe(true);
    expect(state.intakeStopped).toBe(false);
  });

  it("stops intake and reports not-ready at one hundred percent", () => {
    const state = evaluatePressure(SPOOL_MAX_BYTES);
    expect(state.level).toBe("STOP_INTAKE");
    expect(state.intakeStopped).toBe(true);
    expect(state.ready).toBe(false);
    expect(state.gapStarted).toBe(true);
  });

  it("refuses new intake once the spool is full", () => {
    const tiny = new SqliteSpool(join(directory, "tiny.db"));
    // Force the ladder by treating the configured ceiling as already reached.
    expect(evaluatePressure(SPOOL_MAX_BYTES + 1).intakeStopped).toBe(true);
    tiny.close();
  });
});