import { randomBytes } from "node:crypto";

import { canonicalJson } from "./checksum.js";
import { SpoolCorruptionError, SqliteSpool, type SpooledEvent } from "./sqlite-spool.js";

export const INBOUND_BATCH_MAX_EVENTS = 100;
export const INBOUND_BATCH_MAX_BYTES = 256 * 1024;
const LOCAL_CLAIM_LEASE_MS = 5 * 60_000;

interface RuntimeApi {
  post<T = unknown>(path: string, body: unknown, signal?: AbortSignal): Promise<T>;
}

export interface InboundMediaMappingV1 {
  manifestIndex: number;
  mediaId: string;
}

type InboundBatchResult =
  | { index: number; status: "ACCEPTED"; media: InboundMediaMappingV1[] }
  | { index: number; status: "DUPLICATE"; media: InboundMediaMappingV1[] }
  | { index: number; status: "QUARANTINED"; collisionKind: string };

export class InboundDrainError extends Error {
  readonly code: string;

  constructor(code: string, message = "durable inbound drain failed") {
    super(message);
    this.name = "InboundDrainError";
    this.code = code;
  }
}

function exactRecord(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InboundDrainError("INBOUND_RESULT_INVALID", `${name} is invalid`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new InboundDrainError("INBOUND_RESULT_INVALID", `${name} fields are invalid`);
  }
  return record;
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new InboundDrainError("INBOUND_RESULT_INVALID", `${name} is invalid`);
  }
  return value as number;
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InboundDrainError("INBOUND_RESULT_INVALID", `${name} is invalid`);
  }
  return value;
}

function mediaMappings(value: unknown): InboundMediaMappingV1[] {
  if (!Array.isArray(value) || value.length > 20) {
    throw new InboundDrainError("INBOUND_RESULT_INVALID", "inbound media mapping is invalid");
  }
  return value.map((entry, index) => {
    const item = exactRecord(entry, ["manifestIndex", "mediaId"], `media[${index}]`);
    const manifestIndex = nonNegativeInteger(item.manifestIndex, `media[${index}].manifestIndex`);
    if (manifestIndex !== index) {
      throw new InboundDrainError("INBOUND_RESULT_INVALID", "inbound media mapping is unstable");
    }
    return { manifestIndex, mediaId: nonEmptyString(item.mediaId, `media[${index}].mediaId`) };
  });
}

