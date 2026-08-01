import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

import { canonicalJson } from "../spool/checksum.js";
import type {
  InboundMediaCheckpoint,
  SqliteSpool,
  SpooledEvent,
} from "../spool/sqlite-spool.js";
import type { InboundMediaMappingV1 } from "../spool/drain-worker.js";
import {
  withFetchedInboundMedia,
  type BrokeredMediaFetch,
} from "./inbound-fetch.js";

interface RuntimeApi {
  post<T = unknown>(path: string, body: unknown, signal?: AbortSignal): Promise<T>;
}

type RuntimeTicket = {
  jti: string;
  organizationId: string;
  accountId: string;
  cellId: string;
  sha256: string;
  objectKey: string;
  contentType: string;
  contentLength: number;
  credentialGeneration: number;
  leaseGeneration: number;
  fencingToken: number;
  sessionGeneration: number;
  receiptSigningKeyGeneration: number;
  signature: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/u;
const GATEWAY_RECEIPT_MAX_BYTES = 64 * 1024;
const AUTOMATIC_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const AUTOMATIC_IMAGE_MIMES = new Set(["image/jpeg", "image/png"]);
const MEDIA_RECEIPT_DOMAIN = "ihome-openclaw-media-upload-receipt-v1\0";

type MediaCheckpointStore = Pick<SqliteSpool,
  | "ensureMediaCheckpoint"
  | "storeMediaTicket"
  | "storeMediaReceipt"
  | "resetMediaTicket"
  | "markMediaTerminal"
  | "incrementMediaRetry"
>;

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  return value as Record<string, unknown>;
}

