import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type BridgeRuntimeBindingV1 = Readonly<{
  organizationId: string;
  accountId: string;
  cellId: string;
  sessionGeneration: number;
  fencingToken: number;
  controlVersion: number;
  takeoverVersion: number;
}>;

export type SignedBridgeRequestV1 = Readonly<{
  version: 1;
  operation: string;
  binding: BridgeRuntimeBindingV1;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  bodySha256: string;
  body: unknown;
  signature: string;
}>;

export type SignedBridgeResponseV1 = Readonly<{
  version: 1;
  operation: string;
  requestNonce: string;
  binding: BridgeRuntimeBindingV1;
  issuedAt: string;
  expiresAt: string;
  bodySha256: string;
  body: unknown;
  signature: string;
}>;

const RESPONSE_SIGNATURE_DOMAIN = "ihome-openclaw-cell-bridge-response-v1\0";
const BINDING_KEYS = Object.freeze([
  "organizationId",
  "accountId",
  "cellId",
  "sessionGeneration",
  "fencingToken",
  "controlVersion",
  "takeoverVersion",
]);

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (let index = 0; index < value.length; index += 1) parts.push(canonical(value[index]));
    return `[${parts.join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} is required`);
  return value;
}

function exactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  const keys = Reflect.ownKeys(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    return undefined;
  }
  const copy: Record<string, unknown> = {};
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return undefined;
    copy[key] = descriptor.value;
  }
  return Object.freeze(copy);
}

function snapshotBinding(value: BridgeRuntimeBindingV1): BridgeRuntimeBindingV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("binding must be an object");
  }
  if (
    !Number.isSafeInteger(value.sessionGeneration) || value.sessionGeneration <= 0 ||
    !Number.isSafeInteger(value.fencingToken) || value.fencingToken <= 0 ||
    !Number.isSafeInteger(value.controlVersion) || value.controlVersion < 0 ||
    !Number.isSafeInteger(value.takeoverVersion) || value.takeoverVersion < 0
  ) {
    throw new TypeError("binding versions and fencing token are invalid");
  }
  return Object.freeze({
    organizationId: requiredString(value.organizationId, "binding.organizationId"),
    accountId: requiredString(value.accountId, "binding.accountId"),
    cellId: requiredString(value.cellId, "binding.cellId"),
    sessionGeneration: value.sessionGeneration,
    fencingToken: value.fencingToken,
    controlVersion: value.controlVersion,
    takeoverVersion: value.takeoverVersion,
  });
}

export function createSignedBridgeRequest(options: Readonly<{
  operation: string;
  binding: BridgeRuntimeBindingV1;
  body: unknown;
  secret: Uint8Array;
  now: number;
  nonce: string;
  ttlMs: number;
}>): SignedBridgeRequestV1 {
  if (!(options.secret instanceof Uint8Array) || options.secret.byteLength < 32) {
    throw new TypeError("bridge secret must contain at least 32 bytes");
  }
  if (!Number.isSafeInteger(options.now)) throw new TypeError("now must be a safe integer");
  if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs <= 0 || options.ttlMs > 5_000) {
    throw new TypeError("ttlMs must be an integer from 1 through 5000");
  }
  const binding = snapshotBinding(options.binding);
  const bodyJson = canonical(options.body);
  const unsigned = Object.freeze({
    version: 1 as const,
    operation: requiredString(options.operation, "operation"),
    binding,
    issuedAt: new Date(options.now).toISOString(),
    expiresAt: new Date(options.now + options.ttlMs).toISOString(),
    nonce: requiredString(options.nonce, "nonce"),
    bodySha256: createHash("sha256").update(bodyJson, "utf8").digest("hex"),
    body: options.body,
  });
  const signature = createHmac("sha256", options.secret)
    .update("ihome-openclaw-cell-bridge-v1\0", "utf8")
    .update(canonical(unsigned), "utf8")
    .digest("hex");
  return Object.freeze({ ...unsigned, signature });
}

function responseSignature(
  unsigned: Omit<SignedBridgeResponseV1, "signature">,
  secret: Uint8Array,
): string {
  return createHmac("sha256", secret)
    .update(RESPONSE_SIGNATURE_DOMAIN, "utf8")
    .update(canonical(unsigned), "utf8")
    .digest("hex");
}

