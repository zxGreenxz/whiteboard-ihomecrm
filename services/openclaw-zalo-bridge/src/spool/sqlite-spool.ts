import { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, fallbackFingerprint, payloadChecksum } from "./checksum.js";
import { evaluatePressure, SPOOL_MAX_AGE_MS, SPOOL_MAX_BYTES } from "./pressure.js";

const migrationDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "migrations");
const INITIAL_MIGRATION_SQL = readFileSync(resolve(migrationDirectory, "001_init.sql"), "utf8");
const MEDIA_MIGRATION_SQL = readFileSync(
  resolve(migrationDirectory, "002_media_checkpoints.sql"),
  "utf8",
);
const LEGACY_UPGRADE_SQL = readFileSync(
  resolve(migrationDirectory, "003_upgrade_legacy_spool.sql"),
  "utf8",
);
const CLAIM_INVARIANT_MIGRATION_SQL = readFileSync(
  resolve(migrationDirectory, "004_claim_invariant.sql"),
  "utf8",
);
const RUNTIME_COMMAND_MIGRATION_SQL = readFileSync(
  resolve(migrationDirectory, "005_runtime_command_journal.sql"),
  "utf8",
);
const STABLE_MAPPING_LIFECYCLE_MIGRATION_SQL = readFileSync(
  resolve(migrationDirectory, "006_stable_mapping_lifecycle.sql"),
  "utf8",
);
const GAP_EVIDENCE_BYTES = 4_096;

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
  sessionGeneration?: number;
  eventKind: string;
  providerEventId: string | null;
  providerMessageId: string | null;
  providerConversationId?: string;
  providerSenderId?: string;
  providerTarget?: { kind: "PEER" | "SALES_GROUP"; providerId: string };
  providerEventType?: string;
  sourceTimestamp?: string;
  callbackReceivedAt?: string;
  providerTimestamp: number;
  rawPayload: unknown;
  rawPayloadSha256?: string;
  normalizedPayload: unknown;
  normalizedPayloadSha256?: string;
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
  sessionGeneration: number;
  eventKind: string;
  providerEventId: string | null;
  providerMessageId: string | null;
  providerConversationId: string;
  providerSenderId: string;
  providerTarget: { kind: "PEER" | "SALES_GROUP"; providerId: string };
  providerEventType: string;
  sourceTimestamp: string;
  callbackReceivedAt: string;
  rawEnvelope: unknown;
  rawEnvelopeSha256: string;
  payloadSha256: string;
  normalizedPayload: unknown;
  mediaManifest: unknown[];
  retryCount: number;
}

export interface SqliteSpoolOptions {
  maxBytes?: number;
  maxAgeMs?: number;
  reserveBytes?: number;
  measureUsedBytes?: () => number;
  now?: () => number;
}

export type InboundMediaCheckpointState =
  | "PENDING"
  | "TICKET_ISSUED"
  | "RECEIPT_STORED"
  | "AVAILABLE"
  | "SKIPPED"
  | "FAILED";

export interface InboundMediaCheckpoint {
  localSequence: number;
  manifestIndex: number;
  mediaId: string;
  state: InboundMediaCheckpointState;
  ticketJti: string | null;
  signedTicket: unknown | null;
  gatewayReceipt: unknown | null;
  receiptHash: string | null;
  retryCount: number;
  terminalReason: string | null;
}

export type RuntimeCommandJournalStage =
  | "CLAIMED"
  | "START_AUTHORIZED"
  | "EFFECT_INTENT"
  | "PROVIDER_RECORDED"
  | "QR_MATERIAL_READY"
  | "PUBLISH_PENDING"
  | "LOGIN_WAITING"
  | "RESULT_PENDING"
  | "SERVER_ACCEPTED"
  | "AMBIGUOUS"
  | "STALE_LOGIN_CLEANUP_PENDING"
  | "SEALED";

export interface RuntimeCommandJournalClaim {
  runtimeCommandId: string;
  commandKind: "QR_LOGIN" | "DISCONNECT";
  claimGeneration: number;
  claimToken: string;
  payloadHash: string;
  sourceSessionGeneration: number;
  targetSessionGeneration: number;
  sourceConnectionGeneration: number;
  targetConnectionGeneration: number;
  expectedFencingToken: number;
  leaseExpiresAt: string;
  effectDeadlineAt: string | null;
  payload: unknown;
}

export interface RuntimeCommandJournalSnapshot extends RuntimeCommandJournalClaim {
  stage: RuntimeCommandJournalStage;
  publishPayload: unknown | null;
  result: unknown | null;
  resultHash: string | null;
  sealedReason: string | null;
}

export class SpoolCorruptionError extends Error {
  readonly code = "SPOOL_ROW_CORRUPT";
  readonly localSequence: number;

  constructor(localSequence: number) {
    super("spool row contains corrupt persisted JSON");
    this.name = "SpoolCorruptionError";
    this.localSequence = localSequence;
  }
}

