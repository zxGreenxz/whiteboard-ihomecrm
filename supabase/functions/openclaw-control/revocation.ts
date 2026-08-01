import { base64UrlEncode, canonicalJson, sha256Hex, utf8 } from "../_shared/openclaw/crypto.ts";
import type { DisconnectRevocationV1 } from "./handler.ts";

export interface RevocationClientOptions {
  gatewayUrl: string;
  privateKeyPkcs8B64: string;
  keyGeneration: number;
  fetch?: typeof fetch;
  nowEpochSeconds?: () => number;
  nonce?: () => string;
  timeoutMs?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_ACKNOWLEDGEMENT_BYTES = 16_384;
const NONCE_REUSE_WINDOW_SECONDS = 120;
const MAX_RECENT_NONCES = 65_536;
const TRUSTED_GATEWAY_ORIGIN = "https://openclaw-media.chillhome.io.vn";
const REVOCATION_PATH = "/v1/internal/revoke-generation";
const ED25519_PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
  0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

function decodeBase64(value: string): Uint8Array {
  if (
    value.length === 0 || value !== value.trim() || value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)
  ) throw new Error("OpenClaw revocation key is invalid.");
  try {
    const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    if (
      bytes.byteLength !== ED25519_PKCS8_PREFIX.byteLength + 32 ||
      ED25519_PKCS8_PREFIX.some((byte, index) => bytes[index] !== byte)
    ) throw new Error();
    const canonical = btoa(String.fromCharCode(...bytes));
    if (canonical !== value) throw new Error();
    return bytes;
  } catch {
    throw new Error("OpenClaw revocation key is invalid.");
  }
}

async function importRevocationPrivateKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  const importBytes = new Uint8Array(keyBytes.byteLength);
  importBytes.set(keyBytes);
  keyBytes.fill(0);
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      importBytes.buffer,
      { name: "Ed25519" },
      false,
      ["sign"],
    );
  } finally {
    importBytes.fill(0);
  }
}

function gatewayEndpoint(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.origin !== TRUSTED_GATEWAY_ORIGIN || url.protocol !== "https:" ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/"
    ) throw new Error();
  } catch {
    throw new Error("OpenClaw media gateway URL must be the trusted HTTPS origin.");
  }
  return `${TRUSTED_GATEWAY_ORIGIN}${REVOCATION_PATH}`;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function readAcknowledgement(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error("OpenClaw media revocation was not acknowledged.");
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new Error("OpenClaw media revocation was not acknowledged.");
  }
  const rawContentLength = response.headers.get("content-length");
  if (rawContentLength !== null) {
    if (!/^\d+$/u.test(rawContentLength)) {
      throw new Error("OpenClaw media revocation acknowledgement length is invalid.");
    }
    const contentLength = Number(rawContentLength);
    if (!Number.isSafeInteger(contentLength)) {
      throw new Error("OpenClaw media revocation acknowledgement length is invalid.");
    }
    if (contentLength > MAX_ACKNOWLEDGEMENT_BYTES) {
      throw new Error("OpenClaw media revocation acknowledgement is too large.");
    }
  }
  if (response.body === null) {
    throw new Error("OpenClaw media revocation acknowledgement is invalid.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > MAX_ACKNOWLEDGEMENT_BYTES - totalBytes) {
        try {
          await reader.cancel();
        } catch {
          // The size violation is authoritative; cancellation remains best effort.
        }
        throw new Error("OpenClaw media revocation acknowledgement is too large.");
      }
      totalBytes += value.byteLength;
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof Error && /acknowledgement is too large/u.test(error.message)) throw error;
    throw new Error("OpenClaw media revocation acknowledgement body failed.");
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("OpenClaw media revocation acknowledgement is invalid.");
  } finally {
    bytes.fill(0);
  }
  if (!plainRecord(value)) {
    throw new Error("OpenClaw media revocation acknowledgement is invalid.");
  }
  return value;
}

interface PreparedRevocationClient {
  endpoint: string;
  keyGeneration: number;
  privateKeyPromise: Promise<CryptoKey>;
  fetcher: typeof fetch;
  now: () => number;
  nonce: () => string;
  timeoutMs: number;
}

function prepareRevocationClient(options: RevocationClientOptions): PreparedRevocationClient {
  const endpoint = gatewayEndpoint(options.gatewayUrl);
  const keyGeneration = options.keyGeneration;
  if (!Number.isSafeInteger(keyGeneration) || keyGeneration < 1) {
    throw new Error("OpenClaw revocation key generation is invalid.");
  }
  const privateKeyPromise = importRevocationPrivateKey(decodeBase64(options.privateKeyPkcs8B64));
  const fetcher = options.fetch ?? fetch;
  const now = options.nowEpochSeconds ?? (() => Math.floor(Date.now() / 1_000));
  const nonce = options.nonce ?? (() => crypto.randomUUID());
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new Error("OpenClaw revocation timeout is invalid.");
  }
  return { endpoint, keyGeneration, privateKeyPromise, fetcher, now, nonce, timeoutMs };
}

