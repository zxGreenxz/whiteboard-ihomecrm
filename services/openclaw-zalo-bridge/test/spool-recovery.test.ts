import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SqliteSpool } from "../src/spool/sqlite-spool.js";
import { payloadChecksum } from "../src/spool/checksum.js";
import { evaluatePressure, SPOOL_MAX_BYTES } from "../src/spool/pressure.js";

const ORGANIZATION_ID = "dddd0000-0000-4000-8000-000000000001";
const OTHER_ORGANIZATION_ID = "dddd0000-0000-4000-8000-000000000002";
const ACCOUNT_ID = "dddd1000-0000-4000-8000-000000000001";
const OTHER_ACCOUNT_ID = "dddd1000-0000-4000-8000-000000000002";
const CELL_ID = "dddd2000-0000-4000-8000-000000000001";
const COMMITTED_001_SQL = readFileSync(
  new URL("./fixtures/spool-001-committed.sql", import.meta.url),
  "utf8",
);
const LEGACY_UPGRADE_SQL = readFileSync(
  new URL("../src/spool/migrations/003_upgrade_legacy_spool.sql", import.meta.url),
  "utf8",
);

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
    providerConversationId: "provider-conversation-1",
    providerSenderId: "provider-sender-1",
    providerEventType: "message.text",
    providerTimestamp: 1_785_062_400,
    rawPayload: { raw: true },
    normalizedPayload: { text: "hello" },
    ...overrides,
  } as Parameters<SqliteSpool["append"]>[0];
}

function createCommitted001Database(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec(COMMITTED_001_SQL);
  return database;
}