export function createSignedBridgeResponse(options: Readonly<{
  operation: string;
  requestNonce: string;
  binding: BridgeRuntimeBindingV1;
  body: unknown;
  secret: Uint8Array;
  now: number;
  ttlMs: number;
}>): SignedBridgeResponseV1 {
  if (!(options.secret instanceof Uint8Array) || options.secret.byteLength < 32) {
    throw new TypeError("bridge secret must contain at least 32 bytes");
  }
  if (!Number.isSafeInteger(options.now)) throw new TypeError("now must be a safe integer");
  if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs <= 0 || options.ttlMs > 5_000) {
    throw new TypeError("ttlMs must be an integer from 1 through 5000");
  }
  const bodyJson = canonical(options.body);
  const unsigned = Object.freeze({
    version: 1 as const,
    operation: requiredString(options.operation, "operation"),
    requestNonce: requiredString(options.requestNonce, "requestNonce"),
    binding: snapshotBinding(options.binding),
    issuedAt: new Date(options.now).toISOString(),
    expiresAt: new Date(options.now + options.ttlMs).toISOString(),
    bodySha256: createHash("sha256").update(bodyJson, "utf8").digest("hex"),
    body: options.body,
  });
  return Object.freeze({
    ...unsigned,
    signature: responseSignature(unsigned, options.secret),
  });
}

function responseAuthenticationFailure(message: string): never {
  throw Object.assign(new Error(message), { code: "BRIDGE_RESPONSE_AUTHENTICATION_FAILED" });
}

export function verifySignedBridgeResponse(
  value: unknown,
  options: Readonly<{
    operation: string;
    requestNonce: string;
    binding: BridgeRuntimeBindingV1;
    secret: Uint8Array;
    now: number;
  }>,
): unknown {
  if (!(options.secret instanceof Uint8Array) || options.secret.byteLength < 32) {
    return responseAuthenticationFailure("bridge response secret is invalid");
  }
  if (!Number.isSafeInteger(options.now)) {
    return responseAuthenticationFailure("bridge response verification time is invalid");
  }
  const record = exactDataRecord(value, [
    "version",
    "operation",
    "requestNonce",
    "binding",
    "issuedAt",
    "expiresAt",
    "bodySha256",
    "body",
    "signature",
  ]);
  const bindingRecord = exactDataRecord(record?.binding, BINDING_KEYS);
  if (!record || record.version !== 1 || !bindingRecord) {
    return responseAuthenticationFailure("bridge response shape is invalid");
  }
  let responseBinding: BridgeRuntimeBindingV1;
  try {
    responseBinding = snapshotBinding(bindingRecord as unknown as BridgeRuntimeBindingV1);
  } catch {
    return responseAuthenticationFailure("bridge response binding is invalid");
  }
  if (
    typeof record.operation !== "string" || record.operation !== options.operation ||
    typeof record.requestNonce !== "string" || record.requestNonce !== options.requestNonce ||
    canonical(responseBinding) !== canonical(snapshotBinding(options.binding))
  ) {
    return responseAuthenticationFailure("bridge response request context is invalid");
  }
  if (typeof record.issuedAt !== "string" || typeof record.expiresAt !== "string") {
    return responseAuthenticationFailure("bridge response timestamps are invalid");
  }
  const issuedAt = new Date(record.issuedAt);
  const expiresAt = new Date(record.expiresAt);
  if (
    !Number.isFinite(issuedAt.valueOf()) || issuedAt.toISOString() !== record.issuedAt ||
    !Number.isFinite(expiresAt.valueOf()) || expiresAt.toISOString() !== record.expiresAt ||
    issuedAt.valueOf() > options.now || expiresAt.valueOf() < options.now ||
    expiresAt.valueOf() <= issuedAt.valueOf() || expiresAt.valueOf() - issuedAt.valueOf() > 5_000
  ) {
    return responseAuthenticationFailure("bridge response lifetime is invalid");
  }
  const bodySha256 = createHash("sha256").update(canonical(record.body), "utf8").digest("hex");
  if (
    typeof record.bodySha256 !== "string" || record.bodySha256 !== bodySha256 ||
    typeof record.signature !== "string" || !/^[0-9a-f]{64}$/u.test(record.signature)
  ) {
    return responseAuthenticationFailure("bridge response body binding is invalid");
  }
  const unsigned = Object.freeze({
    version: 1 as const,
    operation: record.operation,
    requestNonce: record.requestNonce,
    binding: responseBinding,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
    bodySha256: record.bodySha256,
    body: record.body,
  });
  const expected = Buffer.from(responseSignature(unsigned, options.secret), "hex");
  const actual = Buffer.from(record.signature, "hex");
  if (expected.byteLength !== actual.byteLength || !timingSafeEqual(expected, actual)) {
    return responseAuthenticationFailure("bridge response signature is invalid");
  }
  return record.body;
}
