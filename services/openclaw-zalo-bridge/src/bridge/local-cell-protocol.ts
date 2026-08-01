import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { canonicalJson } from "../spool/checksum.js";

const REQUEST_DOMAIN = "ihome-openclaw-cell-bridge-v1\0";
const RESPONSE_DOMAIN = "ihome-openclaw-cell-bridge-response-v1\0";
const BINDING_KEYS = [
  "organizationId", "accountId", "cellId", "sessionGeneration", "fencingToken",
  "controlVersion", "takeoverVersion",
] as const;

export interface LocalCellBindingV1 {
  organizationId: string;
  accountId: string;
  cellId: string;
  sessionGeneration: number;
  fencingToken: number;
  controlVersion: number;
  takeoverVersion: number;
}

export interface VerifiedLocalCellRequest {
  operation: string;
  nonce: string;
  binding: Readonly<LocalCellBindingV1>;
  body: unknown;
}

export class LocalCellAuthenticationError extends Error {
  readonly code = "LOCAL_CELL_AUTHENTICATION_FAILED";
}

function fail(message: string): never {
  throw new LocalCellAuthenticationError(message);
}

function exact(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${name} is invalid`);
  const prototype = Object.getPrototypeOf(value);
  const actual = Reflect.ownKeys(value);
  if (
    (prototype !== Object.prototype && prototype !== null) || actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key))
  ) fail(`${name} is invalid`);
  return value as Record<string, unknown>;
}

function binding(value: unknown): Readonly<LocalCellBindingV1> {
  const candidate = exact(value, BINDING_KEYS, "local cell binding");
  for (const name of ["organizationId", "accountId", "cellId"] as const) {
    if (typeof candidate[name] !== "string" || candidate[name].length === 0 ||
      candidate[name] !== candidate[name].trim()) fail("local cell binding is invalid");
  }
  for (const name of ["sessionGeneration", "fencingToken"] as const) {
    if (!Number.isSafeInteger(candidate[name]) || Number(candidate[name]) < 1) {
      fail("local cell binding is invalid");
    }
  }
  for (const name of ["controlVersion", "takeoverVersion"] as const) {
    if (!Number.isSafeInteger(candidate[name]) || Number(candidate[name]) < 0) {
      fail("local cell binding is invalid");
    }
  }
  return Object.freeze({
    organizationId: candidate.organizationId as string,
    accountId: candidate.accountId as string,
    cellId: candidate.cellId as string,
    sessionGeneration: candidate.sessionGeneration as number,
    fencingToken: candidate.fencingToken as number,
    controlVersion: candidate.controlVersion as number,
    takeoverVersion: candidate.takeoverVersion as number,
  });
}

function secret(value: Uint8Array): Buffer {
  const bytes = Buffer.from(value);
  if (bytes.byteLength < 32 || bytes.byteLength > 64) fail("local cell secret is invalid");
  return bytes;
}

function timestamp(value: unknown, name: string): number {
  if (typeof value !== "string") fail(`${name} is invalid`);
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) fail(`${name} is invalid`);
  return time;
}

function sameBinding(left: LocalCellBindingV1, right: LocalCellBindingV1): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export class LocalCellAuthenticator {
  readonly #secret: Buffer;
  readonly #binding: Readonly<LocalCellBindingV1>;
  readonly #now: () => number;
  readonly #seenNonces = new Map<string, number>();

  constructor(options: {
    secret: Uint8Array;
    binding: LocalCellBindingV1;
    now?: () => number;
  }) {
    this.#secret = secret(options.secret);
    this.#binding = binding(options.binding);
    this.#now = options.now ?? Date.now;
  }

  verify(value: unknown, operation: string): VerifiedLocalCellRequest {
    const request = exact(value, [
      "version", "operation", "binding", "issuedAt", "expiresAt", "nonce", "bodySha256",
      "body", "signature",
    ], "local cell request");
    const requestBinding = binding(request.binding);
    const now = this.#now();
    if (!Number.isSafeInteger(now)) fail("local cell clock is invalid");
    const issuedAt = timestamp(request.issuedAt, "issuedAt");
    const expiresAt = timestamp(request.expiresAt, "expiresAt");
    if (
      request.version !== 1 || request.operation !== operation ||
      !sameBinding(requestBinding, this.#binding) || issuedAt > now || expiresAt < now ||
      expiresAt <= issuedAt || expiresAt - issuedAt > 5_000 ||
      typeof request.nonce !== "string" || !/^[A-Za-z0-9._:-]{16,128}$/u.test(request.nonce)
    ) fail("local cell request context is invalid");
    for (const [nonce, expiry] of this.#seenNonces) {
      if (expiry < now) this.#seenNonces.delete(nonce);
    }
    if (this.#seenNonces.has(request.nonce)) fail("local cell request nonce replayed");
    const bodySha256 = createHash("sha256").update(canonicalJson(request.body), "utf8").digest("hex");
    if (
      request.bodySha256 !== bodySha256 || typeof request.signature !== "string" ||
      !/^[0-9a-f]{64}$/u.test(request.signature)
    ) fail("local cell request body binding is invalid");
    const unsigned = {
      version: 1,
      operation: request.operation,
      binding: requestBinding,
      issuedAt: request.issuedAt,
      expiresAt: request.expiresAt,
      nonce: request.nonce,
      bodySha256: request.bodySha256,
      body: request.body,
    };
    const expected = createHmac("sha256", this.#secret)
      .update(REQUEST_DOMAIN, "utf8")
      .update(canonicalJson(unsigned), "utf8")
      .digest();
    const actual = Buffer.from(request.signature, "hex");
    if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
      fail("local cell request signature is invalid");
    }
    this.#seenNonces.set(request.nonce, expiresAt);
    return Object.freeze({
      operation,
      nonce: request.nonce,
      binding: requestBinding,
      body: request.body,
    });
  }

  response(request: VerifiedLocalCellRequest, body: unknown): Readonly<Record<string, unknown>> {
    const now = this.#now();
    if (!Number.isSafeInteger(now)) fail("local cell clock is invalid");
    const unsigned = Object.freeze({
      version: 1 as const,
      operation: request.operation,
      requestNonce: request.nonce,
      binding: request.binding,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 2_000).toISOString(),
      bodySha256: createHash("sha256").update(canonicalJson(body), "utf8").digest("hex"),
      body,
    });
    return Object.freeze({
      ...unsigned,
      signature: createHmac("sha256", this.#secret)
        .update(RESPONSE_DOMAIN, "utf8")
        .update(canonicalJson(unsigned), "utf8")
        .digest("hex"),
    });
  }
}
