import type { CellWorkloadBinding } from "../runtime-api/workload-auth.js";
import { payloadChecksum } from "../spool/checksum.js";
import { SqliteSpool } from "../spool/sqlite-spool.js";

const EVENT_KINDS = new Set([
  "MESSAGE", "REACTION", "DELIVERY_RECEIPT", "SEEN", "TYPING", "MEMBERSHIP", "OTHER",
]);
const MEDIA_KINDS = new Set(["IMAGE", "VIDEO", "AUDIO", "FILE", "STICKER", "OTHER"]);

export interface InboundMediaManifestEntryV1 {
  version: 1;
  index: number;
  providerMediaId: string | null;
  kind: "IMAGE" | "VIDEO" | "AUDIO" | "FILE" | "STICKER" | "OTHER";
  mime: string | null;
  byteLength: number | null;
  providerChecksum: string | null;
  fetchRef: string | null;
  byteState: "PENDING";
}

export interface InboundEnvelopeV1 {
  version: 1;
  organizationId: string;
  accountId: string;
  cellId: string;
  sessionGeneration: number;
  providerEventId: string | null;
  providerMessageId: string | null;
  eventKind: "MESSAGE" | "REACTION" | "DELIVERY_RECEIPT" | "SEEN" | "TYPING" | "MEMBERSHIP" | "OTHER";
  providerConversationId: string;
  providerSenderId: string;
  providerTarget: { kind: "PEER" | "SALES_GROUP"; providerId: string };
  providerEventType: string;
  sourceTimestamp: string;
  callbackReceivedAt: string;
  rawEnvelope: unknown;
  rawEnvelopeSha256: string;
  normalized: {
    text: string | null;
    replyToProviderMessageId: string | null;
    mediaManifest: InboundMediaManifestEntryV1[];
  };
  normalizedSha256: string;
}

export type InboundBridgeAcknowledgementV1 =
  | Readonly<{
      version: 1;
      status: "committed";
      durability: Readonly<{ journalMode: "WAL"; synchronous: "FULL" }>;
    }>
  | Readonly<{ version: 1; status: "duplicate" | "collision" }>;

export class InboundEnvelopeError extends TypeError {
  readonly code = "INBOUND_ENVELOPE_INVALID";
}

export class InboundBindingError extends Error {
  readonly code = "INBOUND_BINDING_MISMATCH";
}

export class InboundIntakeStoppedError extends Error {
  readonly code = "INBOUND_INTAKE_STOPPED";

  constructor() {
    super("durable inbound intake is stopped");
    this.name = "InboundIntakeStoppedError";
  }
}

function invalid(message: string): never {
  throw new InboundEnvelopeError(message);
}

