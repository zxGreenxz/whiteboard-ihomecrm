import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type BusinessFrame =
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{ contentType?: string; kind: "media"; name?: string; url: string }>
  | Readonly<{ caption?: string; kind: "link"; url: string }>
  | Readonly<{ emoji: string; kind: "reaction"; providerMessageId: string }>;

export type SendContext = Readonly<{
  accountId: string;
  batchSha256: string;
  conversationId: string;
  expiresAt: number;
  issuedAt: number;
  nonce: string;
  signature: string;
}>;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

export function hashProviderBatch(frames: readonly BusinessFrame[]): string {
  return createHash("sha256").update(canonical(frames), "utf8").digest("hex");
}

function signingBytes(context: Omit<SendContext, "signature">): string {
  return canonical(context);
}

function sign(context: Omit<SendContext, "signature">, secret: Uint8Array): string {
  return createHmac("sha256", secret).update(signingBytes(context), "utf8").digest("hex");
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

export function createSendContext(
  input: Omit<SendContext, "batchSha256" | "signature"> & {
    frames: readonly BusinessFrame[];
  },
  secret: Uint8Array,
): SendContext {
  const unsigned = {
    accountId: input.accountId,
    batchSha256: hashProviderBatch(input.frames),
    conversationId: input.conversationId,
    expiresAt: input.expiresAt,
    issuedAt: input.issuedAt,
    nonce: input.nonce,
  };
  return Object.freeze({ ...unsigned, signature: sign(unsigned, secret) });
}

export function verifySendContext(
  context: SendContext,
  frames: readonly BusinessFrame[],
  options: { now: number; secret: Uint8Array },
): SendContext {
  if (!context || typeof context !== "object") fail("INVALID_SEND_CONTEXT", "invalid context");
  if (!Number.isSafeInteger(context.issuedAt) || !Number.isSafeInteger(context.expiresAt)) {
    fail("INVALID_SEND_CONTEXT", "invalid context timestamps");
  }
  if (context.issuedAt > options.now || context.expiresAt < options.now) {
    fail("STALE_SEND_CONTEXT", "send context is stale");
  }
  if (context.batchSha256 !== hashProviderBatch(frames)) {
    fail("INVALID_SEND_CONTEXT", "provider batch does not match authorization");
  }
  const unsigned = {
    accountId: context.accountId,
    batchSha256: context.batchSha256,
    conversationId: context.conversationId,
    expiresAt: context.expiresAt,
    issuedAt: context.issuedAt,
    nonce: context.nonce,
  };
  const expected = Buffer.from(sign(unsigned, options.secret), "hex");
  const actual = Buffer.from(context.signature, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    fail("INVALID_SEND_CONTEXT", "send context signature is invalid");
  }
  return context;
}
