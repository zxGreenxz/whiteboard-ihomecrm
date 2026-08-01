import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { canonicalJson } from "../spool/checksum.js";

const SIGNATURE_DOMAIN = "ihome-openclaw-cell-workload-v1\0";
const DEFAULT_MAX_CLOCK_SKEW_MS = 30_000;

export const CELL_WORKLOAD_HEADERS = Object.freeze({
  organizationId: "x-openclaw-organization-id",
  accountId: "x-openclaw-account-id",
  cellId: "x-openclaw-cell-id",
  sessionGeneration: "x-openclaw-session-generation",
  fencingToken: "x-openclaw-fencing-token",
  timestamp: "x-openclaw-cell-timestamp",
  nonce: "x-openclaw-cell-nonce",
  signature: "x-openclaw-cell-signature",
} as const);

export interface CellWorkloadBinding {
  organizationId: string;
  accountId: string;
  cellId: string;
  sessionGeneration: number;
  fencingToken: number;
}

type HeaderValue = string | readonly string[] | undefined;
export type CellWorkloadHeaders = Readonly<Record<string, HeaderValue>>;

export class CellWorkloadAuthError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CellWorkloadAuthError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new CellWorkloadAuthError(code, message);
}

function safeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) fail("WORKLOAD_BINDING_INVALID", `${name} is invalid`);
  return value;
}

function requiredIdentity(name: string, value: string): string {
  if (value.length === 0 || value !== value.trim() || value.length > 255) {
    fail("WORKLOAD_BINDING_INVALID", `${name} is invalid`);
  }
  return value;
}

function snapshotBinding(value: CellWorkloadBinding): Readonly<CellWorkloadBinding> {
  return Object.freeze({
    organizationId: requiredIdentity("organizationId", value.organizationId),
    accountId: requiredIdentity("accountId", value.accountId),
    cellId: requiredIdentity("cellId", value.cellId),
    sessionGeneration: safeInteger("sessionGeneration", value.sessionGeneration),
    fencingToken: safeInteger("fencingToken", value.fencingToken),
  });
}

function secretBytes(value: Uint8Array): Buffer {
  const bytes = Buffer.from(value);
  if (bytes.byteLength < 32 || bytes.byteLength > 16_384) {
    fail("WORKLOAD_SECRET_INVALID", "cell workload secret is invalid");
  }
  return bytes;
}

function requestSignature(input: {
  secret: Uint8Array;
  binding: CellWorkloadBinding;
  method: string;
  path: string;
  body: Uint8Array;
  timestampMs: number;
  nonce: string;
}): string {
  const binding = snapshotBinding(input.binding);
  const method = input.method.toUpperCase();
  if (method !== "POST") fail("WORKLOAD_REQUEST_INVALID", "cell workload method is invalid");
  if (!/^\/v1\/[a-z0-9/-]+$/u.test(input.path) || input.path.includes("//") || input.path.includes("..")) {
    fail("WORKLOAD_REQUEST_INVALID", "cell workload path is invalid");
  }
  safeInteger("timestamp", input.timestampMs);
  if (!/^[A-Za-z0-9._:-]{16,128}$/u.test(input.nonce)) {
    fail("WORKLOAD_REQUEST_INVALID", "cell workload nonce is invalid");
  }
  const bodySha256 = createHash("sha256").update(input.body).digest("hex");
  const signed = canonicalJson({
    version: 1,
    ...binding,
    method,
    path: input.path,
    timestampMs: input.timestampMs,
    nonce: input.nonce,
    bodySha256,
  });
  return createHmac("sha256", secretBytes(input.secret))
    .update(SIGNATURE_DOMAIN, "utf8")
    .update(signed, "utf8")
    .digest("hex");
}

export function signCellWorkloadRequest(input: {
  secret: Uint8Array;
  binding: CellWorkloadBinding;
  method: string;
  path: string;
  body: Uint8Array;
  timestampMs: number;
  nonce: string;
}): Readonly<Record<string, string>> {
  const binding = snapshotBinding(input.binding);
  const signature = requestSignature({ ...input, binding });
  return Object.freeze({
    [CELL_WORKLOAD_HEADERS.organizationId]: binding.organizationId,
    [CELL_WORKLOAD_HEADERS.accountId]: binding.accountId,
    [CELL_WORKLOAD_HEADERS.cellId]: binding.cellId,
    [CELL_WORKLOAD_HEADERS.sessionGeneration]: String(binding.sessionGeneration),
    [CELL_WORKLOAD_HEADERS.fencingToken]: String(binding.fencingToken),
    [CELL_WORKLOAD_HEADERS.timestamp]: String(input.timestampMs),
    [CELL_WORKLOAD_HEADERS.nonce]: input.nonce,
    [CELL_WORKLOAD_HEADERS.signature]: signature,
  });
}