export function createGenerationRevocationPropagator(options: RevocationClientOptions) {
  return createPreparedRevocationPropagator(prepareRevocationClient(options));
}

function createPreparedRevocationPropagator({
  endpoint,
  keyGeneration,
  privateKeyPromise,
  fetcher,
  now,
  nonce,
  timeoutMs,
}: PreparedRevocationClient) {
  const usedNonces = new Map<string, number>();

  return async (revocation: DisconnectRevocationV1): Promise<{ acknowledgementHash: string }> => {
    if (
      !UUID.test(revocation.organizationId) || !UUID.test(revocation.accountId) ||
      !UUID.test(revocation.cellId) || !UUID.test(revocation.runtimeCommandId) ||
      !UUID.test(revocation.revocationId) || revocation.revocationKind !== "SESSION" ||
      !Number.isSafeInteger(revocation.revokedGeneration) || revocation.revokedGeneration < 1 ||
      revocation.minimumValidGeneration !== revocation.revokedGeneration + 1
    ) throw new Error("OpenClaw revocation request is invalid.");
    const timestamp = now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 1) {
      throw new Error("OpenClaw revocation clock is invalid.");
    }
    for (const [value, usedAt] of usedNonces) {
      if (usedAt < timestamp - NONCE_REUSE_WINDOW_SECONDS) usedNonces.delete(value);
    }
    const requestNonce = nonce();
    if (
      !UUID.test(requestNonce) || usedNonces.has(requestNonce) ||
      usedNonces.size >= MAX_RECENT_NONCES
    ) throw new Error("OpenClaw revocation nonce is invalid.");
    usedNonces.set(requestNonce, timestamp);
    const body = {
      version: 1,
      organizationId: revocation.organizationId,
      principalKind: "CHANNEL",
      accountId: revocation.accountId,
      cellId: revocation.cellId,
      maintenancePrincipalId: null,
      revocationId: revocation.revocationId,
      revocationKind: revocation.revocationKind,
      revokedGeneration: revocation.revokedGeneration,
      minimumValidGeneration: revocation.minimumValidGeneration,
    };
    const bodyText = canonicalJson(body);
    const envelope = {
      version: 1,
      audience: "openclaw-media-revocation",
      operation: "generation.revoke",
      timestamp,
      nonce: requestNonce,
      bodySha256: await sha256Hex(utf8(bodyText)),
      keyGeneration,
    };
    const signingBytes = new Uint8Array(
      utf8(`ihome-openclaw-media-revocation-v1\0${canonicalJson(envelope)}`),
    );
    const signature = new Uint8Array(await crypto.subtle.sign(
      "Ed25519",
      await privateKeyPromise,
      signingBytes,
    ));
    let response: Response;
    try {
      response = await fetcher(endpoint, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "content-type": "application/json",
          "x-openclaw-revocation-envelope": base64UrlEncode(utf8(canonicalJson(envelope))),
          "x-openclaw-revocation-signature": base64UrlEncode(signature),
        },
        body: bodyText,
      });
    } catch {
      throw new Error("OpenClaw media revocation was not acknowledged.");
    }
    const value = await readAcknowledgement(response);
    if (
      Object.keys(value).sort().join("\0") !==
        ["version", "revocationId", "minimumValidGeneration", "acknowledgementHash"]
          .sort().join("\0") ||
      value.version !== 1 || value.revocationId !== revocation.revocationId ||
      value.minimumValidGeneration !== revocation.minimumValidGeneration ||
      typeof value.acknowledgementHash !== "string" ||
      !SHA256.test(value.acknowledgementHash)
    ) {
      throw new Error("OpenClaw media revocation acknowledgement is invalid.");
    }
    const expectedAcknowledgementHash = await sha256Hex(utf8(
      `ihome-openclaw-media-revocation-ack-v1\0${canonicalJson({
        version: 1,
        revocationId: revocation.revocationId,
        minimumValidGeneration: revocation.minimumValidGeneration,
      })}`,
    ));
    if (value.acknowledgementHash !== expectedAcknowledgementHash) {
      throw new Error("OpenClaw media revocation acknowledgement is invalid.");
    }
    return { acknowledgementHash: value.acknowledgementHash };
  };
}