function record(value: unknown, name: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${name} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${name} has an unsafe prototype`);
  const candidate = value as Record<string, unknown>;
  const actual = Object.keys(candidate).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalid(`${name} has unexpected fields`);
  }
  return candidate;
}

function string(value: unknown, name: string, max = 255): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || value.length > max) {
    invalid(`${name} is invalid`);
  }
  return value;
}

function nullableString(value: unknown, name: string, max = 255): string | null {
  return value === null ? null : string(value, name, max);
}

function integer(value: unknown, name: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) invalid(`${name} is invalid`);
  return value as number;
}

function timestamp(value: unknown, name: string): string {
  const result = string(value, name, 64);
  const parsed = Date.parse(result);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== result) invalid(`${name} is invalid`);
  return result;
}

function hash(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) invalid(`${name} is invalid`);
  return value;
}

function providerSha256(value: unknown, name: string): string | null {
  if (value === null) return null;
  const checksum = string(value, name);
  const explicit = /^sha256:([0-9a-f]{64})$/iu.exec(checksum);
  if (explicit?.[1]) return explicit[1].toLowerCase();
  if (/^[0-9a-f]{64}$/iu.test(checksum)) return checksum.toLowerCase();
  return null;
}

function snapshotEnvelope(value: unknown): InboundEnvelopeV1 {
  const envelope = record(value, "inbound envelope", [
    "version", "organizationId", "accountId", "cellId", "sessionGeneration",
    "providerEventId", "providerMessageId", "eventKind", "providerConversationId",
    "providerSenderId", "providerTarget", "providerEventType", "sourceTimestamp",
    "callbackReceivedAt", "rawEnvelope", "rawEnvelopeSha256", "normalized",
    "normalizedSha256",
  ]);
  if (envelope.version !== 1) invalid("inbound envelope version is invalid");
  if (!EVENT_KINDS.has(String(envelope.eventKind))) invalid("event kind is invalid");
  const target = record(envelope.providerTarget, "provider target", ["kind", "providerId"]);
  if (target.kind !== "PEER" && target.kind !== "SALES_GROUP") invalid("provider target kind is invalid");
  const normalized = record(envelope.normalized, "normalized envelope", [
    "text", "replyToProviderMessageId", "mediaManifest",
  ]);
  if (normalized.text !== null && typeof normalized.text !== "string") invalid("normalized text is invalid");
  if (!Array.isArray(normalized.mediaManifest) || normalized.mediaManifest.length > 20) {
    invalid("media manifest is invalid");
  }
  const mediaManifestForHash: unknown[] = [];
  const mediaManifest: InboundMediaManifestEntryV1[] = normalized.mediaManifest.map((value, index) => {
    const item = record(value, `media manifest ${index}`, [
      "version", "index", "providerMediaId", "kind", "mime", "byteLength",
      "providerChecksum", "fetchRef", "byteState",
    ]);
    if (item.version !== 1 || item.index !== index || item.byteState !== "PENDING") {
      invalid(`media manifest ${index} identity is invalid`);
    }
    if (!MEDIA_KINDS.has(String(item.kind))) invalid(`media manifest ${index} kind is invalid`);
    const byteLength = item.byteLength === null ? null : integer(item.byteLength, `media manifest ${index} byteLength`);
    if (byteLength !== null && byteLength > 50 * 1024 * 1024) invalid(`media manifest ${index} is too large`);
    const providerChecksumInput = item.providerChecksum === null
      ? null
      : string(item.providerChecksum, `media manifest ${index} checksum`);
    const snapshot = {
      version: 1 as const,
      index,
      providerMediaId: nullableString(item.providerMediaId, `media manifest ${index} providerMediaId`),
      kind: item.kind as InboundMediaManifestEntryV1["kind"],
      mime: nullableString(item.mime, `media manifest ${index} mime`),
      byteLength,
      fetchRef: nullableString(item.fetchRef, `media manifest ${index} fetchRef`, 2_048),
      byteState: "PENDING" as const,
    };
    mediaManifestForHash.push({ ...snapshot, providerChecksum: providerChecksumInput });
    return {
      ...snapshot,
      providerChecksum: providerSha256(providerChecksumInput, `media manifest ${index} checksum`),
    };
  });
  const rawEnvelopeSha256 = hash(envelope.rawEnvelopeSha256, "raw envelope hash");
  const normalizedSha256 = hash(envelope.normalizedSha256, "normalized hash");
  const normalizedSnapshot = {
    text: normalized.text as string | null,
    replyToProviderMessageId: nullableString(
      normalized.replyToProviderMessageId,
      "replyToProviderMessageId",
    ),
    mediaManifest: mediaManifestForHash,
  };
  if (payloadChecksum(envelope.rawEnvelope) !== rawEnvelopeSha256) invalid("raw envelope hash mismatch");
  if (payloadChecksum(normalizedSnapshot) !== normalizedSha256) invalid("normalized hash mismatch");

  const normalizedCanonical = {
    ...normalizedSnapshot,
    mediaManifest,
  };

  return {
    version: 1,
    organizationId: string(envelope.organizationId, "organizationId"),
    accountId: string(envelope.accountId, "accountId"),
    cellId: string(envelope.cellId, "cellId"),
    sessionGeneration: integer(envelope.sessionGeneration, "sessionGeneration"),
    providerEventId: nullableString(envelope.providerEventId, "providerEventId"),
    providerMessageId: nullableString(envelope.providerMessageId, "providerMessageId"),
    eventKind: envelope.eventKind as InboundEnvelopeV1["eventKind"],
    providerConversationId: string(envelope.providerConversationId, "providerConversationId"),
    providerSenderId: string(envelope.providerSenderId, "providerSenderId"),
    providerTarget: {
      kind: target.kind,
      providerId: string(target.providerId, "providerTarget.providerId"),
    } as InboundEnvelopeV1["providerTarget"],
    providerEventType: string(envelope.providerEventType, "providerEventType", 128),
    sourceTimestamp: timestamp(envelope.sourceTimestamp, "sourceTimestamp"),
    callbackReceivedAt: timestamp(envelope.callbackReceivedAt, "callbackReceivedAt"),
    rawEnvelope: envelope.rawEnvelope,
    rawEnvelopeSha256,
    normalized: normalizedCanonical,
    normalizedSha256,
  };
}

function assertBinding(
  envelope: InboundEnvelopeV1,
  expected: CellWorkloadBinding,
  authenticated: CellWorkloadBinding,
): void {
  const fields: Array<keyof CellWorkloadBinding> = [
    "organizationId", "accountId", "cellId", "sessionGeneration", "fencingToken",
  ];
  for (const field of fields) {
    if (authenticated[field] !== expected[field]) {
      throw new InboundBindingError(`${field} workload binding mismatch`);
    }
  }
  if (envelope.organizationId !== expected.organizationId) {
    throw new InboundBindingError("organization envelope binding mismatch");
  }
  if (envelope.accountId !== expected.accountId) {
    throw new InboundBindingError("account envelope binding mismatch");
  }
  if (envelope.cellId !== expected.cellId) throw new InboundBindingError("cell envelope binding mismatch");
  if (envelope.sessionGeneration !== expected.sessionGeneration) {
    throw new InboundBindingError("session envelope binding mismatch");
  }
}

export function createInboundController(options: {
  spool: SqliteSpool;
  binding: CellWorkloadBinding;
}) {
  const expected = Object.freeze({ ...options.binding });
  return Object.freeze({
    commit(value: unknown, authenticatedBinding: CellWorkloadBinding): InboundBridgeAcknowledgementV1 {
      const envelope = snapshotEnvelope(value);
      assertBinding(envelope, expected, authenticatedBinding);
      const result = options.spool.append({
        organizationId: envelope.organizationId,
        accountId: envelope.accountId,
        cellId: envelope.cellId,
        sessionGeneration: envelope.sessionGeneration,
        eventKind: envelope.eventKind,
        providerEventId: envelope.providerEventId,
        providerMessageId: envelope.providerMessageId,
        providerConversationId: envelope.providerConversationId,
        providerSenderId: envelope.providerSenderId,
        providerTarget: envelope.providerTarget,
        providerEventType: envelope.providerEventType,
        sourceTimestamp: envelope.sourceTimestamp,
        callbackReceivedAt: envelope.callbackReceivedAt,
        providerTimestamp: Date.parse(envelope.sourceTimestamp),
        rawPayload: envelope.rawEnvelope,
        rawPayloadSha256: envelope.rawEnvelopeSha256,
        normalizedPayload: envelope.normalized,
        normalizedPayloadSha256: payloadChecksum(envelope.normalized),
        mediaManifest: envelope.normalized.mediaManifest,
      });
      if (result.outcome === "SPOOLED") {
        return Object.freeze({
          version: 1,
          status: "committed",
          durability: Object.freeze({ journalMode: "WAL", synchronous: "FULL" }),
        });
      }
      if (result.outcome === "DUPLICATE") return Object.freeze({ version: 1, status: "duplicate" });
      if (result.outcome === "INTAKE_STOPPED") throw new InboundIntakeStoppedError();
      return Object.freeze({ version: 1, status: "collision" });
    },
    ready(): boolean {
      return options.spool.pressure().ready && options.spool.expiredCount() === 0 &&
        options.spool.gapEvidence() === null;
    },
  });
}

export type InboundController = ReturnType<typeof createInboundController>;