function insertLegacyEvent(database: DatabaseSync, input: {
  localSequence: number;
  providerEventId: string;
  providerMessageId: string;
  rawPayload: string;
  normalizedPayload: unknown;
  mediaManifest?: unknown[];
  ackState?: "SPOOLED" | "SENDING" | "ACKNOWLEDGED" | "QUARANTINED";
  retryCount?: number;
  quarantineReason?: string | null;
}): void {
  const now = 1_785_062_400_000 + input.localSequence;
  database.prepare(`
    INSERT INTO inbound_events (
      local_sequence,organization_id,account_id,cell_id,event_kind,provider_event_id,
      provider_message_id,fallback_fingerprint,dedupe_key,raw_payload,
      normalized_payload,payload_sha256,media_manifest,media_byte_state,
      ack_state,retry_count,quarantine_reason,received_at_ms,updated_at_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    input.localSequence,
    ORGANIZATION_ID,
    ACCOUNT_ID,
    CELL_ID,
    "MESSAGE",
    input.providerEventId,
    input.providerMessageId,
    null,
    `event:${input.providerEventId}`,
    input.rawPayload,
    JSON.stringify(input.normalizedPayload),
    payloadChecksum(input.normalizedPayload),
    JSON.stringify(input.mediaManifest ?? []),
    "PENDING",
    input.ackState ?? "SPOOLED",
    input.retryCount ?? 0,
    input.quarantineReason ?? null,
    now,
    now,
  );
  database.prepare(`
    INSERT INTO stable_id_mappings (
      organization_id,account_id,provider_event_id,provider_message_id,
      event_kind,payload_sha256,created_at_ms
    ) VALUES (?,?,?,?,?,?,?)
  `).run(
    ORGANIZATION_ID,
    ACCOUNT_ID,
    input.providerEventId,
    input.providerMessageId,
    "MESSAGE",
    payloadChecksum(input.normalizedPayload),
    now,
  );
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

describe("Persistent inbound media checkpoints", () => {
  it("keeps the exact ticket and receipt across a bridge restart", () => {
    const inserted = spool.append(event({ mediaManifest: [{ version: 1, index: 0 }] }));
    const localSequence = inserted.localSequence!;
    const mediaId = "dddd9000-0000-4000-8000-000000000001";
    const ticket = { version: 1, jti: "dddd9000-0000-4000-8000-000000000002" };
    const receipt = { version: 1, receiptId: "dddd9000-0000-4000-8000-000000000003" };

    expect(spool.ensureMediaCheckpoint(localSequence, 0, mediaId).state).toBe("PENDING");
    spool.storeMediaTicket(localSequence, 0, ticket.jti, ticket);
    spool.storeMediaReceipt(localSequence, 0, receipt, "a".repeat(64));
    spool.close();
    spool = new SqliteSpool(join(directory, "spool.db"));

    expect(spool.mediaCheckpoint(localSequence, 0)).toEqual({
      localSequence,
      manifestIndex: 0,
      mediaId,
      state: "RECEIPT_STORED",
      ticketJti: ticket.jti,
      signedTicket: ticket,
      gatewayReceipt: receipt,
      receiptHash: "a".repeat(64),
      retryCount: 0,
      terminalReason: null,
    });
  });

  it("reopens legacy transient terminal checkpoints without losing durable progress", () => {
    const inserted = spool.append(event({
      mediaManifest: [
        { version: 1, index: 0 },
        { version: 1, index: 1 },
        { version: 1, index: 2 },
      ],
    }));
    const localSequence = inserted.localSequence!;
    const pendingMediaId = "dddd9000-0000-4000-8000-000000000010";
    const receiptMediaId = "dddd9000-0000-4000-8000-000000000011";
    const permanentMediaId = "dddd9000-0000-4000-8000-000000000012";
    const ticket = { version: 1, jti: "dddd9000-0000-4000-8000-000000000013" };
    const receipt = { version: 1, receiptId: "dddd9000-0000-4000-8000-000000000014" };

    spool.ensureMediaCheckpoint(localSequence, 0, pendingMediaId);
    spool.markMediaTerminal(localSequence, 0, "SKIPPED", "MEDIA_PREFETCH_DISABLED");
    spool.ensureMediaCheckpoint(localSequence, 1, receiptMediaId);
    spool.storeMediaTicket(localSequence, 1, ticket.jti, ticket);
    spool.storeMediaReceipt(localSequence, 1, receipt, "b".repeat(64));
    spool.markMediaTerminal(localSequence, 1, "FAILED", "MEDIA_RETRY_EXHAUSTED");
    spool.ensureMediaCheckpoint(localSequence, 2, permanentMediaId);
    spool.markMediaTerminal(localSequence, 2, "SKIPPED", "UNSUPPORTED_MEDIA_KIND");
    spool.close();
    spool = new SqliteSpool(join(directory, "spool.db"));

    expect(spool.mediaCheckpoint(localSequence, 0)).toMatchObject({
      state: "PENDING",
      terminalReason: null,
    });
    expect(spool.mediaCheckpoint(localSequence, 1)).toMatchObject({
      state: "RECEIPT_STORED",
      gatewayReceipt: receipt,
      receiptHash: "b".repeat(64),
      terminalReason: null,
    });
    expect(spool.mediaCheckpoint(localSequence, 2)).toMatchObject({
      state: "SKIPPED",
      terminalReason: "UNSUPPORTED_MEDIA_KIND",
    });
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

  it("keeps the original source timestamp for an exact replay from a replacement cell", () => {
    const first = spool.append(event({
      sessionGeneration: 5,
      sourceTimestamp: "2026-08-01T00:00:00.000Z",
    }));
    const replay = spool.append(event({
      cellId: "dddd2000-0000-4000-8000-000000000002",
      sessionGeneration: 6,
      sourceTimestamp: "2026-08-01T00:01:00.000Z",
    }));

    expect(replay).toMatchObject({ outcome: "DUPLICATE", localSequence: first.localSequence });
    expect(spool.pending()[0]).toMatchObject({
      cellId: CELL_ID,
      sessionGeneration: 5,
      sourceTimestamp: "2026-08-01T00:00:00.000Z",
    });
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

  it("keeps kind and raw payload immutable when only one provider id exists", () => {
    spool.append(event({ providerMessageId: null }));

    expect(spool.append(event({
      providerMessageId: null,
      eventKind: "REACTION",
    }))).toMatchObject({ outcome: "MAPPING_CONFLICT", reason: "STABLE_ID_KIND_CHANGED" });
    expect(spool.append(event({
      providerMessageId: null,
      rawPayload: { raw: "different" },
    }))).toMatchObject({ outcome: "MAPPING_CONFLICT", reason: "STABLE_ID_PAYLOAD_CHANGED" });
  });

  it("locks a pair learned after an event-only replay", () => {
    const first = spool.append(event({ providerMessageId: null }));
    expect(first.outcome).toBe("SPOOLED");
    expect(spool.append(event()).outcome).toBe("DUPLICATE");

    expect(spool.append(event({ providerEventId: null }))).toMatchObject({
      outcome: "DUPLICATE",
      localSequence: first.localSequence,
    });

    expect(spool.append(event({ providerMessageId: "provider-message-2" })))
      .toMatchObject({ outcome: "MAPPING_CONFLICT", reason: "STABLE_ID_REMAPPED" });
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
    expect(spool.telemetryValue("FALLBACK_FINGERPRINT_REPLAY")).toBe(1);
  });

  it("includes conversation and sender identity in the fallback fingerprint", () => {
    const noIds = { providerEventId: null, providerMessageId: null };
    const first = spool.append(event(noIds));
    const otherConversation = spool.append(event({
      ...noIds,
      providerConversationId: "provider-conversation-2",
    }));
    const otherSender = spool.append(event({
      ...noIds,
      providerSenderId: "provider-sender-2",
    }));

    expect(new Set([
      first.dedupeKey,
      otherConversation.dedupeKey,
      otherSender.dedupeKey,
    ]).size).toBe(3);
    expect(spool.countByState("SPOOLED")).toBe(3);
  });

  it("quarantines and counts a same-fingerprint different-payload collision", () => {
    const noIds = { providerEventId: null, providerMessageId: null };
    expect(spool.append(event({
      ...noIds,
      normalizedPayload: { text: "same", replyToProviderMessageId: null },
    })).outcome).toBe("SPOOLED");
    expect(spool.append(event({
      ...noIds,
      normalizedPayload: { text: "same", replyToProviderMessageId: "different-secondary-field" },
    }))).toMatchObject({ outcome: "PAYLOAD_CONFLICT" });
    expect(spool.telemetryValue("FALLBACK_FINGERPRINT_COLLISION")).toBe(1);
  });
});

describe("Spool restart and corruption handling", () => {
  it("upgrades the exact committed 001 schema with mixed states, sequences, and media intact", () => {
    const path = join(directory, "legacy.db");
    const legacy = createCommitted001Database(path);
    insertLegacyEvent(legacy, {
      localSequence: 2,
      providerEventId: "legacy-event-2",
      providerMessageId: "legacy-message-2",
      rawPayload: JSON.stringify({ raw: "queued" }),
      normalizedPayload: { text: "legacy queued" },
      mediaManifest: [{ index: 0, kind: "IMAGE", mime: "image/png", byteLength: 24 }],
    });
    insertLegacyEvent(legacy, {
      localSequence: 7,
      providerEventId: "legacy-event-7",
      providerMessageId: "legacy-message-7",
      rawPayload: JSON.stringify({ raw: "claimed" }),
      normalizedPayload: { text: "legacy claimed" },
      ackState: "SENDING",
      retryCount: 2,
    });
    insertLegacyEvent(legacy, {
      localSequence: 11,
      providerEventId: "legacy-event-11",
      providerMessageId: "legacy-message-11",
      rawPayload: "{malformed-json",
      normalizedPayload: { text: "legacy quarantined" },
      ackState: "QUARANTINED",
      quarantineReason: "ORIGINAL_QUARANTINE_EVIDENCE",
    });
    legacy.close();

    const upgraded = new SqliteSpool(path, { now: () => 1_785_062_400_100 });
    try {
      const pending = upgraded.pending();

      expect(pending).toHaveLength(2);
      expect(pending.map((item) => item.localSequence)).toEqual([2, 7]);
      expect(pending[0]).toMatchObject({
        providerEventId: "legacy-event-2",
        rawEnvelope: { raw: "queued" },
        normalizedPayload: { text: "legacy queued" },
        mediaManifest: [{ index: 0, kind: "IMAGE", mime: "image/png", byteLength: 24 }],
        sessionGeneration: 1,
      });
      expect(pending[1]).toMatchObject({ localSequence: 7, retryCount: 3 });
      expect(upgraded.verifyChecksums()).toEqual({ verified: 2, quarantined: 0 });
      const database = (upgraded as unknown as { db: DatabaseSync }).db;
      expect(database.prepare(
        "SELECT ack_state,quarantine_reason FROM inbound_events WHERE local_sequence=11",
      ).get()).toEqual({
        ack_state: "QUARANTINED",
        quarantine_reason: "ORIGINAL_QUARANTINE_EVIDENCE",
      });
      expect(upgraded.append(event({
        providerEventId: "new-event-only",
        providerMessageId: null,
      }))).toMatchObject({ outcome: "SPOOLED", localSequence: 12 });
    } finally {
      upgraded.close();
    }
  });

  it("recovers when 003 committed but the JavaScript checksum backfill never ran", () => {
    const path = join(directory, "legacy-crash-after-003.db");
    const legacy = createCommitted001Database(path);
    insertLegacyEvent(legacy, {
      localSequence: 4,
      providerEventId: "legacy-crash-event",
      providerMessageId: "legacy-crash-message",
      rawPayload: JSON.stringify({ raw: "survives-crash" }),
      normalizedPayload: { text: "survives crash" },
    });
    legacy.exec(LEGACY_UPGRADE_SQL);
    expect(legacy.prepare(
      "SELECT session_generation,raw_payload_sha256,source_raw_payload_sha256 FROM inbound_events",
    ).get()).toEqual({
      session_generation: 1,
      raw_payload_sha256: "",
      source_raw_payload_sha256: "",
    });
    legacy.close();

    const recovered = new SqliteSpool(path);
    try {
      expect(recovered.verifyChecksums()).toEqual({ verified: 1, quarantined: 0 });
      expect(recovered.pending()[0]).toMatchObject({
        localSequence: 4,
        rawEnvelope: { raw: "survives-crash" },
      });
    } finally {
      recovered.close();
    }
  });

  it("enforces fresh-001 claim owner and lease invariants after a legacy upgrade", () => {
    const path = join(directory, "legacy-claim-invariant.db");
    const legacy = createCommitted001Database(path);
    insertLegacyEvent(legacy, {
      localSequence: 1,
      providerEventId: "legacy-claim-event",
      providerMessageId: "legacy-claim-message",
      rawPayload: JSON.stringify({ raw: true }),
      normalizedPayload: { text: "claim invariant" },
    });
    legacy.close();

    const upgraded = new SqliteSpool(path);
    try {
      const database = (upgraded as unknown as { db: DatabaseSync }).db;
      expect(() => database.prepare(
        "UPDATE inbound_events SET claim_owner_token='orphan',claim_expires_at_ms=123 WHERE local_sequence=1",
      ).run()).toThrow(/claim|constraint|invalid/i);
      expect(() => database.prepare(
        "UPDATE inbound_events SET ack_state='SENDING' WHERE local_sequence=1",
      ).run()).toThrow(/claim|constraint|invalid/i);
      expect(() => database.prepare(
        "UPDATE inbound_events SET ack_state='SENDING',claim_owner_token='owner',claim_expires_at_ms=123 WHERE local_sequence=1",
      ).run()).not.toThrow();
    } finally {
      upgraded.close();
    }
  });

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

  it("quarantines malformed JSON per row and continues verifying later rows", () => {
    const corrupted = spool.append(event()).localSequence!;
    spool.append(event({
      providerEventId: "provider-event-2",
      providerMessageId: "provider-message-2",
    }));
    const database = (spool as unknown as { db: DatabaseSync }).db;
    database.prepare("UPDATE inbound_events SET raw_payload=? WHERE local_sequence=?")
      .run("{not-json", corrupted);

    expect(spool.verifyChecksums()).toEqual({ verified: 1, quarantined: 1 });
    expect(spool.pending()).toHaveLength(1);
    expect(spool.pending()[0]?.providerEventId).toBe("provider-event-2");
    expect(spool.countByState("QUARANTINED")).toBe(1);
  });

  it("re-spools an exact provider replay after checksum quarantine releases its stable identity", () => {
    const original = event();
    const corrupted = spool.append(original).localSequence!;
    const database = (spool as unknown as { db: DatabaseSync }).db;
    database.prepare("UPDATE inbound_events SET raw_payload=? WHERE local_sequence=?")
      .run(JSON.stringify({ corrupted: true }), corrupted);

    expect(spool.verifyChecksums()).toEqual({ verified: 0, quarantined: 1 });
    expect(spool.append(original)).toMatchObject({ outcome: "SPOOLED" });
    expect(spool.countByState("SPOOLED")).toBe(1);
    expect(spool.countByState("QUARANTINED")).toBe(1);
  });

  it("quarantines corrupt provider targets per row without aborting the pending scan", () => {
    const malformed = spool.append(event()).localSequence!;
    const invalid = spool.append(event({
      providerEventId: "provider-event-2",
      providerMessageId: "provider-message-2",
    })).localSequence!;
    spool.append(event({
      providerEventId: "provider-event-3",
      providerMessageId: "provider-message-3",
    }));
    const database = (spool as unknown as { db: DatabaseSync }).db;
    database.prepare("UPDATE inbound_events SET provider_target=? WHERE local_sequence=?")
      .run("{not-json", malformed);
    database.prepare("UPDATE inbound_events SET provider_target=? WHERE local_sequence=?")
      .run(JSON.stringify({ kind: "BROADCAST", providerId: "target-2" }), invalid);

    expect(spool.pending().map((entry) => entry.providerEventId)).toEqual(["provider-event-3"]);
    expect(spool.countByState("QUARANTINED")).toBe(2);
  });

  it("quarantines only the parent row when a media checkpoint JSON blob is corrupt", () => {
    const corrupted = spool.append(event({ mediaManifest: [{ version: 1, index: 0 }] }));
    spool.append(event({
      providerEventId: "provider-event-2",
      providerMessageId: "provider-message-2",
    }));
    const mediaId = "dddd9000-0000-4000-8000-000000000020";
    spool.ensureMediaCheckpoint(corrupted.localSequence!, 0, mediaId);
    spool.storeMediaTicket(
      corrupted.localSequence!,
      0,
      "dddd9000-0000-4000-8000-000000000021",
      { version: 1 },
    );
    const database = (spool as unknown as { db: DatabaseSync }).db;
    database.prepare(
      "UPDATE inbound_media_checkpoints SET signed_ticket=? WHERE local_sequence=? AND manifest_index=0",
    ).run("{not-json", corrupted.localSequence!);

    expect(() => spool.mediaCheckpoint(corrupted.localSequence!, 0)).toThrow(/corrupt/i);
    expect(spool.countByState("QUARANTINED")).toBe(1);
    expect(spool.pending()).toHaveLength(1);
    expect(spool.pending()[0]?.providerEventId).toBe("provider-event-2");
  });
});

describe("Canonical acknowledgement", () => {
  it("rejects overlapping claims and stale acknowledgements after lease takeover", () => {
    const path = join(directory, "claim-ownership.db");
    let clock = 1_000;
    spool.close();
    spool = new SqliteSpool(path, { now: () => clock });
    const second = new SqliteSpool(path, { now: () => clock });
    try {
      const sequence = spool.append(event()).localSequence!;
      expect(spool.claimForDrain([sequence], "owner-a", 5_000, clock)).toBe(1);
      expect(second.claimForDrain([sequence], "owner-b", 5_000, clock)).toBe(0);

      clock = 6_001;
      expect(second.reclaimExpiredClaims(clock)).toBe(1);
      expect(second.claimForDrain([sequence], "owner-b", 5_000, clock)).toBe(1);
      const acknowledgement = {
        eventCommitted: true,
        messageCommitted: true,
        conversationCommitted: true,
        automationDecisionOrWorkMarker: true,
      };
      expect(spool.acknowledge(sequence, acknowledgement, "owner-a")).toBe(false);
      expect(spool.releaseForRetry([sequence], "owner-a", clock)).toBe(0);
      expect(second.acknowledge(sequence, acknowledgement, "owner-b")).toBe(true);
    } finally {
      second.close();
    }
  });

  it("deletes a row only when the full atomic commit is proven", () => {
    const appended = spool.append(event());
    const sequence = appended.localSequence!;
    const ownerToken = "canonical-ack-owner";
    expect(spool.claimForDrain([sequence], ownerToken, 5_000)).toBe(1);

    expect(
      spool.acknowledge(sequence, {
        eventCommitted: true,
        messageCommitted: true,
        conversationCommitted: true,
        automationDecisionOrWorkMarker: false,
      }, ownerToken),
    ).toBe(false);
    expect(spool.countByState("SENDING")).toBe(1);

    expect(
      spool.acknowledge(sequence, {
        eventCommitted: true,
        messageCommitted: true,
        conversationCommitted: true,
        automationDecisionOrWorkMarker: true,
      }, ownerToken),
    ).toBe(true);
    expect(spool.countByState("SENDING")).toBe(0);
    expect(spool.acknowledge(sequence, {
      eventCommitted: true,
      messageCommitted: true,
      conversationCommitted: true,
      automationDecisionOrWorkMarker: true,
    }, ownerToken)).toBe(false);
  });

  it("spools media manifests with bytes pending", () => {
    spool.append(event({ mediaManifest: [{ mediaId: "m1", mime: "image/png" }] }));
    expect(spool.pending()[0]?.mediaManifest).toEqual([{ mediaId: "m1", mime: "image/png" }]);
  });
});

describe("Spool pressure ladder", () => {
  it("reserves capacity and rechecks pressure inside the write transaction", () => {
    spool.close();
    let measurements = 0;
    spool = new SqliteSpool(join(directory, "recheck.db"), {
      maxBytes: 1_000_000,
      reserveBytes: 10_000,
      measureUsedBytes: () => measurements++ === 0 ? 100_000 : 999_999,
    });

    expect(spool.append(event())).toMatchObject({
      outcome: "INTAKE_STOPPED",
      reason: "SPOOL_FULL",
    });
    expect(measurements).toBeGreaterThanOrEqual(2);
    expect(spool.countByState("SPOOLED")).toBe(0);
    expect(spool.gapEvidence()).toMatchObject({ reason: "SPOOL_FULL" });
  });

  it("preserves preallocated gap evidence when SQLite returns SQLITE_FULL", () => {
    const database = (spool as unknown as { db: DatabaseSync }).db;
    const pageCount = Number(spool.pragma("page_count"));
    database.exec(`PRAGMA max_page_count=${pageCount}`);

    expect(spool.append(event({
      rawPayload: { raw: randomBytes(256 * 1024).toString("hex") },
      normalizedPayload: { text: randomBytes(256 * 1024).toString("hex") },
    }))).toMatchObject({ outcome: "INTAKE_STOPPED", reason: "STORAGE_FULL" });
    expect(spool.gapEvidence()).toMatchObject({
      version: 1,
      reason: "STORAGE_FULL",
    });
    expect(spool.countByState("SPOOLED")).toBe(0);
  });

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

  it("refuses new intake and records one gap event once the real spool cap is full", () => {
    const tiny = new SqliteSpool(join(directory, "tiny.db"), { maxBytes: 1 });
    expect(tiny.append(event())).toMatchObject({ outcome: "INTAKE_STOPPED" });
    expect(tiny.append(event({ providerEventId: "provider-event-2" })))
      .toMatchObject({ outcome: "INTAKE_STOPPED" });
    expect(tiny.telemetryValue("INBOUND_GAP_STARTED")).toBe(1);
    tiny.close();
  });

  it("preserves the original gap-start timestamp across repeated intake refusals", () => {
    let now = 1_785_062_400_000;
    const stopped = new SqliteSpool(join(directory, "gap-start.db"), {
      maxBytes: 100,
      measureUsedBytes: () => 100,
      now: () => now,
    });
    try {
      expect(stopped.append(event())).toMatchObject({ outcome: "INTAKE_STOPPED" });
      const first = stopped.gapEvidence();
      now += 60_000;
      expect(stopped.append(event({ providerEventId: "provider-event-2" })))
        .toMatchObject({ outcome: "INTAKE_STOPPED" });
      expect(stopped.gapEvidence()).toEqual(first);
    } finally {
      stopped.close();
    }
  });

  it("stores a bounded minimal envelope at ninety-five percent", () => {
    const path = join(directory, "minimal.db");
    const minimal = new SqliteSpool(path, {
      maxBytes: 1_000_000,
      measureUsedBytes: () => 960_000,
    });
    try {
      const rawPayload = { provider: "large", ignored: "x".repeat(10_000) };

      expect(minimal.append(event({ rawPayload })).outcome).toBe("SPOOLED");
      expect(minimal.pending()[0]?.rawEnvelope).toEqual({
        version: 1,
        pressureState: "MINIMAL_ONLY",
      });
    } finally {
      minimal.close();
    }
  });

  it("stops intake when the oldest locally received row exceeds twenty-four hours", () => {
    spool.close();
    let now = 1_785_062_400_000;
    spool = new SqliteSpool(join(directory, "age.db"), { now: () => now });
    expect(spool.append(event()).outcome).toBe("SPOOLED");
    now += 24 * 60 * 60 * 1_000;
    expect(spool.append(event({
      providerEventId: "provider-event-2",
      providerMessageId: "provider-message-2",
    })))
      .toMatchObject({ outcome: "INTAKE_STOPPED", reason: "SPOOL_MAX_AGE" });
    expect(spool.telemetryValue("INBOUND_GAP_STARTED")).toBe(1);
  });
});
