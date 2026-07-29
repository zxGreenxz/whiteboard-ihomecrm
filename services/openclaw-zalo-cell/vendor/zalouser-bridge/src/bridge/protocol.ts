import { createHash, createHmac } from "node:crypto";

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