function parseBatchResult(value: unknown, eventCount: number): InboundBatchResult[] {
  const envelope = exactRecord(value, [
    "version", "requestId", "accepted", "deduplicated", "quarantined", "results",
  ], "inbound batch result");
  if (envelope.version !== 1) throw new InboundDrainError("INBOUND_RESULT_INVALID");
  nonEmptyString(envelope.requestId, "requestId");
  const accepted = nonNegativeInteger(envelope.accepted, "accepted");
  const deduplicated = nonNegativeInteger(envelope.deduplicated, "deduplicated");
  const quarantined = nonNegativeInteger(envelope.quarantined, "quarantined");
  if (!Array.isArray(envelope.results) || envelope.results.length !== eventCount) {
    throw new InboundDrainError("INBOUND_RESULT_INVALID", "inbound result count mismatch");
  }
  const results: InboundBatchResult[] = [];
  const seen = new Set<number>();
  let acceptedActual = 0;
  let duplicateActual = 0;
  let quarantinedActual = 0;
  for (const value of envelope.results) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new InboundDrainError("INBOUND_RESULT_INVALID");
    }
    const status = (value as Record<string, unknown>).status;
    if (status === "ACCEPTED") {
      const item = exactRecord(value, [
        "index", "status", "inboundEventId", "messageId", "decisionId", "decisionKind",
        "noSendReason", "workItemId", "media",
      ], "accepted inbound result");
      const index = nonNegativeInteger(item.index, "result index");
      nonEmptyString(item.inboundEventId, "inboundEventId");
      nonEmptyString(item.messageId, "messageId");
      nonEmptyString(item.decisionId, "decisionId");
      if (item.decisionKind !== "NO_SEND" && item.decisionKind !== "WORK_ELIGIBLE") {
        throw new InboundDrainError("INBOUND_RESULT_INVALID", "decisionKind is invalid");
      }
      if (item.noSendReason !== null && typeof item.noSendReason !== "string") {
        throw new InboundDrainError("INBOUND_RESULT_INVALID", "noSendReason is invalid");
      }
      if (item.workItemId !== null && typeof item.workItemId !== "string") {
        throw new InboundDrainError("INBOUND_RESULT_INVALID", "workItemId is invalid");
      }
      if (
        (item.decisionKind === "WORK_ELIGIBLE" && typeof item.workItemId !== "string") ||
        (item.decisionKind === "NO_SEND" && item.workItemId !== null)
      ) throw new InboundDrainError("INBOUND_RESULT_INVALID", "decision result is inconsistent");
      results.push({ index, status, media: mediaMappings(item.media) });
      acceptedActual += 1;
    } else if (status === "DUPLICATE") {
      const item = exactRecord(value, ["index", "status", "inboundEventId", "media"], "duplicate inbound result");
      const index = nonNegativeInteger(item.index, "result index");
      nonEmptyString(item.inboundEventId, "inboundEventId");
      results.push({ index, status, media: mediaMappings(item.media) });
      duplicateActual += 1;
    } else if (status === "QUARANTINED") {
      const item = exactRecord(value, ["index", "status", "collisionKind"], "quarantined inbound result");
      const index = nonNegativeInteger(item.index, "result index");
      if (![
        "CROSS_KIND", "PAIR_MISMATCH", "PAYLOAD_MISMATCH", "FINGERPRINT_COLLISION",
      ].includes(String(item.collisionKind))) {
        throw new InboundDrainError("INBOUND_RESULT_INVALID", "collisionKind is invalid");
      }
      results.push({ index, status, collisionKind: String(item.collisionKind) });
      quarantinedActual += 1;
    } else {
      throw new InboundDrainError("INBOUND_RESULT_INVALID", "inbound result status is invalid");
    }
    const result = results.at(-1)!;
    if (result.index >= eventCount || seen.has(result.index)) {
      throw new InboundDrainError("INBOUND_RESULT_INVALID", "inbound result index is invalid");
    }
    seen.add(result.index);
  }
  if (
    accepted !== acceptedActual || deduplicated !== duplicateActual ||
    quarantined !== quarantinedActual || accepted + deduplicated + quarantined !== eventCount
  ) throw new InboundDrainError("INBOUND_RESULT_INVALID", "inbound result counters mismatch");
  return results.sort((left, right) => left.index - right.index);
}

function runtimeEvent(event: SpooledEvent) {
  return {
    version: 1 as const,
    eventKind: event.eventKind,
    providerEventId: event.providerEventId,
    providerMessageId: event.providerMessageId,
    providerConversationId: event.providerConversationId,
    providerSenderId: event.providerSenderId,
    providerTarget: event.providerTarget,
    providerEventType: event.providerEventType,
    sourceTimestamp: event.sourceTimestamp,
    callbackReceivedAt: event.callbackReceivedAt,
    rawEnvelope: event.rawEnvelope,
    rawEnvelopeSha256: event.rawEnvelopeSha256,
    normalized: event.normalizedPayload,
    normalizedSha256: event.payloadSha256,
  };
}

function createBatch(events: readonly SpooledEvent[]) {
  const first = events[0];
  if (!first) return null;
  return {
    version: 1 as const,
    organizationId: first.organizationId,
    accountId: first.accountId,
    cellId: first.cellId,
    sessionGeneration: first.sessionGeneration,
    events: events.map(runtimeEvent),
  };
}

