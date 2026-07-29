import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type TextBusinessFrameV1 = Readonly<{ kind: "text"; text: string }>;
export type MediaBusinessFrameV1 = Readonly<{
  kind: "media";
  url: string;
  caption: string | null;
  byteLength: number;
  contentType: string | null;
  name: string | null;
  sha256: string;
}>;
export type ObjectMediaBusinessFrameV1 = Readonly<{
  kind: "media";
  objectKey: string;
  byteLength: number;
  contentType: string;
  sha256: string;
}>;
export type LinkBusinessFrameV1 = Readonly<{
  kind: "link";
  url: string;
  caption: string | null;
}>;
export type ReactionBusinessFrameV1 = Readonly<{
  kind: "reaction";
  msgId: string;
  cliMsgId: string;
  emoji: string;
  remove: boolean;
}>;

export type BusinessFrame =
  | TextBusinessFrameV1
  | MediaBusinessFrameV1
  | ObjectMediaBusinessFrameV1
  | LinkBusinessFrameV1
  | ReactionBusinessFrameV1;

export type ProviderSinkV1 = Readonly<{
  accountId: string;
  accountProfile: string;
  conversationId: string;
  isGroup: boolean;
}>;

export type PreparedProviderCallV1 = Readonly<{
  frameIndex: number;
  sink: ProviderSinkV1;
  frame: BusinessFrame;
}>;

export type PreparedOutboundBatchV1 = Readonly<{
  calls: readonly PreparedProviderCallV1[];
  batchSha256: string;
}>;

export type SendContext = Readonly<{
  accountId: string;
  accountProfile: string;
  batchSha256: string;
  conversationId: string;
  isGroup: boolean;
  expiresAt: number;
  issuedAt: number;
  nonce: string;
  signature: string;
}>;

const MAX_PROVIDER_CALLS = 20;
const BATCH_HASH_DOMAIN = "ihome-zalouser-provider-batch-v1\0";

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function snapshotDataRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return undefined;
  const snapshot: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== "string") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return undefined;
    Object.defineProperty(snapshot, key, {
      configurable: false,
      enumerable: true,
      value: descriptor.value,
      writable: false,
    });
  }
  return Object.freeze(snapshot);
}

function snapshotDenseArray(name: string, value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return fail("INVALID_PROVIDER_BATCH", `${name} must be a plain array`);
  }
  const keys = Reflect.ownKeys(value);
  const keySet = new Set(keys);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor) || lengthDescriptor.enumerable) {
    return fail("INVALID_PROVIDER_BATCH", `${name} has invalid length evidence`);
  }
  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1 || !keySet.has("length")) {
    return fail("INVALID_PROVIDER_BATCH", `${name} must contain exactly dense indices and length`);
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    if (!keySet.has(key)) return fail("INVALID_PROVIDER_BATCH", `${name} is sparse`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      return fail("INVALID_PROVIDER_BATCH", `${name}[${index}] is not a data property`);
    }
    snapshot.push(descriptor.value);
  }
  return Object.freeze(snapshot);
}