function exact(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  const item = record(value, name);
  const actual = Object.keys(item).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${name} fields are invalid`);
  }
  return item;
}

function uuid(value: unknown, name: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function sha256(value: unknown, name: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(`${name} is invalid`);
  return value as number;
}

function encodeTicket(ticket: unknown): string {
  return Buffer.from(canonicalJson(ticket), "utf8").toString("base64url");
}

function gatewayObjectUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
    url.pathname !== "/v1/object"
  ) throw new TypeError("media gateway URL is invalid");
  return url;
}

function parseTicket(value: unknown, event: SpooledEvent, mediaId: string, media: {
  mime: string;
  bytes: number;
  sha256: string;
}): { signedTicket: Record<string, unknown>; ticket: RuntimeTicket } {
  const response = exact(value, ["version", "ticketId", "ticketHash", "expiresAt", "state", "ticket"], "upload ticket response");
  if (response.version !== 1 || response.state !== "ISSUED") throw new TypeError("upload ticket response is invalid");
  const ticketId = uuid(response.ticketId, "ticketId");
  sha256(response.ticketHash, "ticketHash");
  nonEmptyString(response.expiresAt, "expiresAt");
  const ticket = exact(response.ticket, [
    "version", "aud", "operation", "subject", "jti", "organizationId", "accountId", "objectKey",
    "sha256", "contentType", "contentLength", "sessionGeneration", "gatewayKeyGeneration", "iat", "exp",
    "cellId", "credentialGeneration", "leaseGeneration", "fencingToken", "receiptSigningKeyGeneration",
    "signature",
  ], "upload ticket");
  if (
    ticket.version !== 1 || ticket.aud !== "openclaw-media-gateway" || ticket.operation !== "PUT" ||
    ticket.subject !== "RUNTIME" || ticket.jti !== ticketId || ticket.organizationId !== event.organizationId ||
    ticket.accountId !== event.accountId || ticket.cellId !== event.cellId || ticket.sha256 !== media.sha256 ||
    ticket.contentType !== media.mime || ticket.contentLength !== media.bytes ||
    typeof ticket.objectKey !== "string" || !ticket.objectKey.includes(`/media/${mediaId}/`) ||
    !Number.isSafeInteger(ticket.credentialGeneration) || (ticket.credentialGeneration as number) < 1 ||
    !Number.isSafeInteger(ticket.leaseGeneration) || (ticket.leaseGeneration as number) < 1 ||
    !Number.isSafeInteger(ticket.fencingToken) || (ticket.fencingToken as number) < 1 ||
    !Number.isSafeInteger(ticket.sessionGeneration) || (ticket.sessionGeneration as number) < 0 ||
    !Number.isSafeInteger(ticket.receiptSigningKeyGeneration) ||
      (ticket.receiptSigningKeyGeneration as number) < 1 ||
    typeof ticket.signature !== "string" || !SIGNATURE.test(ticket.signature)
  ) throw new TypeError("upload ticket is not bound to media bytes");
  return {
    signedTicket: ticket,
    ticket: {
      jti: ticketId,
      organizationId: event.organizationId,
      accountId: event.accountId,
      cellId: event.cellId,
      sha256: media.sha256,
      objectKey: ticket.objectKey as string,
      contentType: media.mime,
      contentLength: media.bytes,
      credentialGeneration: ticket.credentialGeneration as number,
      leaseGeneration: ticket.leaseGeneration as number,
      fencingToken: ticket.fencingToken as number,
      sessionGeneration: ticket.sessionGeneration as number,
      receiptSigningKeyGeneration: ticket.receiptSigningKeyGeneration as number,
      signature: ticket.signature as string,
    },
  };
}

function parseReceipt(value: unknown, ticket: RuntimeTicket, mediaId: string): Record<string, unknown> {
  const receipt = exact(value, [
    "version", "receiptKind", "receiptId", "organizationId", "accountId", "cellId", "mediaId", "objectKey",
    "sha256", "contentType", "contentLength", "uploadTicketJti", "credentialGeneration", "leaseGeneration",
    "fencingToken", "sessionGeneration", "objectVersionOrEtag", "storedAt", "gatewaySigningKeyGeneration", "signature",
  ], "gateway upload receipt");
  if (
    receipt.version !== 1 || receipt.receiptKind !== "MEDIA_UPLOAD" || uuid(receipt.receiptId, "receiptId") !== receipt.receiptId ||
    receipt.organizationId !== ticket.organizationId || receipt.accountId !== ticket.accountId || receipt.cellId !== ticket.cellId ||
    receipt.mediaId !== mediaId || receipt.objectKey !== ticket.objectKey || receipt.sha256 !== ticket.sha256 || receipt.contentType !== ticket.contentType ||
    receipt.contentLength !== ticket.contentLength || receipt.uploadTicketJti !== ticket.jti ||
    receipt.credentialGeneration !== ticket.credentialGeneration || receipt.leaseGeneration !== ticket.leaseGeneration ||
    receipt.fencingToken !== ticket.fencingToken || receipt.sessionGeneration !== ticket.sessionGeneration ||
    receipt.gatewaySigningKeyGeneration !== ticket.receiptSigningKeyGeneration ||
    typeof receipt.signature !== "string" || !SIGNATURE.test(receipt.signature)
  ) throw new TypeError("gateway upload receipt is not bound to ticket");
  return receipt;
}

function ticketFromCheckpoint(
  checkpoint: InboundMediaCheckpoint,
  event: SpooledEvent,
  mediaId: string,
  expectedMime: string,
  expectedBytes: number,
): { signedTicket: Record<string, unknown>; ticket: RuntimeTicket } {
  if (checkpoint.ticketJti === null || checkpoint.signedTicket === null) {
    throw new TypeError("media ticket checkpoint is incomplete");
  }
  const signed = record(checkpoint.signedTicket, "checkpoint upload ticket");
  return parseTicket({
    version: 1,
    ticketId: checkpoint.ticketJti,
    ticketHash: "0".repeat(64),
    expiresAt: "checkpoint",
    state: "ISSUED",
    ticket: signed,
  }, event, mediaId, {
    mime: expectedMime,
    bytes: expectedBytes,
    sha256: sha256(signed.sha256, "checkpoint ticket sha256"),
  });
}

function mediaReceiptHash(receipt: unknown): string {
  return createHash("sha256")
    .update(MEDIA_RECEIPT_DOMAIN, "utf8")
    .update(canonicalJson(receipt), "utf8")
    .digest("hex");
}

function parseFinalize(value: unknown, mediaId: string, expectedReceiptHash: string): void {
  const result = exact(value, ["version", "mediaId", "byteState", "receiptHash", "idempotentReplay"], "media finalize response");
  if (
    result.version !== 1 || result.mediaId !== mediaId || result.byteState !== "AVAILABLE" ||
    result.receiptHash !== expectedReceiptHash || typeof result.idempotentReplay !== "boolean"
  ) throw new TypeError("media finalize response is invalid");
}

function ephemeralCheckpointStore(): MediaCheckpointStore {
  const checkpoints = new Map<string, InboundMediaCheckpoint>();
  const key = (localSequence: number, manifestIndex: number) => `${localSequence}:${manifestIndex}`;
  const requireCheckpoint = (localSequence: number, manifestIndex: number) => {
    const checkpoint = checkpoints.get(key(localSequence, manifestIndex));
    if (checkpoint === undefined) throw new Error("media checkpoint is missing");
    return checkpoint;
  };
  return {
    ensureMediaCheckpoint(localSequence, manifestIndex, mediaId) {
      const checkpointKey = key(localSequence, manifestIndex);
      const existing = checkpoints.get(checkpointKey);
      if (existing !== undefined) {
        if (existing.mediaId !== mediaId) throw new Error("media checkpoint mapping changed");
        return existing;
      }
      const created: InboundMediaCheckpoint = {
        localSequence,
        manifestIndex,
        mediaId,
        state: "PENDING",
        ticketJti: null,
        signedTicket: null,
        gatewayReceipt: null,
        receiptHash: null,
        retryCount: 0,
        terminalReason: null,
      };
      checkpoints.set(checkpointKey, created);
      return created;
    },
    storeMediaTicket(localSequence, manifestIndex, ticketJti, signedTicket) {
      Object.assign(requireCheckpoint(localSequence, manifestIndex), {
        state: "TICKET_ISSUED",
        ticketJti,
        signedTicket,
      });
    },
    storeMediaReceipt(localSequence, manifestIndex, gatewayReceipt, receiptHash) {
      Object.assign(requireCheckpoint(localSequence, manifestIndex), {
        state: "RECEIPT_STORED",
        gatewayReceipt,
        receiptHash,
      });
    },
    resetMediaTicket(localSequence, manifestIndex, expectedTicketJti) {
      const checkpoint = requireCheckpoint(localSequence, manifestIndex);
      if (checkpoint.state !== "TICKET_ISSUED" || checkpoint.ticketJti !== expectedTicketJti) {
        throw new Error("media ticket reset conflict");
      }
      Object.assign(checkpoint, {
        state: "PENDING",
        ticketJti: null,
        signedTicket: null,
      });
    },
    markMediaTerminal(localSequence, manifestIndex, state, terminalReason) {
      Object.assign(requireCheckpoint(localSequence, manifestIndex), { state, terminalReason });
    },
    incrementMediaRetry(localSequence, manifestIndex) {
      const checkpoint = requireCheckpoint(localSequence, manifestIndex);
      checkpoint.retryCount += 1;
      return checkpoint.retryCount;
    },
  };
}

async function withDeadline<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
  callerSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  const onCallerAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) onCallerAbort();
  else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = globalThis.setTimeout(() => {
      controller.abort(new Error("media operation deadline exceeded"));
      reject(new TypeError("media operation deadline exceeded"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timer !== undefined) globalThis.clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

async function readGatewayReceipt(response: Response, signal: AbortSignal): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^(?:0|[1-9]\d*)$/u.test(declared) || Number(declared) > GATEWAY_RECEIPT_MAX_BYTES)) {
    await response.body?.cancel().catch(() => undefined);
    throw new TypeError("gateway upload receipt exceeds byte cap");
  }
  if (response.body === null) throw new TypeError("gateway upload receipt is invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const aborted = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), aborted]);
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > GATEWAY_RECEIPT_MAX_BYTES) {
        throw new TypeError("gateway upload receipt exceeds byte cap");
      }
      chunks.push(chunk.value);
    }
  } finally {
    if (total > GATEWAY_RECEIPT_MAX_BYTES || signal.aborted) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total));
    return JSON.parse(text);
  } catch {
    throw new TypeError("gateway upload receipt is invalid JSON");
  }
}

export type BrokeredMediaEgress = BrokeredMediaFetch;

type RuntimeInboundMediaProcessorOptions = {
  runtime: RuntimeApi;
  gatewayUrl: string;
  allowlistedHosts: readonly string[];
  tempDirectory: string;
  timeoutMs?: number;
  checkpoints?: MediaCheckpointStore;
  mediaPrefetchAllowed?: () => boolean;
  egress: BrokeredMediaEgress;
};

export function createRuntimeInboundMediaProcessor(
  options: RuntimeInboundMediaProcessorOptions,
): (
  event: SpooledEvent,
  mappings: readonly InboundMediaMappingV1[],
  signal?: AbortSignal,
) => Promise<void> {
  const gatewayUrl = gatewayObjectUrl(options.gatewayUrl);
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new RangeError("media processor timeout is invalid");
  }
  const upload = async (url: URL, init: RequestInit) => await options.egress.fetch(url, init);
  const checkpoints = options.checkpoints ?? ephemeralCheckpointStore();
  return async (event, mappings, signal) => {
    if (mappings.length !== event.mediaManifest.length) {
      throw new TypeError("Runtime media mappings do not cover the inbound manifest");
    }
    for (const mapping of mappings) {
      let checkpoint = checkpoints.ensureMediaCheckpoint(
        event.localSequence,
        mapping.manifestIndex,
        mapping.mediaId,
      );
      if (["AVAILABLE", "SKIPPED", "FAILED"].includes(checkpoint.state)) continue;
      const entry = event.mediaManifest[mapping.manifestIndex];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        checkpoints.markMediaTerminal(
          event.localSequence,
          mapping.manifestIndex,
          "SKIPPED",
          "MANIFEST_UNAVAILABLE",
        );
        continue;
      }
      const manifest = entry as Record<string, unknown>;
      if (manifest.index !== mapping.manifestIndex) {
        throw new TypeError("Runtime media mapping references the wrong manifest entry");
      }
      const expectedBytes = Number.isSafeInteger(manifest.byteLength) ? manifest.byteLength as number : null;
      const expectedMime = typeof manifest.mime === "string" && manifest.mime.length > 0 ? manifest.mime : null;
      const expectedSha256 = typeof manifest.providerChecksum === "string" &&
          SHA256.test(manifest.providerChecksum)
        ? manifest.providerChecksum
        : null;
      const fetchRef = typeof manifest.fetchRef === "string" && manifest.fetchRef.length > 0
        ? manifest.fetchRef
        : null;
      if (options.mediaPrefetchAllowed?.() === false) {
        throw new Error("media prefetch deferred by spool pressure");
      }
      const skipReason = manifest.kind !== "IMAGE"
        ? "UNSUPPORTED_MEDIA_KIND"
        : expectedBytes === null || expectedBytes < 1 || expectedMime === null || fetchRef === null
          ? "MEDIA_UNFETCHABLE"
          : !AUTOMATIC_IMAGE_MIMES.has(expectedMime)
            ? "UNSUPPORTED_IMAGE_MIME"
          : expectedBytes > AUTOMATIC_IMAGE_MAX_BYTES
            ? "IMAGE_TOO_LARGE_FOR_AUTOMATIC_FETCH"
            : null;
      if (skipReason !== null) {
        checkpoints.markMediaTerminal(
          event.localSequence,
          mapping.manifestIndex,
          "SKIPPED",
          skipReason,
        );
        continue;
      }
      const bytesExpected = expectedBytes as number;
      const mimeExpected = expectedMime as string;
      const url = fetchRef as string;
      try {
        if (checkpoint.state === "RECEIPT_STORED") {
          const issued = ticketFromCheckpoint(checkpoint, event, mapping.mediaId, mimeExpected, bytesExpected);
          if (checkpoint.gatewayReceipt === null || checkpoint.receiptHash === null) {
            throw new TypeError("media receipt checkpoint is incomplete");
          }
          const receipt = parseReceipt(checkpoint.gatewayReceipt, issued.ticket, mapping.mediaId);
          const receiptHash = mediaReceiptHash(receipt);
          if (receiptHash !== checkpoint.receiptHash) throw new TypeError("media receipt checkpoint hash mismatch");
          parseFinalize(await options.runtime.post("/v1/media/upload-complete", {
            version: 1,
            mediaId: mapping.mediaId,
            gatewayReceipt: receipt,
          }, signal), mapping.mediaId, receiptHash);
          checkpoints.markMediaTerminal(event.localSequence, mapping.manifestIndex, "AVAILABLE", null);
          continue;
        }
      const common = {
        url,
        allowlistedHosts: options.allowlistedHosts,
        expectedMime: mimeExpected,
        expectedBytes: bytesExpected,
        ...(expectedSha256 === null ? {} : { expectedSha256 }),
        tempDirectory: options.tempDirectory,
        timeoutMs,
        ...(signal === undefined ? {} : { signal }),
      };
      const fetchOptions = { ...common, egress: options.egress };
      await withFetchedInboundMedia(fetchOptions, async (media) => {
        const requestTicket = async () => parseTicket(
           await options.runtime.post("/v1/media/upload-ticket", {
             version: 1,
             mediaId: mapping.mediaId,
             operation: "PUT",
             verifiedSha256: media.sha256,
             contentType: media.mime,
             contentLength: media.bytes,
           }, signal),
          event,
          mapping.mediaId,
          media,
        );
        const reusedCheckpointTicket = checkpoint.state === "TICKET_ISSUED";
        let issued = reusedCheckpointTicket
          ? ticketFromCheckpoint(checkpoint, event, mapping.mediaId, media.mime, media.bytes)
          : await requestTicket();
        if (checkpoint.state === "PENDING") {
          checkpoints.storeMediaTicket(
            event.localSequence,
            mapping.manifestIndex,
            issued.ticket.jti,
            issued.signedTicket,
          );
          checkpoint = { ...checkpoint, state: "TICKET_ISSUED", ticketJti: issued.ticket.jti, signedTicket: issued.signedTicket };
        }
        const bytes = await readFile(media.path, signal === undefined ? undefined : { signal });
        if (bytes.byteLength !== media.bytes) throw new TypeError("inbound media bytes changed before upload");
        const uploadTicket = async (): Promise<unknown | null> => await withDeadline(timeoutMs, async (uploadSignal) => {
          const response = await upload(gatewayUrl, {
            method: "PUT",
            headers: {
              "content-type": media.mime,
              "content-length": String(media.bytes),
              "x-openclaw-media-ticket": encodeTicket(issued.signedTicket),
            },
            body: bytes,
            signal: uploadSignal,
          });
          const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
          if (response.status === 410 && contentType === "application/json") {
            const failure = exact(
              await readGatewayReceipt(response, uploadSignal),
              ["error"],
              "media gateway upload failure",
            );
            const error = exact(failure.error, ["code"], "media gateway upload error");
            if (error.code === "TICKET_EXPIRED_NO_WORK") {
              return null;
            }
            throw new TypeError("media gateway upload failure is invalid");
          }
          if (response.status !== 200 && response.status !== 201) throw new TypeError("media gateway upload failed");
          if (contentType !== "application/json") {
            throw new TypeError("media gateway receipt is invalid");
          }
          return await readGatewayReceipt(response, uploadSignal);
        }, signal);
        let receiptValue = await uploadTicket();
        if (receiptValue === null) {
          if (!reusedCheckpointTicket) {
            throw new TypeError("fresh media upload ticket expired before admission");
          }
          checkpoints.resetMediaTicket(
            event.localSequence,
            mapping.manifestIndex,
            issued.ticket.jti,
          );
          issued = await requestTicket();
          checkpoints.storeMediaTicket(
            event.localSequence,
            mapping.manifestIndex,
            issued.ticket.jti,
            issued.signedTicket,
          );
          checkpoint = {
            ...checkpoint,
            state: "TICKET_ISSUED",
            ticketJti: issued.ticket.jti,
            signedTicket: issued.signedTicket,
          };
          receiptValue = await uploadTicket();
          if (receiptValue === null) {
            throw new TypeError("refreshed media upload ticket expired before admission");
          }
        }
        const receipt = parseReceipt(receiptValue, issued.ticket, mapping.mediaId);
        const receiptHash = mediaReceiptHash(receipt);
        checkpoints.storeMediaReceipt(
          event.localSequence,
          mapping.manifestIndex,
          receipt,
          receiptHash,
        );
        parseFinalize(await options.runtime.post("/v1/media/upload-complete", {
          version: 1,
          mediaId: mapping.mediaId,
          gatewayReceipt: receipt,
        }, signal), mapping.mediaId, receiptHash);
        checkpoints.markMediaTerminal(event.localSequence, mapping.manifestIndex, "AVAILABLE", null);
      });
      } catch (error) {
        checkpoints.incrementMediaRetry(event.localSequence, mapping.manifestIndex);
        throw error;
      }
    }
  };
}
