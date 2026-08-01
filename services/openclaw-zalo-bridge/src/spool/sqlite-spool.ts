import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, fallbackFingerprint, payloadChecksum } from "./checksum.js";
import { evaluatePressure, SPOOL_MAX_AGE_MS, SPOOL_MAX_BYTES } from "./pressure.js";

const MIGRATION_SQL = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "migrations/001_init.sql"),
  "utf8",
);

export type SpoolOutcome =
  | "SPOOLED"
  | "DUPLICATE"
  | "MAPPING_CONFLICT"
  | "PAYLOAD_CONFLICT"
  | "INTAKE_STOPPED";

export interface InboundEventInput {
  organizationId: string;
  accountId: string;
  cellId: string;
  eventKind: string;
  providerEventId: string | null;
  providerMessageId: string | null;
  providerTimestamp: number;
  rawPayload: unknown;
  normalizedPayload: unknown;
  mediaManifest?: unknown[];
}

export interface SpoolResult {
  outcome: SpoolOutcome;
  localSequence: number | null;
  dedupeKey: string;
  usedFallbackFingerprint: boolean;
  reason?: string;
}

export interface SpooledEvent {
  localSequence: number;
  organizationId: string;
  accountId: string;
  cellId: string;
  eventKind: string;
  providerEventId: string | null;
  providerMessageId: string | null;
  payloadSha256: string;
  normalizedPayload: unknown;
  mediaManifest: unknown[];
  retryCount: number;
}

/**
 * The durable inbound spool.
 *
 * The vendored fork must not dispatch, queue, or auto-reply until `append`
 * returns a committed row. WAL + FULL means the commit survives a process crash
 * and an OS crash, which is what makes the "no acknowledgement before durability"
 * rule real rather than aspirational.
 */