function header(headers: CellWorkloadHeaders, name: string): string {
  let value: HeaderValue;
  for (const [candidate, candidateValue] of Object.entries(headers)) {
    if (candidate.toLowerCase() === name) {
      value = candidateValue;
      break;
    }
  }
  if (typeof value !== "string" || value.length === 0) {
    fail("WORKLOAD_HEADER_MISSING", `required workload header ${name} is missing`);
  }
  return value;
}

function canonicalUnsignedInteger(name: string, value: string): number {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) fail("WORKLOAD_HEADER_INVALID", `${name} is invalid`);
  const parsed = Number(value);
  return safeInteger(name, parsed);
}

export class CellWorkloadAuthenticator {
  readonly #secret: Buffer;
  readonly #binding: Readonly<CellWorkloadBinding>;
  readonly #now: () => number;
  readonly #maxClockSkewMs: number;
  readonly #seenNonces = new Map<string, number>();

  constructor(options: {
    secret: Uint8Array;
    binding: CellWorkloadBinding;
    now?: () => number;
    maxClockSkewMs?: number;
  }) {
    this.#secret = secretBytes(options.secret);
    this.#binding = snapshotBinding(options.binding);
    this.#now = options.now ?? Date.now;
    this.#maxClockSkewMs = options.maxClockSkewMs ?? DEFAULT_MAX_CLOCK_SKEW_MS;
    if (!Number.isSafeInteger(this.#maxClockSkewMs) || this.#maxClockSkewMs < 1 || this.#maxClockSkewMs > 300_000) {
      fail("WORKLOAD_CLOCK_INVALID", "workload clock skew is invalid");
    }
  }

  verify(input: {
    method: string;
    path: string;
    body: Uint8Array;
    headers: CellWorkloadHeaders;
  }): Readonly<CellWorkloadBinding> {
    const headers = input.headers;
    const organizationId = header(headers, CELL_WORKLOAD_HEADERS.organizationId);
    const accountId = header(headers, CELL_WORKLOAD_HEADERS.accountId);
    const cellId = header(headers, CELL_WORKLOAD_HEADERS.cellId);
    const sessionGeneration = canonicalUnsignedInteger(
      "session generation",
      header(headers, CELL_WORKLOAD_HEADERS.sessionGeneration),
    );
    const fencingToken = canonicalUnsignedInteger(
      "fencing token",
      header(headers, CELL_WORKLOAD_HEADERS.fencingToken),
    );
    if (organizationId !== this.#binding.organizationId) {
      fail("WORKLOAD_ORGANIZATION_MISMATCH", "workload organization mismatch");
    }
    if (accountId !== this.#binding.accountId) {
      fail("WORKLOAD_ACCOUNT_MISMATCH", "workload account mismatch");
    }
    if (cellId !== this.#binding.cellId) fail("WORKLOAD_CELL_MISMATCH", "workload cell mismatch");
    if (sessionGeneration !== this.#binding.sessionGeneration) {
      fail("WORKLOAD_SESSION_MISMATCH", "workload session generation mismatch");
    }
    if (fencingToken !== this.#binding.fencingToken) {
      fail("WORKLOAD_FENCING_MISMATCH", "workload fencing token mismatch");
    }

    const timestampMs = canonicalUnsignedInteger(
      "timestamp",
      header(headers, CELL_WORKLOAD_HEADERS.timestamp),
    );
    const now = this.#now();
    if (!Number.isSafeInteger(now)) fail("WORKLOAD_CLOCK_INVALID", "workload clock is invalid");
    if (Math.abs(now - timestampMs) > this.#maxClockSkewMs) {
      fail("WORKLOAD_TIMESTAMP_STALE", "workload request is stale");
    }
    const nonce = header(headers, CELL_WORKLOAD_HEADERS.nonce);
    if (!/^[A-Za-z0-9._:-]{16,128}$/u.test(nonce)) {
      fail("WORKLOAD_NONCE_INVALID", "workload nonce is invalid");
    }
    for (const [seenNonce, expiresAt] of this.#seenNonces) {
      if (expiresAt < now) this.#seenNonces.delete(seenNonce);
    }
    if (this.#seenNonces.has(nonce)) fail("WORKLOAD_NONCE_REPLAY", "workload nonce replayed");

    const supplied = header(headers, CELL_WORKLOAD_HEADERS.signature);
    if (!/^[0-9a-f]{64}$/u.test(supplied)) {
      fail("WORKLOAD_SIGNATURE_INVALID", "workload signature is invalid");
    }
    const expected = requestSignature({
      secret: this.#secret,
      binding: this.#binding,
      method: input.method,
      path: input.path,
      body: input.body,
      timestampMs,
      nonce,
    });
    const suppliedBytes = Buffer.from(supplied, "hex");
    const expectedBytes = Buffer.from(expected, "hex");
    if (suppliedBytes.byteLength !== expectedBytes.byteLength || !timingSafeEqual(suppliedBytes, expectedBytes)) {
      fail("WORKLOAD_SIGNATURE_INVALID", "workload signature is invalid");
    }

    this.#seenNonces.set(nonce, timestampMs + this.#maxClockSkewMs);
    return this.#binding;
  }
}