function parseProviderTarget(value: unknown): SpooledEvent["providerTarget"] {
  const parsed = JSON.parse(String(value)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("provider target is invalid");
  }
  const target = parsed as Record<string, unknown>;
  const keys = Object.keys(target).sort();
  if (
    keys.length !== 2 || keys[0] !== "kind" || keys[1] !== "providerId" ||
    (target.kind !== "PEER" && target.kind !== "SALES_GROUP") ||
    typeof target.providerId !== "string" || target.providerId.length === 0 ||
    target.providerId !== target.providerId.trim()
  ) throw new TypeError("provider target is invalid");
  return { kind: target.kind, providerId: target.providerId };
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
  private readonly path: string;
  private readonly maxBytes: number;
  private readonly maxAgeMs: number;
  private readonly reserveBytes: number;
  private readonly measureUsedBytes: (() => number) | null;
  private readonly now: () => number;
  private readonly gapEvidencePath: string;

  constructor(path: string, options: SqliteSpoolOptions = {}) {
    this.path = path;
    this.maxBytes = options.maxBytes ?? SPOOL_MAX_BYTES;
    this.maxAgeMs = options.maxAgeMs ?? SPOOL_MAX_AGE_MS;
    this.reserveBytes = options.reserveBytes ?? Math.min(64 * 1024, Math.floor(this.maxBytes * 0.01));
    this.measureUsedBytes = options.measureUsedBytes ?? null;
    this.now = options.now ?? Date.now;
    this.gapEvidencePath = `${path}.inbound-gap`;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) {
      throw new RangeError("spool maxBytes is invalid");
    }
    if (!Number.isSafeInteger(this.maxAgeMs) || this.maxAgeMs < 1) {
      throw new RangeError("spool maxAgeMs is invalid");
    }
    if (!Number.isSafeInteger(this.reserveBytes) || this.reserveBytes < 0 || this.reserveBytes >= this.maxBytes) {
      throw new RangeError("spool reserveBytes is invalid");
    }
    for (const ownedFile of [path, this.gapEvidencePath]) {
      try {
        const metadata = lstatSync(ownedFile);
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          throw new TypeError("spool path must be a regular owned file");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    try {
      closeSync(openSync(this.gapEvidencePath, "wx+", 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const gapDescriptor = openSync(this.gapEvidencePath, "r+");
    try {
      chmodSync(this.gapEvidencePath, 0o600);
      if (statSync(this.gapEvidencePath).size !== GAP_EVIDENCE_BYTES) {
        ftruncateSync(gapDescriptor, 0);
        writeSync(gapDescriptor, Buffer.alloc(GAP_EVIDENCE_BYTES, 0x20), 0, GAP_EVIDENCE_BYTES, 0);
        fsyncSync(gapDescriptor);
      }
    } finally {
      closeSync(gapDescriptor);
    }
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA synchronous=FULL");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec("PRAGMA busy_timeout=5000");
    this.db.exec(INITIAL_MIGRATION_SQL);
    const inboundColumns = this.db.prepare("PRAGMA table_info(inbound_events)")
      .all() as Array<{ name: string }>;
    if (!inboundColumns.some((column) => column.name === "session_generation")) {
      this.db.exec(LEGACY_UPGRADE_SQL);
    }
    const upgradedInboundColumns = this.db.prepare("PRAGMA table_info(inbound_events)")
      .all() as Array<{ name: string }>;
    if (!upgradedInboundColumns.some((column) => column.name === "claim_owner_token")) {
      this.db.exec("ALTER TABLE inbound_events ADD COLUMN claim_owner_token TEXT");
    }
    if (!upgradedInboundColumns.some((column) => column.name === "claim_expires_at_ms")) {
      this.db.exec("ALTER TABLE inbound_events ADD COLUMN claim_expires_at_ms INTEGER");
    }
    this.backfillLegacyRawChecksums();
    const stableMappingColumns = this.db.prepare("PRAGMA table_info(stable_id_mappings)")
      .all() as Array<{ name: string }>;
    if (!stableMappingColumns.some((column) => column.name === "mapping_state")) {
      this.db.exec(STABLE_MAPPING_LIFECYCLE_MIGRATION_SQL);
    }
    this.db.prepare(
      `UPDATE inbound_events
       SET ack_state='SPOOLED', claim_owner_token=NULL, claim_expires_at_ms=NULL,
           retry_count=retry_count+1, updated_at_ms=?
       WHERE ack_state='SENDING'
         AND (claim_owner_token IS NULL OR claim_expires_at_ms IS NULL OR claim_expires_at_ms<=?)`,
    ).run(this.now(), this.now());
    this.db.exec(CLAIM_INVARIANT_MIGRATION_SQL);
    this.db.exec(MEDIA_MIGRATION_SQL);
    this.db.exec(RUNTIME_COMMAND_MIGRATION_SQL);
    this.db.prepare(
      `UPDATE inbound_media_checkpoints
       SET state=CASE
             WHEN gateway_receipt IS NOT NULL THEN 'RECEIPT_STORED'
             WHEN signed_ticket IS NOT NULL THEN 'TICKET_ISSUED'
             ELSE 'PENDING'
           END,
           terminal_reason=NULL,
           updated_at_ms=?
       WHERE state='FAILED'
          OR (state='SKIPPED' AND (terminal_reason IS NULL OR terminal_reason NOT IN (
            'MANIFEST_UNAVAILABLE',
            'UNSUPPORTED_MEDIA_KIND',
            'MEDIA_UNFETCHABLE',
            'UNSUPPORTED_IMAGE_MIME',
            'IMAGE_TOO_LARGE_FOR_AUTOMATIC_FETCH'
          )))`,
    ).run(this.now());
    for (const ownedFile of [path, `${path}-wal`, `${path}-shm`]) {
      try {
        const metadata = lstatSync(ownedFile);
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          throw new TypeError("spool database file is not regular");
        }
        chmodSync(ownedFile, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  close(): void {
    this.db.close();
  }

  private backfillLegacyRawChecksums(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db.prepare(
        `SELECT local_sequence,raw_payload FROM inbound_events
         WHERE raw_payload_sha256='' OR source_raw_payload_sha256=''`,
      ).all() as Array<{ local_sequence: number; raw_payload: string }>;
      const update = this.db.prepare(
        `UPDATE inbound_events
         SET raw_payload_sha256=?,source_raw_payload_sha256=?,
             ack_state=CASE WHEN ? IS NULL THEN ack_state ELSE 'QUARANTINED' END,
             quarantine_reason=COALESCE(quarantine_reason,?)
         WHERE local_sequence=?`,
      );
      for (const row of rows) {
        let rawValue: unknown;
        let quarantineReason: string | null = null;
        try {
          rawValue = JSON.parse(row.raw_payload);
        } catch {
          rawValue = row.raw_payload;
          quarantineReason = "LEGACY_RAW_PAYLOAD_INVALID";
        }
        const checksum = payloadChecksum(rawValue);
        update.run(
          checksum,
          checksum,
          quarantineReason,
          quarantineReason,
          row.local_sequence,
        );
      }
      this.db.exec(`
        UPDATE stable_id_mappings
        SET raw_payload_sha256=COALESCE((
          SELECT event.raw_payload_sha256
          FROM inbound_events event
          WHERE event.organization_id=stable_id_mappings.organization_id
            AND event.account_id=stable_id_mappings.account_id
            AND (
              (stable_id_mappings.provider_event_id IS NOT NULL
                AND event.provider_event_id=stable_id_mappings.provider_event_id)
              OR (stable_id_mappings.provider_message_id IS NOT NULL
                AND event.provider_message_id=stable_id_mappings.provider_message_id)
            )
          ORDER BY event.local_sequence ASC LIMIT 1
        ),raw_payload_sha256)
      `);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* SQLite may have already rolled back. */ }
      throw error;
    }
  }

  pragma(name: string): unknown {
    const row = this.db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
    return row ? Object.values(row)[0] : undefined;
  }

  usedBytes(): number {
    if (this.measureUsedBytes !== null) {
      const measured = this.measureUsedBytes();
      if (!Number.isSafeInteger(measured) || measured < 0) {
        throw new RangeError("measured spool bytes is invalid");
      }
      return measured;
    }
    const pageCount = Number(this.pragma("page_count") ?? 0);
    const pageSize = Number(this.pragma("page_size") ?? 0);
    const logicalBytes = pageCount * pageSize;
    let physicalBytes = 0;
    for (const path of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
      try {
        physicalBytes += statSync(path).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return Math.max(logicalBytes, physicalBytes);
  }

  pressure() {
    return evaluatePressure(this.usedBytes(), this.maxBytes);
  }

  private incrementTelemetry(name: string, nowMs: number): void {
    this.db.prepare(
      `INSERT INTO spool_telemetry(name,value,updated_at_ms) VALUES (?,1,?)
       ON CONFLICT(name) DO UPDATE SET value=value+1, updated_at_ms=excluded.updated_at_ms`,
    ).run(name, nowMs);
  }

  private recordGapStarted(nowMs: number): void {
    this.db.prepare(
      "INSERT OR IGNORE INTO spool_telemetry(name,value,updated_at_ms) VALUES ('INBOUND_GAP_STARTED',1,?)",
    ).run(nowMs);
  }

  private persistGapEvidence(reason: string, startedAtMs: number): void {
    const payload = Buffer.from(JSON.stringify({
      version: 1,
      active: true,
      reason,
      startedAt: new Date(startedAtMs).toISOString(),
    }), "utf8");
    if (payload.byteLength > GAP_EVIDENCE_BYTES) throw new Error("gap evidence is too large");
    const descriptor = openSync(this.gapEvidencePath, "r+");
    try {
      writeSync(descriptor, Buffer.alloc(GAP_EVIDENCE_BYTES, 0x20), 0, GAP_EVIDENCE_BYTES, 0);
      writeSync(descriptor, payload, 0, payload.byteLength, 0);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }

  private recordGap(reason: string, nowMs: number): void {
    let existing: ReturnType<SqliteSpool["gapEvidence"]> = null;
    try { existing = this.gapEvidence(); } catch { /* Replace corrupt sidecar evidence. */ }
    if (existing === null || existing.reason !== reason) {
      const startedAtMs = existing === null ? nowMs : Date.parse(existing.startedAt);
      this.persistGapEvidence(reason, Number.isFinite(startedAtMs) ? startedAtMs : nowMs);
    }
    try {
      this.recordGapStarted(nowMs);
    } catch {
      // The preallocated sidecar remains authoritative when SQLite is full.
    }
  }

  gapEvidence(): { version: 1; reason: string; startedAt: string } | null {
    const value = readFileSync(this.gapEvidencePath, "utf8").trim();
    if (value.length === 0) return null;
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed.version !== 1 || parsed.active !== true || typeof parsed.reason !== "string" ||
      typeof parsed.startedAt !== "string") return null;
    return { version: 1, reason: parsed.reason, startedAt: parsed.startedAt };
  }

  telemetryValue(name: string): number {
    const row = this.db.prepare("SELECT value FROM spool_telemetry WHERE name=?")
      .get(name) as { value: number } | undefined;
    return row?.value ?? 0;
  }

  /**
   * Resolves the identity of an inbound event. Provider identifiers win; the
   * fingerprint is a last resort and is reported so the caller can emit
   * at-least-once telemetry.
   */
  private resolveIdentity(input: InboundEventInput): {
    dedupeKey: string;
    fallbackFingerprintValue: string | null;
  } {
    if (input.providerEventId !== null) {
      return { dedupeKey: `event:${input.providerEventId}`, fallbackFingerprintValue: null };
    }
    if (input.providerMessageId !== null) {
      return { dedupeKey: `message:${input.providerMessageId}`, fallbackFingerprintValue: null };
    }
    const normalized = input.normalizedPayload && typeof input.normalizedPayload === "object" &&
        !Array.isArray(input.normalizedPayload)
      ? input.normalizedPayload as Record<string, unknown>
      : {};
    const mediaChecksums = (input.mediaManifest ?? []).map((entry) =>
      entry && typeof entry === "object" && !Array.isArray(entry) &&
          typeof (entry as Record<string, unknown>).providerChecksum === "string"
        ? (entry as Record<string, unknown>).providerChecksum as string
        : null
    );
    const fingerprint = fallbackFingerprint({
      organizationId: input.organizationId,
      accountId: input.accountId,
      eventKind: input.eventKind,
      providerConversationId: input.providerConversationId ?? "",
      providerSenderId: input.providerSenderId ?? "",
      sourceTimestamp: input.sourceTimestamp ?? String(input.providerTimestamp),
      providerEventType: input.providerEventType ?? input.eventKind,
      content: Object.hasOwn(normalized, "text") ? normalized.text : null,
      mediaChecksums,
    });
    return { dedupeKey: `fingerprint:${fingerprint}`, fallbackFingerprintValue: fingerprint };
  }

  /** Persistent stable-ID registry, including event-only and message-only rows. */
  private inspectMapping(
    input: InboundEventInput,
    payloadSha256: string,
    rawPayloadSha256: string,
  ): {
    mappingId: number | null;
    mappingState: "PENDING" | "CANONICAL_COMMITTED" | "QUARANTINED" | null;
    conflict: string | null;
  } {
    if (input.providerEventId === null && input.providerMessageId === null) {
      return { mappingId: null, mappingState: null, conflict: null };
    }
    const rows = this.db.prepare(
      `SELECT * FROM stable_id_mappings
       WHERE organization_id=? AND account_id=? AND (
         (? IS NOT NULL AND provider_event_id=?) OR
         (? IS NOT NULL AND provider_message_id=?)
       )`,
    ).all(
      input.organizationId,
      input.accountId,
      input.providerEventId,
      input.providerEventId,
      input.providerMessageId,
      input.providerMessageId,
    ) as Array<{
      mapping_id: number;
      provider_event_id: string | null;
      provider_message_id: string | null;
      event_kind: string;
      payload_sha256: string;
      raw_payload_sha256: string;
      mapping_state: "PENDING" | "CANONICAL_COMMITTED" | "QUARANTINED";
    }>;
    const unique = new Map(rows.map((row) => [row.mapping_id, row]));
    if (unique.size > 1) {
      return { mappingId: null, mappingState: null, conflict: "STABLE_ID_REMAPPED" };
    }
    const existing = [...unique.values()][0];
    if (!existing) return { mappingId: null, mappingState: null, conflict: null };
    if (
      (existing.provider_event_id !== null && input.providerEventId !== null &&
        existing.provider_event_id !== input.providerEventId) ||
      (existing.provider_message_id !== null && input.providerMessageId !== null &&
        existing.provider_message_id !== input.providerMessageId)
    ) return {
      mappingId: existing.mapping_id,
      mappingState: existing.mapping_state,
      conflict: "STABLE_ID_REMAPPED",
    };
    if (existing.event_kind !== input.eventKind) {
      return {
        mappingId: existing.mapping_id,
        mappingState: existing.mapping_state,
        conflict: "STABLE_ID_KIND_CHANGED",
      };
    }
    if (
      existing.payload_sha256 !== payloadSha256 ||
      (existing.raw_payload_sha256 !== "" && existing.raw_payload_sha256 !== rawPayloadSha256)
    ) return {
      mappingId: existing.mapping_id,
      mappingState: existing.mapping_state,
      conflict: "STABLE_ID_PAYLOAD_CHANGED",
    };
    return { mappingId: existing.mapping_id, mappingState: existing.mapping_state, conflict: null };
  }

  private completeMapping(
    mappingId: number,
    input: InboundEventInput,
    rawPayloadSha256: string,
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(
        `UPDATE stable_id_mappings SET
           provider_event_id=COALESCE(provider_event_id, ?),
           provider_message_id=COALESCE(provider_message_id, ?),
           raw_payload_sha256=CASE WHEN raw_payload_sha256='' THEN ? ELSE raw_payload_sha256 END
         WHERE mapping_id=?`,
      ).run(input.providerEventId, input.providerMessageId, rawPayloadSha256, mappingId);
      const mapping = this.db.prepare(
        `SELECT organization_id,account_id,provider_event_id,provider_message_id
         FROM stable_id_mappings WHERE mapping_id=?`,
      ).get(mappingId) as {
        organization_id: string;
        account_id: string;
        provider_event_id: string | null;
        provider_message_id: string | null;
      } | undefined;
      if (mapping === undefined) throw new Error("stable ID mapping disappeared");
      this.db.prepare(
        `UPDATE inbound_events SET
           provider_event_id=COALESCE(provider_event_id, ?),
           provider_message_id=COALESCE(provider_message_id, ?)
         WHERE organization_id=? AND account_id=? AND ack_state!='QUARANTINED' AND (
           (? IS NOT NULL AND provider_event_id=?) OR
           (? IS NOT NULL AND provider_message_id=?)
         )`,
      ).run(
        mapping.provider_event_id,
        mapping.provider_message_id,
        mapping.organization_id,
        mapping.account_id,
        mapping.provider_event_id,
        mapping.provider_event_id,
        mapping.provider_message_id,
        mapping.provider_message_id,
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private localSequenceForStableId(input: InboundEventInput): number | null {
    const row = this.db.prepare(
      `SELECT local_sequence FROM inbound_events
       WHERE organization_id=? AND account_id=? AND ack_state!='QUARANTINED' AND (
         (? IS NOT NULL AND provider_event_id=?) OR
         (? IS NOT NULL AND provider_message_id=?)
       ) ORDER BY local_sequence ASC LIMIT 1`,
    ).get(
      input.organizationId,
      input.accountId,
      input.providerEventId,
      input.providerEventId,
      input.providerMessageId,
      input.providerMessageId,
    ) as { local_sequence: number } | undefined;
    return row?.local_sequence ?? null;
  }

  private quarantineStoredRow(localSequence: number, reason: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(
        `SELECT organization_id,account_id,provider_event_id,provider_message_id,dedupe_key
         FROM inbound_events WHERE local_sequence=?`,
      ).get(localSequence) as {
        organization_id: string;
        account_id: string;
        provider_event_id: string | null;
        provider_message_id: string | null;
        dedupe_key: string;
      } | undefined;
      if (row === undefined) throw new Error("inbound row disappeared during quarantine");
      this.db.prepare(
        `UPDATE inbound_events
         SET ack_state='QUARANTINED', quarantine_reason=?, claim_owner_token=NULL,
             claim_expires_at_ms=NULL, dedupe_key=?, updated_at_ms=?
         WHERE local_sequence=?`,
      ).run(
        reason,
        `quarantine:stored:${localSequence}:${row.dedupe_key}`,
        this.now(),
        localSequence,
      );
      this.db.prepare(
        `DELETE FROM stable_id_mappings
         WHERE organization_id=? AND account_id=? AND (
           (? IS NOT NULL AND provider_event_id=?) OR
           (? IS NOT NULL AND provider_message_id=?)
         )`,
      ).run(
        row.organization_id,
        row.account_id,
        row.provider_event_id,
        row.provider_event_id,
        row.provider_message_id,
        row.provider_message_id,
      );
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* SQLite may have already rolled back. */ }
      throw error;
    }
  }

  append(input: InboundEventInput): SpoolResult {
    const nowMs = this.now();
    if (!Number.isSafeInteger(nowMs)) throw new TypeError("spool clock is invalid");
    const payloadSha256 = payloadChecksum(input.normalizedPayload);
    const rawPayloadSha256 = payloadChecksum(input.rawPayload);
    if (
      input.normalizedPayloadSha256 !== undefined &&
      input.normalizedPayloadSha256 !== payloadSha256
    ) throw new TypeError("normalized payload checksum mismatch");
    if (input.rawPayloadSha256 !== undefined && input.rawPayloadSha256 !== rawPayloadSha256) {
      throw new TypeError("raw payload checksum mismatch");
    }
    const sessionGeneration = input.sessionGeneration ?? 0;
    if (!Number.isSafeInteger(sessionGeneration) || sessionGeneration < 0) {
      throw new TypeError("session generation is invalid");
    }
    const stableFallback = input.providerMessageId ?? input.providerEventId ?? "unknown";
    const providerConversationId = input.providerConversationId ?? stableFallback;
    const providerSenderId = input.providerSenderId ?? stableFallback;
    const providerTarget = input.providerTarget ?? { kind: "PEER" as const, providerId: stableFallback };
    const providerEventType = input.providerEventType ?? input.eventKind;
    const sourceTimestamp = input.sourceTimestamp ?? new Date(
      input.providerTimestamp < 10_000_000_000 ? input.providerTimestamp * 1_000 : input.providerTimestamp,
    ).toISOString();
    const callbackReceivedAt = input.callbackReceivedAt ?? new Date(nowMs).toISOString();
    const { dedupeKey, fallbackFingerprintValue } = this.resolveIdentity(input);

    const pressure = this.pressure();
    const ageExpired = this.expiredCount(nowMs) > 0;
    if (pressure.intakeStopped || ageExpired) {
      this.recordGap(ageExpired ? "SPOOL_MAX_AGE" : "SPOOL_FULL", nowMs);
      return {
        outcome: "INTAKE_STOPPED",
        localSequence: null,
        dedupeKey,
        usedFallbackFingerprint: fallbackFingerprintValue !== null,
        reason: ageExpired ? "SPOOL_MAX_AGE" : "SPOOL_FULL",
      };
    }

    const mapping = this.inspectMapping(input, payloadSha256, rawPayloadSha256);
    if (mapping.conflict) {
      this.quarantine(input, dedupeKey, payloadSha256, mapping.conflict, nowMs);
      return {
        outcome: "MAPPING_CONFLICT",
        localSequence: null,
        dedupeKey,
        usedFallbackFingerprint: false,
        reason: mapping.conflict,
      };
    }
    const quarantinedMappingId = mapping.mappingState === "QUARANTINED"
      ? mapping.mappingId
      : null;
    if (mapping.mappingId !== null && quarantinedMappingId === null) {
      this.completeMapping(mapping.mappingId, input, rawPayloadSha256);
      return {
        outcome: "DUPLICATE",
        localSequence: this.localSequenceForStableId(input),
        dedupeKey,
        usedFallbackFingerprint: false,
      };
    }

    const existing = this.db.prepare(
      `SELECT local_sequence, event_kind, source_raw_payload_sha256, payload_sha256 FROM inbound_events
       WHERE organization_id=? AND account_id=? AND dedupe_key=?`,
    ).get(input.organizationId, input.accountId, dedupeKey) as
      | {
          local_sequence: number;
          event_kind: string;
          source_raw_payload_sha256: string;
          payload_sha256: string;
        }
      | undefined;

    if (existing) {
      // An exact replay is a duplicate; the same stable id with different bytes
      // is a conflict that must not be acknowledged as if it were the same event.
      const conflict = existing.event_kind !== input.eventKind
        ? "STABLE_ID_KIND_CHANGED"
        : existing.payload_sha256 !== payloadSha256 ||
            existing.source_raw_payload_sha256 !== rawPayloadSha256
          ? "STABLE_ID_PAYLOAD_CHANGED"
          : null;
      if (conflict !== null) {
        this.quarantine(input, dedupeKey, payloadSha256, conflict, nowMs);
        if (fallbackFingerprintValue !== null) {
          this.incrementTelemetry("FALLBACK_FINGERPRINT_COLLISION", nowMs);
        }
        return {
          outcome: fallbackFingerprintValue === null ? "MAPPING_CONFLICT" : "PAYLOAD_CONFLICT",
          localSequence: null,
          dedupeKey,
          usedFallbackFingerprint: fallbackFingerprintValue !== null,
          reason: conflict,
        };
      }
      if (fallbackFingerprintValue !== null) {
        this.incrementTelemetry("FALLBACK_FINGERPRINT_REPLAY", nowMs);
      }
      return {
        outcome: "DUPLICATE",
        localSequence: existing.local_sequence,
        dedupeKey,
        usedFallbackFingerprint: fallbackFingerprintValue !== null,
      };
    }

    const storedRawPayload = pressure.minimalEnvelopeOnly
      ? { version: 1 as const, pressureState: "MINIMAL_ONLY" as const }
      : input.rawPayload;
    const storedRawPayloadSha256 = payloadChecksum(storedRawPayload);
    const estimatedBytes = Buffer.byteLength(canonicalJson({
      rawPayload: storedRawPayload,
      normalizedPayload: input.normalizedPayload,
      mediaManifest: input.mediaManifest ?? [],
    }), "utf8") + 4_096;
    const hasCapacity = () => this.usedBytes() + estimatedBytes + this.reserveBytes <= this.maxBytes;
    if (!hasCapacity()) {
      this.recordGap("SPOOL_FULL", nowMs);
      return {
        outcome: "INTAKE_STOPPED",
        localSequence: null,
        dedupeKey,
        usedFallbackFingerprint: fallbackFingerprintValue !== null,
        reason: "SPOOL_FULL",
      };
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!hasCapacity()) {
        this.db.exec("ROLLBACK");
        this.recordGap("SPOOL_FULL", nowMs);
        return {
          outcome: "INTAKE_STOPPED",
          localSequence: null,
          dedupeKey,
          usedFallbackFingerprint: fallbackFingerprintValue !== null,
          reason: "SPOOL_FULL",
        };
      }
      this.db.prepare(
        `INSERT INTO inbound_events (
           organization_id, account_id, cell_id, session_generation, event_kind,
           provider_event_id, provider_message_id, provider_conversation_id,
           provider_sender_id, provider_target, provider_event_type,
           source_timestamp, callback_received_at, fallback_fingerprint, dedupe_key,
           raw_payload, source_raw_payload_sha256, raw_payload_sha256,
           normalized_payload, payload_sha256, media_manifest,
           media_byte_state, ack_state, retry_count, received_at_ms, updated_at_ms
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'PENDING','SPOOLED',0,?,?)`,
      ).run(
        input.organizationId,
        input.accountId,
        input.cellId,
        sessionGeneration,
        input.eventKind,
        input.providerEventId,
        input.providerMessageId,
        providerConversationId,
        providerSenderId,
        canonicalJson(providerTarget),
        providerEventType,
        sourceTimestamp,
        callbackReceivedAt,
        fallbackFingerprintValue,
        dedupeKey,
        canonicalJson(storedRawPayload),
        rawPayloadSha256,
        storedRawPayloadSha256,
        canonicalJson(input.normalizedPayload),
        payloadSha256,
        canonicalJson(input.mediaManifest ?? []),
        nowMs,
        nowMs,
      );

      if (quarantinedMappingId !== null) {
        const changed = this.db.prepare(
          `UPDATE stable_id_mappings
           SET provider_event_id=COALESCE(provider_event_id,?),
               provider_message_id=COALESCE(provider_message_id,?),
               raw_payload_sha256=CASE WHEN raw_payload_sha256='' THEN ? ELSE raw_payload_sha256 END,
               mapping_state='PENDING'
           WHERE mapping_id=? AND mapping_state='QUARANTINED'`,
        ).run(
          input.providerEventId,
          input.providerMessageId,
          rawPayloadSha256,
          quarantinedMappingId,
        );
        if (Number(changed.changes) !== 1) throw new Error("quarantined stable ID mapping changed");
      } else if (input.providerEventId !== null || input.providerMessageId !== null) {
        this.db.prepare(
          `INSERT INTO stable_id_mappings (
             organization_id, account_id, provider_event_id, provider_message_id,
             event_kind, payload_sha256, raw_payload_sha256, created_at_ms
           ) VALUES (?,?,?,?,?,?,?,?)`,
        ).run(
          input.organizationId,
          input.accountId,
          input.providerEventId,
          input.providerMessageId,
          input.eventKind,
          payloadSha256,
          rawPayloadSha256,
          nowMs,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* SQLite may auto-rollback SQLITE_FULL. */ }
      const code = (error as NodeJS.ErrnoException).code;
      const message = error instanceof Error ? error.message : "";
      if (code === "ENOSPC" || code === "SQLITE_FULL" || /database or disk is full/iu.test(message)) {
        this.recordGap("STORAGE_FULL", nowMs);
        return {
          outcome: "INTAKE_STOPPED",
          localSequence: null,
          dedupeKey,
          usedFallbackFingerprint: fallbackFingerprintValue !== null,
          reason: "STORAGE_FULL",
        };
      }
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
    const rawPayloadSha256 = payloadChecksum(input.rawPayload);
    this.db.prepare(
      `INSERT OR IGNORE INTO inbound_events (
         organization_id, account_id, cell_id, session_generation, event_kind,
         provider_event_id, provider_message_id, provider_conversation_id,
         provider_sender_id, provider_target, provider_event_type,
         source_timestamp, callback_received_at, fallback_fingerprint, dedupe_key,
         raw_payload, source_raw_payload_sha256, raw_payload_sha256,
         normalized_payload, payload_sha256, media_manifest,
         media_byte_state, ack_state, retry_count, quarantine_reason,
         received_at_ms, updated_at_ms
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'PENDING','QUARANTINED',0,?,?,?)`,
    ).run(
      input.organizationId,
      input.accountId,
      input.cellId,
      input.sessionGeneration ?? 0,
      input.eventKind,
      input.providerEventId,
      input.providerMessageId,
      input.providerConversationId ?? input.providerMessageId ?? input.providerEventId ?? "unknown",
      input.providerSenderId ?? input.providerMessageId ?? input.providerEventId ?? "unknown",
      canonicalJson(input.providerTarget ?? {
        kind: "PEER",
        providerId: input.providerMessageId ?? input.providerEventId ?? "unknown",
      }),
      input.providerEventType ?? input.eventKind,
      input.sourceTimestamp ?? new Date(
        input.providerTimestamp < 10_000_000_000 ? input.providerTimestamp * 1_000 : input.providerTimestamp,
      ).toISOString(),
      input.callbackReceivedAt ?? new Date(nowMs).toISOString(),
      dedupeKey.startsWith("fingerprint:") ? dedupeKey.slice("fingerprint:".length) : null,
      `quarantine:${dedupeKey}:${reason}:${payloadSha256}:${rawPayloadSha256}`,
      canonicalJson(input.rawPayload),
      rawPayloadSha256,
      rawPayloadSha256,
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
    const events: SpooledEvent[] = [];
    for (const row of rows) {
      let providerTarget: SpooledEvent["providerTarget"];
      try {
        providerTarget = parseProviderTarget(row.provider_target);
      } catch {
        this.quarantineStoredRow(Number(row.local_sequence), "CORRUPT_PROVIDER_TARGET");
        continue;
      }
      events.push({
      localSequence: Number(row.local_sequence),
      organizationId: String(row.organization_id),
      accountId: String(row.account_id),
      cellId: String(row.cell_id),
      sessionGeneration: Number(row.session_generation),
      eventKind: String(row.event_kind),
      providerEventId: row.provider_event_id === null ? null : String(row.provider_event_id),
      providerMessageId: row.provider_message_id === null
        ? null
        : String(row.provider_message_id),
      providerConversationId: String(row.provider_conversation_id),
      providerSenderId: String(row.provider_sender_id),
      providerTarget,
      providerEventType: String(row.provider_event_type),
      sourceTimestamp: String(row.source_timestamp),
      callbackReceivedAt: String(row.callback_received_at),
      rawEnvelope: JSON.parse(String(row.raw_payload)),
      rawEnvelopeSha256: String(row.raw_payload_sha256),
      payloadSha256: String(row.payload_sha256),
      normalizedPayload: JSON.parse(String(row.normalized_payload)),
      mediaManifest: JSON.parse(String(row.media_manifest)),
      retryCount: Number(row.retry_count),
      });
    }
    return events;
  }

  /**
   * Verifies the stored checksum. A row whose bytes no longer hash to the stored
   * digest is quarantined rather than replayed into Supabase.
   */
  verifyChecksums(): { verified: number; quarantined: number } {
    const rows = this.db.prepare(
      `SELECT local_sequence, raw_payload, raw_payload_sha256,
              normalized_payload, payload_sha256, media_manifest, provider_target FROM inbound_events
       WHERE ack_state IN ('SPOOLED','SENDING')`,
    ).all() as Record<string, unknown>[];
    let quarantined = 0;
    for (const row of rows) {
      try {
        parseProviderTarget(row.provider_target);
      } catch {
        this.quarantineStoredRow(Number(row.local_sequence), "CORRUPT_PROVIDER_TARGET");
        quarantined += 1;
        continue;
      }
      let normalizedActual: string;
      let rawActual: string;
      try {
        normalizedActual = payloadChecksum(JSON.parse(String(row.normalized_payload)));
        rawActual = payloadChecksum(JSON.parse(String(row.raw_payload)));
        const manifest = JSON.parse(String(row.media_manifest));
        if (!Array.isArray(manifest)) throw new TypeError("media manifest is not an array");
      } catch {
        this.quarantineStoredRow(Number(row.local_sequence), "CORRUPT_JSON");
        quarantined += 1;
        continue;
      }
      if (
        normalizedActual !== String(row.payload_sha256) ||
        rawActual !== String(row.raw_payload_sha256)
      ) {
        this.quarantineStoredRow(Number(row.local_sequence), "CHECKSUM_MISMATCH");
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
  }, ownerToken: string, nowMs = this.now()): boolean {
    const complete = acknowledgement.eventCommitted &&
      acknowledgement.messageCommitted &&
      acknowledgement.conversationCommitted &&
      acknowledgement.automationDecisionOrWorkMarker;
    if (!complete) return false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(
        `SELECT organization_id,account_id,provider_event_id,provider_message_id
         FROM inbound_events
         WHERE local_sequence=? AND ack_state='SENDING' AND claim_owner_token=?
           AND claim_expires_at_ms>?`,
      ).get(localSequence, ownerToken, nowMs) as {
        organization_id: string;
        account_id: string;
        provider_event_id: string | null;
        provider_message_id: string | null;
      } | undefined;
      if (row === undefined) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db.prepare(
        `UPDATE stable_id_mappings SET mapping_state='CANONICAL_COMMITTED'
         WHERE organization_id=? AND account_id=? AND (
           (? IS NOT NULL AND provider_event_id=?) OR
           (? IS NOT NULL AND provider_message_id=?)
         )`,
      ).run(
        row.organization_id,
        row.account_id,
        row.provider_event_id,
        row.provider_event_id,
        row.provider_message_id,
        row.provider_message_id,
      );
      const deleted = this.db.prepare(
        `DELETE FROM inbound_events
         WHERE local_sequence=? AND ack_state='SENDING' AND claim_owner_token=?
           AND claim_expires_at_ms>?`,
      ).run(localSequence, ownerToken, nowMs);
      if (Number(deleted.changes) !== 1) throw new Error("inbound acknowledgement changed");
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* SQLite may have already rolled back. */ }
      throw error;
    }
  }

  claimForDrain(
    localSequences: readonly number[],
    ownerToken: string,
    leaseMs: number,
    nowMs = this.now(),
  ): number {
    if (localSequences.length === 0) return 0;
    if (ownerToken.length < 1 || ownerToken.length > 128 || ownerToken !== ownerToken.trim()) {
      throw new TypeError("spool claim owner token is invalid");
    }
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 10 * 60_000) {
      throw new RangeError("spool claim lease is invalid");
    }
    const expiresAtMs = nowMs + leaseMs;
    if (!Number.isSafeInteger(expiresAtMs)) throw new RangeError("spool claim expiry is invalid");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let changed = 0;
      const statement = this.db.prepare(
        `UPDATE inbound_events
         SET ack_state='SENDING', claim_owner_token=?, claim_expires_at_ms=?, updated_at_ms=?
         WHERE local_sequence=? AND ack_state='SPOOLED'`,
      );
      for (const sequence of localSequences) {
        changed += Number(statement.run(ownerToken, expiresAtMs, nowMs, sequence).changes);
      }
      if (changed !== localSequences.length) {
        this.db.exec("ROLLBACK");
        return 0;
      }
      this.db.exec("COMMIT");
      return changed;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  reclaimExpiredClaims(nowMs = this.now()): number {
    const result = this.db.prepare(
      `UPDATE inbound_events
       SET ack_state='SPOOLED', claim_owner_token=NULL, claim_expires_at_ms=NULL,
           retry_count=retry_count+1, updated_at_ms=?
       WHERE ack_state='SENDING' AND claim_expires_at_ms<=?`,
    ).run(nowMs, nowMs);
    return Number(result.changes);
  }

  releaseForRetry(
    localSequences: readonly number[],
    ownerToken: string,
    nowMs = this.now(),
  ): number {
    const statement = this.db.prepare(
      `UPDATE inbound_events
       SET ack_state='SPOOLED', claim_owner_token=NULL, claim_expires_at_ms=NULL,
           retry_count=retry_count+1, updated_at_ms=?
       WHERE local_sequence=? AND ack_state='SENDING' AND claim_owner_token=?
         AND claim_expires_at_ms>?`,
    );
    let changed = 0;
    for (const sequence of localSequences) {
      changed += Number(statement.run(nowMs, sequence, ownerToken, nowMs).changes);
    }
    return changed;
  }

  ensureMediaCheckpoint(
    localSequence: number,
    manifestIndex: number,
    mediaId: string,
    nowMs = this.now(),
  ): InboundMediaCheckpoint {
    if (!Number.isSafeInteger(localSequence) || localSequence < 1 ||
      !Number.isSafeInteger(manifestIndex) || manifestIndex < 0 ||
      mediaId.length === 0) throw new TypeError("media checkpoint identity is invalid");
    this.db.prepare(
      `INSERT OR IGNORE INTO inbound_media_checkpoints
       (local_sequence,manifest_index,media_id,state,updated_at_ms)
       VALUES (?,?,?,'PENDING',?)`,
    ).run(localSequence, manifestIndex, mediaId, nowMs);
    const checkpoint = this.mediaCheckpoint(localSequence, manifestIndex);
    if (checkpoint === null || checkpoint.mediaId !== mediaId) {
      throw new Error("media checkpoint mapping changed");
    }
    return checkpoint;
  }

  mediaCheckpoint(localSequence: number, manifestIndex: number): InboundMediaCheckpoint | null {
    const row = this.db.prepare(
      `SELECT * FROM inbound_media_checkpoints WHERE local_sequence=? AND manifest_index=?`,
    ).get(localSequence, manifestIndex) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    let signedTicket: unknown | null;
    let gatewayReceipt: unknown | null;
    try {
      signedTicket = row.signed_ticket === null ? null : JSON.parse(String(row.signed_ticket));
      gatewayReceipt = row.gateway_receipt === null ? null : JSON.parse(String(row.gateway_receipt));
    } catch {
      this.db.prepare(
        `UPDATE inbound_events
         SET ack_state='QUARANTINED', quarantine_reason='CORRUPT_MEDIA_CHECKPOINT_JSON',
             claim_owner_token=NULL, claim_expires_at_ms=NULL, updated_at_ms=?
         WHERE local_sequence=?`,
      ).run(this.now(), localSequence);
      throw new SpoolCorruptionError(localSequence);
    }
    return {
      localSequence: Number(row.local_sequence),
      manifestIndex: Number(row.manifest_index),
      mediaId: String(row.media_id),
      state: String(row.state) as InboundMediaCheckpointState,
      ticketJti: row.ticket_jti === null ? null : String(row.ticket_jti),
      signedTicket,
      gatewayReceipt,
      receiptHash: row.receipt_hash === null ? null : String(row.receipt_hash),
      retryCount: Number(row.retry_count),
      terminalReason: row.terminal_reason === null ? null : String(row.terminal_reason),
    };
  }

  storeMediaTicket(
    localSequence: number,
    manifestIndex: number,
    ticketJti: string,
    signedTicket: unknown,
    nowMs = this.now(),
  ): void {
    const encoded = canonicalJson(signedTicket);
    const result = this.db.prepare(
      `UPDATE inbound_media_checkpoints
       SET state='TICKET_ISSUED',ticket_jti=?,signed_ticket=?,updated_at_ms=?
       WHERE local_sequence=? AND manifest_index=? AND state IN ('PENDING','TICKET_ISSUED')
         AND (ticket_jti IS NULL OR (ticket_jti=? AND signed_ticket=?))`,
    ).run(ticketJti, encoded, nowMs, localSequence, manifestIndex, ticketJti, encoded);
    if (Number(result.changes) !== 1) throw new Error("media ticket checkpoint conflict");
  }

  storeMediaReceipt(
    localSequence: number,
    manifestIndex: number,
    gatewayReceipt: unknown,
    receiptHash: string,
    nowMs = this.now(),
  ): void {
    const encoded = canonicalJson(gatewayReceipt);
    const result = this.db.prepare(
      `UPDATE inbound_media_checkpoints
       SET state='RECEIPT_STORED',gateway_receipt=?,receipt_hash=?,updated_at_ms=?
       WHERE local_sequence=? AND manifest_index=? AND state IN ('TICKET_ISSUED','RECEIPT_STORED')
         AND (receipt_hash IS NULL OR (receipt_hash=? AND gateway_receipt=?))`,
    ).run(encoded, receiptHash, nowMs, localSequence, manifestIndex, receiptHash, encoded);
    if (Number(result.changes) !== 1) throw new Error("media receipt checkpoint conflict");
  }

  resetMediaTicket(
    localSequence: number,
    manifestIndex: number,
    expectedTicketJti: string,
    nowMs = this.now(),
  ): void {
    const result = this.db.prepare(
      `UPDATE inbound_media_checkpoints
       SET state='PENDING',ticket_jti=NULL,signed_ticket=NULL,updated_at_ms=?
       WHERE local_sequence=? AND manifest_index=? AND state='TICKET_ISSUED'
         AND ticket_jti=? AND gateway_receipt IS NULL AND receipt_hash IS NULL`,
    ).run(nowMs, localSequence, manifestIndex, expectedTicketJti);
    if (Number(result.changes) !== 1) throw new Error("media ticket reset conflict");
  }

  markMediaTerminal(
    localSequence: number,
    manifestIndex: number,
    state: "AVAILABLE" | "SKIPPED" | "FAILED",
    reason: string | null,
    nowMs = this.now(),
  ): void {
    const result = this.db.prepare(
      `UPDATE inbound_media_checkpoints SET state=?,terminal_reason=?,updated_at_ms=?
       WHERE local_sequence=? AND manifest_index=? AND state NOT IN ('AVAILABLE','SKIPPED','FAILED')`,
    ).run(state, reason, nowMs, localSequence, manifestIndex);
    if (Number(result.changes) === 0) {
      const existing = this.mediaCheckpoint(localSequence, manifestIndex);
      if (existing?.state !== state) throw new Error("media terminal checkpoint conflict");
    }
  }

  incrementMediaRetry(localSequence: number, manifestIndex: number, nowMs = this.now()): number {
    const result = this.db.prepare(
      `UPDATE inbound_media_checkpoints SET retry_count=retry_count+1,updated_at_ms=?
       WHERE local_sequence=? AND manifest_index=? AND state NOT IN ('AVAILABLE','SKIPPED','FAILED')
       RETURNING retry_count`,
    ).get(nowMs, localSequence, manifestIndex) as { retry_count: number } | undefined;
    if (result === undefined) throw new Error("media retry checkpoint is terminal");
    return Number(result.retry_count);
  }

  quarantineDrained(
    localSequence: number,
    reason: string,
    nowMs = this.now(),
    ownerToken?: string,
  ): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(
        `SELECT organization_id,account_id,provider_event_id,provider_message_id,dedupe_key
         FROM inbound_events
         WHERE local_sequence=?
           AND ((ack_state='SPOOLED' AND ? IS NULL)
             OR (ack_state='SENDING' AND claim_owner_token=? AND claim_expires_at_ms>?))`,
      ).get(localSequence, ownerToken ?? null, ownerToken ?? null, nowMs) as {
        organization_id: string;
        account_id: string;
        provider_event_id: string | null;
        provider_message_id: string | null;
        dedupe_key: string;
      } | undefined;
      if (row === undefined) {
        this.db.exec("ROLLBACK");
        return false;
      }
      const result = this.db.prepare(
        `UPDATE inbound_events
         SET ack_state='QUARANTINED', quarantine_reason=?, claim_owner_token=NULL,
             claim_expires_at_ms=NULL, dedupe_key=?, updated_at_ms=?
         WHERE local_sequence=?`,
      ).run(
        reason,
        `quarantine:drained:${localSequence}:${row.dedupe_key}`,
        nowMs,
        localSequence,
      );
      if (Number(result.changes) !== 1) throw new Error("drained quarantine changed");
      this.db.prepare(
        `UPDATE stable_id_mappings SET mapping_state='QUARANTINED'
         WHERE organization_id=? AND account_id=? AND (
           (? IS NOT NULL AND provider_event_id=?) OR
           (? IS NOT NULL AND provider_message_id=?)
         )`,
      ).run(
        row.organization_id,
        row.account_id,
        row.provider_event_id,
        row.provider_event_id,
        row.provider_message_id,
        row.provider_message_id,
      );
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* SQLite may have already rolled back. */ }
      throw error;
    }
  }

  runtimeCommandSnapshot(runtimeCommandId: string): RuntimeCommandJournalSnapshot | null {
    const row = this.db.prepare(
      "SELECT * FROM runtime_command_journal WHERE runtime_command_id=?",
    ).get(runtimeCommandId) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    let payload: unknown;
    let publishPayload: unknown | null;
    let result: unknown | null;
    try {
      payload = JSON.parse(String(row.payload_json));
      publishPayload = row.publish_json === null ? null : JSON.parse(String(row.publish_json));
      result = row.result_json === null ? null : JSON.parse(String(row.result_json));
    } catch {
      throw new Error("runtime command journal contains corrupt JSON");
    }
    return {
      runtimeCommandId: String(row.runtime_command_id),
      commandKind: String(row.command_kind) as "QR_LOGIN" | "DISCONNECT",
      claimGeneration: Number(row.claim_generation),
      claimToken: String(row.claim_token),
      payloadHash: String(row.payload_hash),
      sourceSessionGeneration: Number(row.source_session_generation),
      targetSessionGeneration: Number(row.target_session_generation),
      sourceConnectionGeneration: Number(row.source_connection_generation),
      targetConnectionGeneration: Number(row.target_connection_generation),
      expectedFencingToken: Number(row.expected_fencing_token),
      leaseExpiresAt: String(row.lease_expires_at),
      effectDeadlineAt: row.effect_deadline_at === null ? null : String(row.effect_deadline_at),
      payload,
      stage: String(row.stage) as RuntimeCommandJournalStage,
      publishPayload,
      result,
      resultHash: row.result_hash === null ? null : String(row.result_hash),
      sealedReason: row.sealed_reason === null ? null : String(row.sealed_reason),
    };
  }

  recordRuntimeCommandClaim(claim: RuntimeCommandJournalClaim, nowMs = this.now()): RuntimeCommandJournalSnapshot {
    const payloadJson = canonicalJson(claim.payload);
    this.db.prepare(
      `INSERT OR IGNORE INTO runtime_command_journal (
         runtime_command_id,command_kind,claim_generation,claim_token,payload_hash,
         source_session_generation,target_session_generation,source_connection_generation,
         target_connection_generation,expected_fencing_token,lease_expires_at,effect_deadline_at,
         payload_json,stage,updated_at_ms
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'CLAIMED',?)`,
    ).run(
      claim.runtimeCommandId,
      claim.commandKind,
      claim.claimGeneration,
      claim.claimToken,
      claim.payloadHash,
      claim.sourceSessionGeneration,
      claim.targetSessionGeneration,
      claim.sourceConnectionGeneration,
      claim.targetConnectionGeneration,
      claim.expectedFencingToken,
      claim.leaseExpiresAt,
      claim.effectDeadlineAt,
      payloadJson,
      nowMs,
    );
    const existing = this.runtimeCommandSnapshot(claim.runtimeCommandId);
    if (
      existing === null || existing.commandKind !== claim.commandKind ||
      existing.claimGeneration !== claim.claimGeneration || existing.claimToken !== claim.claimToken ||
      existing.payloadHash !== claim.payloadHash ||
      existing.sourceSessionGeneration !== claim.sourceSessionGeneration ||
      existing.targetSessionGeneration !== claim.targetSessionGeneration ||
      existing.sourceConnectionGeneration !== claim.sourceConnectionGeneration ||
      existing.targetConnectionGeneration !== claim.targetConnectionGeneration ||
      existing.expectedFencingToken !== claim.expectedFencingToken ||
      canonicalJson(existing.payload) !== payloadJson
    ) throw new Error("runtime command journal binding conflict");
    this.db.prepare(
      `UPDATE runtime_command_journal
       SET lease_expires_at=?, effect_deadline_at=COALESCE(?,effect_deadline_at), updated_at_ms=?
       WHERE runtime_command_id=? AND claim_generation=? AND claim_token=?`,
    ).run(
      claim.leaseExpiresAt,
      claim.effectDeadlineAt,
      nowMs,
      claim.runtimeCommandId,
      claim.claimGeneration,
      claim.claimToken,
    );
    return this.runtimeCommandSnapshot(claim.runtimeCommandId)!;
  }

  transitionRuntimeCommand(
    runtimeCommandId: string,
    expectedStages: readonly RuntimeCommandJournalStage[],
    stage: RuntimeCommandJournalStage,
    updates: {
      effectDeadlineAt?: string | null;
      publishPayload?: unknown;
      result?: unknown;
      resultHash?: string;
      sealedReason?: string;
    } = {},
    nowMs = this.now(),
  ): RuntimeCommandJournalSnapshot {
    const current = this.runtimeCommandSnapshot(runtimeCommandId);
    if (current === null) throw new Error("runtime command journal entry is missing");
    if (current.stage === stage) return current;
    if (!expectedStages.includes(current.stage)) throw new Error("runtime command journal transition conflict");
    const publishJson = updates.publishPayload === undefined
      ? null
      : canonicalJson(updates.publishPayload);
    const resultJson = updates.result === undefined ? null : canonicalJson(updates.result);
    const changed = this.db.prepare(
      `UPDATE runtime_command_journal
       SET stage=?,effect_deadline_at=COALESCE(?,effect_deadline_at),
           publish_json=COALESCE(?,publish_json),result_json=COALESCE(?,result_json),
           result_hash=COALESCE(?,result_hash),sealed_reason=COALESCE(?,sealed_reason),updated_at_ms=?
       WHERE runtime_command_id=? AND stage=?`,
    ).run(
      stage,
      updates.effectDeadlineAt ?? null,
      publishJson,
      resultJson,
      updates.resultHash ?? null,
      updates.sealedReason ?? null,
      nowMs,
      runtimeCommandId,
      current.stage,
    );
    if (Number(changed.changes) !== 1) throw new Error("runtime command journal transition conflict");
    return this.runtimeCommandSnapshot(runtimeCommandId)!;
  }

  runtimeCommandStarts(limit = 8): RuntimeCommandJournalSnapshot[] {
    const rows = this.db.prepare(
      `SELECT runtime_command_id FROM runtime_command_journal
       WHERE stage='CLAIMED' ORDER BY updated_at_ms,runtime_command_id LIMIT ?`,
    ).all(limit) as Array<{ runtime_command_id: string }>;
    return rows.map((row) => this.runtimeCommandSnapshot(row.runtime_command_id)!);
  }

  runtimeCommandRenewals(nowMs: number, remainingMs = 30_000, limit = 8): RuntimeCommandJournalSnapshot[] {
    const rows = this.db.prepare(
      // LOGIN_WAITING and STALE_LOGIN_CLEANUP_PENDING are deliberately NOT renewed.
      //
      // By the time a command reaches either stage the server has already finished
      // with it: publishing the QR sets state='ACKNOWLEDGED' and nulls both
      // claim_token_hash and lease_expires_at. Renewing sends a start-marker for an
      // ACKNOWLEDGED command, which the facade answers with
      // `raise ... errcode='40001'` - and that rolls back the WHOLE heartbeat
      // transaction, not just the marker. Because the journal's leaseExpiresAt is
      // frozen at that point, the filter below matched forever, so every heartbeat
      // from then on was destroyed by a command that had already succeeded.
      //
      // That is the "exactly one QR per bridge start" failure: the first code worked,
      // and no later command could ever be leased again.
      `SELECT runtime_command_id FROM runtime_command_journal
       WHERE stage IN (
         'START_AUTHORIZED','EFFECT_INTENT','PROVIDER_RECORDED','QR_MATERIAL_READY',
         'PUBLISH_PENDING','RESULT_PENDING'
       ) ORDER BY updated_at_ms,runtime_command_id`,
    ).all() as Array<{ runtime_command_id: string }>;
    return rows
      .map((row) => this.runtimeCommandSnapshot(row.runtime_command_id)!)
      .filter((snapshot) => Date.parse(snapshot.leaseExpiresAt) - nowMs <= remainingMs)
      .slice(0, limit);
  }

  runtimeCommandResults(limit = 8): RuntimeCommandJournalSnapshot[] {
    const rows = this.db.prepare(
      `SELECT runtime_command_id FROM runtime_command_journal
       WHERE stage='RESULT_PENDING' ORDER BY updated_at_ms,runtime_command_id LIMIT ?`,
    ).all(limit) as Array<{ runtime_command_id: string }>;
    return rows.map((row) => this.runtimeCommandSnapshot(row.runtime_command_id)!);
  }

  runtimeCommandReconciliations(limit = 8): RuntimeCommandJournalSnapshot[] {
    const rows = this.db.prepare(
      `SELECT runtime_command_id FROM runtime_command_journal
       WHERE stage IN ('EFFECT_INTENT','QR_MATERIAL_READY','PUBLISH_PENDING','LOGIN_WAITING',
                       'STALE_LOGIN_CLEANUP_PENDING')
       ORDER BY updated_at_ms,runtime_command_id LIMIT ?`,
    ).all(limit) as Array<{ runtime_command_id: string }>;
    return rows.map((row) => this.runtimeCommandSnapshot(row.runtime_command_id)!);
  }

  hasBlockingRuntimeDisconnect(): boolean {
    const row = this.db.prepare(
      `SELECT 1 AS present FROM runtime_command_journal
       WHERE command_kind='DISCONNECT' AND stage NOT IN ('SERVER_ACCEPTED','SEALED') LIMIT 1`,
    ).get() as { present: number } | undefined;
    return row !== undefined;
  }

  hasNewerRuntimeDisconnect(sourceSessionGeneration: number): boolean {
    const row = this.db.prepare(
      `SELECT 1 AS present FROM runtime_command_journal
       WHERE command_kind='DISCONNECT' AND target_session_generation>? LIMIT 1`,
    ).get(sourceSessionGeneration) as { present: number } | undefined;
    return row !== undefined;
  }

  acceptRuntimeCommandResult(
    runtimeCommandId: string,
    resultHash: string,
    adoptSessionGeneration: number | null,
    nowMs = this.now(),
  ): RuntimeCommandJournalSnapshot {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.runtimeCommandSnapshot(runtimeCommandId);
      if (
        current === null || current.stage !== "RESULT_PENDING" ||
        current.resultHash !== resultHash
      ) throw new Error("runtime command result acknowledgement conflict");
      const changed = this.db.prepare(
        `UPDATE runtime_command_journal SET stage='SERVER_ACCEPTED',updated_at_ms=?
         WHERE runtime_command_id=? AND stage='RESULT_PENDING' AND result_hash=?`,
      ).run(nowMs, runtimeCommandId, resultHash);
      if (Number(changed.changes) !== 1) throw new Error("runtime command result acknowledgement conflict");
      if (adoptSessionGeneration !== null) {
        this.db.prepare(
          `INSERT INTO runtime_local_state(name,integer_value,updated_at_ms)
           VALUES ('local_session_generation',?,?)
           ON CONFLICT(name) DO UPDATE SET integer_value=excluded.integer_value,
             updated_at_ms=excluded.updated_at_ms
           WHERE runtime_local_state.integer_value<=excluded.integer_value`,
        ).run(adoptSessionGeneration, nowMs);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.runtimeCommandSnapshot(runtimeCommandId)!;
  }

  runtimeLocalSessionGeneration(): number | null {
    const row = this.db.prepare(
      "SELECT integer_value FROM runtime_local_state WHERE name='local_session_generation'",
    ).get() as { integer_value: number } | undefined;
    return row === undefined ? null : Number(row.integer_value);
  }

  countByState(state: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS count FROM inbound_events WHERE ack_state=?",
    ).get(state) as { count: number };
    return Number(row.count);
  }

  expiredCount(nowMs = this.now()): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS count FROM inbound_events WHERE received_at_ms <= ?",
    ).get(nowMs - this.maxAgeMs) as { count: number };
    return Number(row.count);
  }
}