export class SqliteSpool {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA synchronous=FULL");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec("PRAGMA busy_timeout=5000");
    this.db.exec(MIGRATION_SQL);
  }

  close(): void {
    this.db.close();
  }

  pragma(name: string): unknown {
    const row = this.db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
    return row ? Object.values(row)[0] : undefined;
  }

  usedBytes(): number {
    const pageCount = Number(this.pragma("page_count") ?? 0);
    const pageSize = Number(this.pragma("page_size") ?? 0);
    return pageCount * pageSize;
  }

  pressure() {
    return evaluatePressure(this.usedBytes(), SPOOL_MAX_BYTES);
  }

  /**
   * Resolves the identity of an inbound event. Provider identifiers win; the
   * fingerprint is a last resort and is reported so the caller can emit
   * at-least-once telemetry.
   */
  private resolveIdentity(input: InboundEventInput, payloadSha256: string): {
    dedupeKey: string;
    fallbackFingerprintValue: string | null;
  } {
    if (input.providerEventId !== null) {
      return { dedupeKey: `event:${input.providerEventId}`, fallbackFingerprintValue: null };
    }
    if (input.providerMessageId !== null) {
      return { dedupeKey: `message:${input.providerMessageId}`, fallbackFingerprintValue: null };
    }
    const fingerprint = fallbackFingerprint({
      organizationId: input.organizationId,
      accountId: input.accountId,
      eventKind: input.eventKind,
      payloadSha256,
      providerTimestamp: input.providerTimestamp,
    });
    return { dedupeKey: `fingerprint:${fingerprint}`, fallbackFingerprintValue: fingerprint };
  }

  /**
   * Enforces the immutable both-present mapping. A later event may never remap
   * either identifier, change the kind, or change the payload hash: that is a
   * quarantine, never a silent duplicate acknowledgement.
   */
  private checkMapping(input: InboundEventInput, payloadSha256: string): string | null {
    if (input.providerEventId === null || input.providerMessageId === null) return null;

    const byEvent = this.db.prepare(
      `SELECT * FROM stable_id_mappings
       WHERE organization_id=? AND account_id=? AND provider_event_id=?`,
    ).get(input.organizationId, input.accountId, input.providerEventId) as
      | Record<string, string>
      | undefined;
    const byMessage = this.db.prepare(
      `SELECT * FROM stable_id_mappings
       WHERE organization_id=? AND account_id=? AND provider_message_id=?`,
    ).get(input.organizationId, input.accountId, input.providerMessageId) as
      | Record<string, string>
      | undefined;

    for (const existing of [byEvent, byMessage]) {
      if (!existing) continue;
      if (
        existing.provider_event_id !== input.providerEventId ||
        existing.provider_message_id !== input.providerMessageId
      ) {
        return "STABLE_ID_REMAPPED";
      }
      if (existing.event_kind !== input.eventKind) return "STABLE_ID_KIND_CHANGED";
      if (existing.payload_sha256 !== payloadSha256) return "STABLE_ID_PAYLOAD_CHANGED";
    }
    return null;
  }

  append(input: InboundEventInput, nowMs = Date.now()): SpoolResult {
    const payloadSha256 = payloadChecksum(input.normalizedPayload);
    const { dedupeKey, fallbackFingerprintValue } = this.resolveIdentity(input, payloadSha256);

    const pressure = this.pressure();
    if (pressure.intakeStopped) {
      return {
        outcome: "INTAKE_STOPPED",
        localSequence: null,
        dedupeKey,
        usedFallbackFingerprint: fallbackFingerprintValue !== null,
        reason: "SPOOL_FULL",
      };
    }

    const mappingConflict = this.checkMapping(input, payloadSha256);
    if (mappingConflict) {
      this.quarantine(input, dedupeKey, payloadSha256, mappingConflict, nowMs);
      return {
        outcome: "MAPPING_CONFLICT",
        localSequence: null,
        dedupeKey,
        usedFallbackFingerprint: false,
        reason: mappingConflict,
      };
    }

    const existing = this.db.prepare(
      `SELECT local_sequence, payload_sha256 FROM inbound_events
       WHERE organization_id=? AND account_id=? AND dedupe_key=?`,
    ).get(input.organizationId, input.accountId, dedupeKey) as
      | { local_sequence: number; payload_sha256: string }
      | undefined;

    if (existing) {
      // An exact replay is a duplicate; the same stable id with different bytes
      // is a conflict that must not be acknowledged as if it were the same event.
      if (existing.payload_sha256 !== payloadSha256) {
        this.quarantine(input, dedupeKey, payloadSha256, "STABLE_ID_PAYLOAD_CHANGED", nowMs);
        return {
          outcome: "PAYLOAD_CONFLICT",
          localSequence: null,
          dedupeKey,
          usedFallbackFingerprint: fallbackFingerprintValue !== null,
          reason: "STABLE_ID_PAYLOAD_CHANGED",
        };
      }
      return {
        outcome: "DUPLICATE",
        localSequence: existing.local_sequence,
        dedupeKey,
        usedFallbackFingerprint: fallbackFingerprintValue !== null,
      };
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(
        `INSERT INTO inbound_events (
           organization_id, account_id, cell_id, event_kind,
           provider_event_id, provider_message_id, fallback_fingerprint, dedupe_key,
           raw_payload, normalized_payload, payload_sha256, media_manifest,
           media_byte_state, ack_state, retry_count, received_at_ms, updated_at_ms
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'PENDING','SPOOLED',0,?,?)`,
      ).run(
        input.organizationId,
        input.accountId,
        input.cellId,
        input.eventKind,
        input.providerEventId,
        input.providerMessageId,
        fallbackFingerprintValue,
        dedupeKey,
        canonicalJson(input.rawPayload),
        canonicalJson(input.normalizedPayload),
        payloadSha256,
        canonicalJson(input.mediaManifest ?? []),
        nowMs,
        nowMs,
      );

      if (input.providerEventId !== null && input.providerMessageId !== null) {
        this.db.prepare(
          `INSERT OR IGNORE INTO stable_id_mappings (
             organization_id, account_id, provider_event_id, provider_message_id,
             event_kind, payload_sha256, created_at_ms
           ) VALUES (?,?,?,?,?,?,?)`,
        ).run(
          input.organizationId,
          input.accountId,
          input.providerEventId,
          input.providerMessageId,
          input.eventKind,
          payloadSha256,
          nowMs,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    const row = this.db.prepare(
      `SELECT local_sequence FROM inbound_events
       WHERE organization_id=? AND account_id=? AND dedupe_key=?`,
    ).get(input.organizationId, input.accountId, dedupeKey) as
      | { local_sequence: number }
      | undefined;

    return {
      outcome: "SPOOLED",
      localSequence: row?.local_sequence ?? null,
      dedupeKey,
      usedFallbackFingerprint: fallbackFingerprintValue !== null,
    };
  }

  private quarantine(
    input: InboundEventInput,
    dedupeKey: string,
    payloadSha256: string,
    reason: string,
    nowMs: number,
  ): void {
    this.db.prepare(
      `INSERT INTO inbound_events (
         organization_id, account_id, cell_id, event_kind,
         provider_event_id, provider_message_id, fallback_fingerprint, dedupe_key,
         raw_payload, normalized_payload, payload_sha256, media_manifest,
         media_byte_state, ack_state, retry_count, quarantine_reason,
         received_at_ms, updated_at_ms
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'PENDING','QUARANTINED',0,?,?,?)`,
    ).run(
      input.organizationId,
      input.accountId,
      input.cellId,
      input.eventKind,
      input.providerEventId,
      input.providerMessageId,
      null,
      `quarantine:${dedupeKey}:${payloadSha256}:${nowMs}`,
      canonicalJson(input.rawPayload),
      canonicalJson(input.normalizedPayload),
      payloadSha256,
      "[]",
      reason,
      nowMs,
      nowMs,
    );
  }

  pending(limit = 100): SpooledEvent[] {
    const rows = this.db.prepare(
      `SELECT * FROM inbound_events WHERE ack_state='SPOOLED'
       ORDER BY local_sequence ASC LIMIT ?`,
    ).all(limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      localSequence: Number(row.local_sequence),
      organizationId: String(row.organization_id),
      accountId: String(row.account_id),
      cellId: String(row.cell_id),
      eventKind: String(row.event_kind),
      providerEventId: row.provider_event_id === null ? null : String(row.provider_event_id),
      providerMessageId: row.provider_message_id === null
        ? null
        : String(row.provider_message_id),
      payloadSha256: String(row.payload_sha256),
      normalizedPayload: JSON.parse(String(row.normalized_payload)),
      mediaManifest: JSON.parse(String(row.media_manifest)),
      retryCount: Number(row.retry_count),
    }));
  }

  /**
   * Verifies the stored checksum. A row whose bytes no longer hash to the stored
   * digest is quarantined rather than replayed into Supabase.
   */
  verifyChecksums(): { verified: number; quarantined: number } {
    const rows = this.db.prepare(
      `SELECT local_sequence, normalized_payload, payload_sha256 FROM inbound_events
       WHERE ack_state IN ('SPOOLED','SENDING')`,
    ).all() as Record<string, unknown>[];
    let quarantined = 0;
    for (const row of rows) {
      const actual = payloadChecksum(JSON.parse(String(row.normalized_payload)));
      if (actual !== String(row.payload_sha256)) {
        this.db.prepare(
          `UPDATE inbound_events SET ack_state='QUARANTINED', quarantine_reason='CHECKSUM_MISMATCH'
           WHERE local_sequence=?`,
        ).run(Number(row.local_sequence));
        quarantined += 1;
      }
    }
    return { verified: rows.length - quarantined, quarantined };
  }

  /**
   * Deletion happens only after Supabase proves the canonical commit: event,
   * message, conversation, and the automation decision or work marker together.
   */
  acknowledge(localSequence: number, acknowledgement: {
    eventCommitted: boolean;
    messageCommitted: boolean;
    conversationCommitted: boolean;
    automationDecisionOrWorkMarker: boolean;
  }): boolean {
    const complete = acknowledgement.eventCommitted &&
      acknowledgement.messageCommitted &&
      acknowledgement.conversationCommitted &&
      acknowledgement.automationDecisionOrWorkMarker;
    if (!complete) return false;
    this.db.prepare("DELETE FROM inbound_events WHERE local_sequence=?").run(localSequence);
    return true;
  }

  countByState(state: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS count FROM inbound_events WHERE ack_state=?",
    ).get(state) as { count: number };
    return Number(row.count);
  }

  expiredCount(nowMs = Date.now()): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS count FROM inbound_events WHERE received_at_ms < ?",
    ).get(nowMs - SPOOL_MAX_AGE_MS) as { count: number };
    return Number(row.count);
  }
}