function selectBatch(spool: SqliteSpool): SpooledEvent[] {
  const candidates = spool.pending(INBOUND_BATCH_MAX_EVENTS);
  const first = candidates[0];
  if (!first) return [];
  const selected: SpooledEvent[] = [];
  for (const candidate of candidates) {
    if (
      candidate.organizationId !== first.organizationId ||
      candidate.accountId !== first.accountId ||
      candidate.cellId !== first.cellId ||
      candidate.sessionGeneration !== first.sessionGeneration
    ) break;
    const proposed = [...selected, candidate];
    const batch = createBatch(proposed)!;
    if (Buffer.byteLength(canonicalJson(batch), "utf8") > INBOUND_BATCH_MAX_BYTES) break;
    selected.push(candidate);
  }
  return selected;
}

export function createSpoolDrainWorker(options: {
  spool: SqliteSpool;
  runtime: RuntimeApi;
  now?: () => number;
  processMedia?: (
    event: SpooledEvent,
    media: readonly InboundMediaMappingV1[],
    signal?: AbortSignal,
  ) => Promise<void>;
}) {
  const now = options.now ?? Date.now;
  return Object.freeze({
    async drainOnce(signal?: AbortSignal): Promise<{
      attempted: number;
      acknowledged: number;
      quarantined: number;
    }> {
      if (signal?.aborted) throw signal.reason;
      options.spool.reclaimExpiredClaims(now());
      options.spool.verifyChecksums();
      const events = selectBatch(options.spool);
      if (events.length === 0) {
        const oversized = options.spool.pending(1)[0];
        if (oversized) {
          options.spool.quarantineDrained(oversized.localSequence, "INBOUND_BATCH_TOO_LARGE", now());
          return { attempted: 1, acknowledged: 0, quarantined: 1 };
        }
        return { attempted: 0, acknowledged: 0, quarantined: 0 };
      }
      const sequences = events.map((event) => event.localSequence);
      const ownerToken = randomBytes(32).toString("hex");
      if (options.spool.claimForDrain(sequences, ownerToken, LOCAL_CLAIM_LEASE_MS, now()) !== sequences.length) {
        throw new InboundDrainError("INBOUND_CLAIM_RACE");
      }
      const batch = createBatch(events)!;
      let response: unknown;
      try {
        response = await options.runtime.post("/v1/inbound/batch", batch, signal);
      } catch {
        options.spool.releaseForRetry(sequences, ownerToken, now());
        throw new InboundDrainError("INBOUND_RUNTIME_UNAVAILABLE");
      }
      let results: InboundBatchResult[];
      try {
        results = parseBatchResult(response, events.length);
      } catch (error) {
        options.spool.releaseForRetry(sequences, ownerToken, now());
        if (error instanceof InboundDrainError) throw error;
        throw new InboundDrainError("INBOUND_RESULT_INVALID");
      }
      let acknowledged = 0;
      let quarantined = 0;
      let mediaRetry = false;
      for (const result of results) {
        const event = events[result.index]!;
        if (result.status === "QUARANTINED") {
          options.spool.quarantineDrained(event.localSequence, result.collisionKind, now(), ownerToken);
          quarantined += 1;
        } else {
          try {
            if (result.media.length > 0 && options.processMedia === undefined) {
              throw new InboundDrainError("INBOUND_MEDIA_PROCESSOR_UNAVAILABLE");
            }
            await options.processMedia?.(event, result.media, signal);
          } catch (error) {
            if (error instanceof SpoolCorruptionError) {
              quarantined += 1;
              continue;
            }
            options.spool.releaseForRetry([event.localSequence], ownerToken, now());
            mediaRetry = true;
            continue;
          }
          if (options.spool.acknowledge(event.localSequence, {
            eventCommitted: true,
            messageCommitted: true,
            conversationCommitted: true,
            automationDecisionOrWorkMarker: true,
          }, ownerToken, now())) acknowledged += 1;
        }
      }
      if (mediaRetry) {
        throw new InboundDrainError("INBOUND_MEDIA_RETRY", "inbound media processing failed");
      }
      return { attempted: events.length, acknowledged, quarantined };
    },
  });
}

export type SpoolDrainWorker = ReturnType<typeof createSpoolDrainWorker>;