function hasExactKeys(record: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function exactRecord(
  code: string,
  name: string,
  value: unknown,
  expected: readonly string[],
): Readonly<Record<string, unknown>> {
  const record = snapshotDataRecord(value);
  if (!record || !hasExactKeys(record, expected)) {
    return fail(code, `${name} must contain exactly: ${expected.join(", ")}`);
  }
  return record;
}

function requiredString(code: string, name: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") return fail(code, `${name} is required`);
  return value;
}

function nullableString(code: string, name: string, value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") return fail(code, `${name} must be a string or null`);
  return value;
}

function safeInteger(code: string, name: string, value: unknown): number {
  if (!Number.isSafeInteger(value)) return fail(code, `${name} must be a safe integer`);
  return value as number;
}

function hasAtMostCodePoints(value: string, maximum: number): boolean {
  let count = 0;
  for (const _codePoint of value) {
    count += 1;
    if (count > maximum) return false;
  }
  return true;
}

export function snapshotProviderSink(value: unknown): ProviderSinkV1 {
  const record = exactRecord("INVALID_PROVIDER_SINK", "provider sink", value, [
    "accountId",
    "accountProfile",
    "conversationId",
    "isGroup",
  ]);
  if (typeof record.isGroup !== "boolean") {
    return fail("INVALID_PROVIDER_SINK", "provider sink isGroup must be boolean");
  }
  return Object.freeze({
    accountId: requiredString("INVALID_PROVIDER_SINK", "accountId", record.accountId),
    accountProfile: requiredString(
      "INVALID_PROVIDER_SINK",
      "accountProfile",
      record.accountProfile,
    ),
    conversationId: requiredString(
      "INVALID_PROVIDER_SINK",
      "conversationId",
      record.conversationId,
    ),
    isGroup: record.isGroup,
  });
}

export function snapshotBusinessFrame(value: unknown): BusinessFrame {
  const base = snapshotDataRecord(value);
  if (!base || typeof base.kind !== "string") {
    return fail("INVALID_PROVIDER_FRAME", "provider frame must be a plain discriminated object");
  }
  if (base.kind === "text") {
    const record = exactRecord("INVALID_PROVIDER_FRAME", "text frame", base, ["kind", "text"]);
    const text = requiredString("INVALID_PROVIDER_FRAME", "text", record.text);
    if (!hasAtMostCodePoints(text, 2_000)) {
      return fail("INVALID_PROVIDER_FRAME", "text frame exceeds 2000 Unicode code points");
    }
    return Object.freeze({
      kind: "text",
      text,
    });
  }
  if (base.kind === "media") {
    const record = exactRecord("INVALID_PROVIDER_FRAME", "media frame", base, [
      "kind",
      "objectKey",
      "byteLength",
      "contentType",
      "sha256",
    ]);
    const byteLength = safeInteger("INVALID_PROVIDER_FRAME", "media byteLength", record.byteLength);
    const sha256 = requiredString("INVALID_PROVIDER_FRAME", "media sha256", record.sha256);
    if (byteLength <= 0 || !/^[0-9a-f]{64}$/u.test(sha256)) {
      return fail(
        "INVALID_PROVIDER_FRAME",
        "media byteLength must be positive and sha256 must be lowercase hexadecimal",
      );
    }
    return Object.freeze({
      kind: "media",
      objectKey: requiredString("INVALID_PROVIDER_FRAME", "media objectKey", record.objectKey),
      byteLength,
      contentType: requiredString("INVALID_PROVIDER_FRAME", "media contentType", record.contentType),
      sha256,
    });
  }
  if (base.kind === "link" || base.kind === "reaction") {
    return fail("UNSUPPORTED_BUSINESS_PART", "link and reaction are not v1 business parts");
  }
  return fail("INVALID_PROVIDER_FRAME", "unknown provider frame kind");
}

export function snapshotBusinessFrames(value: unknown): readonly BusinessFrame[] {
  const input = snapshotDenseArray("provider frames", value);
  if (input.length === 0 || input.length > MAX_PROVIDER_CALLS) {
    return fail("INVALID_PROVIDER_BATCH", `provider frames must contain 1-${MAX_PROVIDER_CALLS} calls`);
  }
  const frames: BusinessFrame[] = [];
  for (let index = 0; index < input.length; index += 1) {
    frames.push(snapshotBusinessFrame(input[index]));
  }
  return Object.freeze(frames);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let index = 0; index < value.length; index += 1) items.push(canonical(value[index]));
    return `[${items.join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

export function hashProviderBatch(calls: readonly PreparedProviderCallV1[]): string {
  return createHash("sha256")
    .update(BATCH_HASH_DOMAIN, "utf8")
    .update(canonical(calls), "utf8")
    .digest("hex");
}

export function createPreparedOutboundBatch(
  sinkValue: ProviderSinkV1,
  framesValue: readonly BusinessFrame[],
): PreparedOutboundBatchV1 {
  const sink = snapshotProviderSink(sinkValue);
  const frames = snapshotBusinessFrames(framesValue);
  const calls: PreparedProviderCallV1[] = [];
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
    const frame = frames[frameIndex];
    if (!frame) return fail("INVALID_PROVIDER_BATCH", `provider frame ${frameIndex} is missing`);
    calls.push(Object.freeze({ frameIndex, sink, frame }));
  }
  const frozenCalls = Object.freeze(calls);
  return Object.freeze({ calls: frozenCalls, batchSha256: hashProviderBatch(frozenCalls) });
}

export function snapshotPreparedProviderCall(
  value: unknown,
  expectedFrameIndex?: number,
): PreparedProviderCallV1 {
  const call = exactRecord("INVALID_PROVIDER_BATCH", "prepared call", value, [
    "frameIndex",
    "sink",
    "frame",
  ]);
  const frameIndex = safeInteger(
    "INVALID_PROVIDER_BATCH",
    "prepared frameIndex",
    call.frameIndex,
  );
  if (frameIndex < 0 || (expectedFrameIndex !== undefined && frameIndex !== expectedFrameIndex)) {
    return fail("INVALID_PROVIDER_BATCH", "prepared call has the wrong frame index");
  }
  return Object.freeze({
    frameIndex,
    sink: snapshotProviderSink(call.sink),
    frame: snapshotBusinessFrame(call.frame),
  });
}

export function snapshotPreparedOutboundBatch(value: unknown): PreparedOutboundBatchV1 {
  const record = exactRecord("INVALID_PROVIDER_BATCH", "prepared batch", value, [
    "calls",
    "batchSha256",
  ]);
  const inputCalls = snapshotDenseArray("prepared calls", record.calls);
  if (inputCalls.length === 0 || inputCalls.length > MAX_PROVIDER_CALLS) {
    return fail("INVALID_PROVIDER_BATCH", `prepared calls must contain 1-${MAX_PROVIDER_CALLS} calls`);
  }
  const calls: PreparedProviderCallV1[] = [];
  for (let frameIndex = 0; frameIndex < inputCalls.length; frameIndex += 1) {
    calls.push(snapshotPreparedProviderCall(inputCalls[frameIndex], frameIndex));
  }
  const frozenCalls = Object.freeze(calls);
  const batchSha256 = requiredString(
    "INVALID_PROVIDER_BATCH",
    "batchSha256",
    record.batchSha256,
  );
  if (!/^[0-9a-f]{64}$/u.test(batchSha256) || batchSha256 !== hashProviderBatch(frozenCalls)) {
    return fail("INVALID_PROVIDER_BATCH", "prepared batch hash does not match its calls");
  }
  return Object.freeze({ calls: frozenCalls, batchSha256 });
}

function signingBytes(context: Omit<SendContext, "signature">): string {
  return canonical(context);
}

function sign(context: Omit<SendContext, "signature">, secret: Uint8Array): string {
  return createHmac("sha256", secret).update(signingBytes(context), "utf8").digest("hex");
}

export function snapshotSendContext(value: unknown): SendContext {
  const record = exactRecord("INVALID_SEND_CONTEXT", "send context", value, [
    "accountId",
    "accountProfile",
    "batchSha256",
    "conversationId",
    "isGroup",
    "expiresAt",
    "issuedAt",
    "nonce",
    "signature",
  ]);
  if (typeof record.isGroup !== "boolean") {
    return fail("INVALID_SEND_CONTEXT", "send context isGroup must be boolean");
  }
  const batchSha256 = requiredString("INVALID_SEND_CONTEXT", "batchSha256", record.batchSha256);
  const signature = requiredString("INVALID_SEND_CONTEXT", "signature", record.signature);
  if (!/^[0-9a-f]{64}$/u.test(batchSha256) || !/^[0-9a-f]{64}$/u.test(signature)) {
    return fail("INVALID_SEND_CONTEXT", "send context hashes must be lowercase SHA-256");
  }
  return Object.freeze({
    accountId: requiredString("INVALID_SEND_CONTEXT", "accountId", record.accountId),
    accountProfile: requiredString(
      "INVALID_SEND_CONTEXT",
      "accountProfile",
      record.accountProfile,
    ),
    batchSha256,
    conversationId: requiredString(
      "INVALID_SEND_CONTEXT",
      "conversationId",
      record.conversationId,
    ),
    isGroup: record.isGroup,
    expiresAt: safeInteger("INVALID_SEND_CONTEXT", "expiresAt", record.expiresAt),
    issuedAt: safeInteger("INVALID_SEND_CONTEXT", "issuedAt", record.issuedAt),
    nonce: requiredString("INVALID_SEND_CONTEXT", "nonce", record.nonce),
    signature,
  });
}

export function createSendContext(
  input: Omit<SendContext, "batchSha256" | "signature"> & {
    frames: readonly BusinessFrame[];
  },
  secret: Uint8Array,
): SendContext {
  const sink = snapshotProviderSink({
    accountId: input.accountId,
    accountProfile: input.accountProfile,
    conversationId: input.conversationId,
    isGroup: input.isGroup,
  });
  const batch = createPreparedOutboundBatch(sink, input.frames);
  const unsigned = Object.freeze({
    accountId: sink.accountId,
    accountProfile: sink.accountProfile,
    batchSha256: batch.batchSha256,
    conversationId: sink.conversationId,
    isGroup: sink.isGroup,
    expiresAt: safeInteger("INVALID_SEND_CONTEXT", "expiresAt", input.expiresAt),
    issuedAt: safeInteger("INVALID_SEND_CONTEXT", "issuedAt", input.issuedAt),
    nonce: requiredString("INVALID_SEND_CONTEXT", "nonce", input.nonce),
  });
  return Object.freeze({ ...unsigned, signature: sign(unsigned, secret) });
}

export function verifySendContext(
  contextValue: SendContext,
  batchValue: PreparedOutboundBatchV1,
  options: { now: number; secret: Uint8Array },
): SendContext {
  const context = snapshotSendContext(contextValue);
  const batch = snapshotPreparedOutboundBatch(batchValue);
  if (!Number.isSafeInteger(options.now)) fail("INVALID_SEND_CONTEXT", "now must be a safe integer");
  if (context.issuedAt > options.now || context.expiresAt < options.now) {
    fail("STALE_SEND_CONTEXT", "send context is stale");
  }
  if (context.batchSha256 !== batch.batchSha256) {
    fail("INVALID_SEND_CONTEXT", "provider batch does not match authorization");
  }
  for (const call of batch.calls) {
    if (
      call.sink.accountId !== context.accountId ||
      call.sink.accountProfile !== context.accountProfile ||
      call.sink.conversationId !== context.conversationId ||
      call.sink.isGroup !== context.isGroup
    ) {
      fail("INVALID_SEND_CONTEXT", "provider sink does not match authorization");
    }
  }
  const unsigned = Object.freeze({
    accountId: context.accountId,
    accountProfile: context.accountProfile,
    batchSha256: context.batchSha256,
    conversationId: context.conversationId,
    isGroup: context.isGroup,
    expiresAt: context.expiresAt,
    issuedAt: context.issuedAt,
    nonce: context.nonce,
  });
  const expected = Buffer.from(sign(unsigned, options.secret), "hex");
  const actual = Buffer.from(context.signature, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    fail("INVALID_SEND_CONTEXT", "send context signature is invalid");
  }
  return context;
}
