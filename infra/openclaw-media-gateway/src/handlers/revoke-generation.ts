import type { MediaGatewayEnv } from "../env";
import { errorResponse, jsonResponse } from "../responses";
import { applyGenerationRevocation, TicketStateConflictError } from "../state-client";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_REVOCATION_BODY_BYTES = 16_384;
const REVOCATION_BODY_KEYS = [
  "version", "organizationId", "principalKind", "accountId", "cellId",
  "maintenancePrincipalId", "revocationId", "revocationKind", "revokedGeneration",
  "minimumValidGeneration",
] as const;

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("invalid base64url");
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function base64Decode(value: string): Uint8Array {
  if (
    value.length === 0 || value.length > 1_024 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) throw new Error("invalid base64");
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  if (btoa(String.fromCharCode(...bytes)) !== value) throw new Error("non-canonical base64");
  return bytes;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

const ED25519_SPKI_PREFIX = Uint8Array.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

async function readBoundedBody(request: Request): Promise<string> {
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^(?:0|[1-9][0-9]*)$/u.test(declaredLength) || Number(declaredLength) > MAX_REVOCATION_BODY_BYTES)
  ) throw new Error("invalid content length");
  if (!request.body) throw new Error("body missing");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let byteLength = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > MAX_REVOCATION_BODY_BYTES) {
        await reader.cancel("revocation body too large");
        throw new Error("body too large");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  if (declaredLength !== null && byteLength !== Number(declaredLength)) {
    throw new Error("content length mismatch");
  }
  return text;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export async function handleRevokeGeneration(
  request: Request,
  env: MediaGatewayEnv,
  nowEpochSeconds = Math.floor(Date.now() / 1_000),
): Promise<Response> {
  try {
    if (request.headers.get("origin") !== null) return errorResponse("ORIGIN_FORBIDDEN", 403);
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
      "application/json") return errorResponse("REVOCATION_CONTENT_TYPE_INVALID", 415);
    const envelopeHeader = request.headers.get("x-openclaw-revocation-envelope");
    const signatureHeader = request.headers.get("x-openclaw-revocation-signature");
    if (
      !envelopeHeader || envelopeHeader.length > 16_384 || !signatureHeader ||
      !/^[A-Za-z0-9_-]{86}$/u.test(signatureHeader)
    ) return errorResponse("REVOCATION_AUTH_REQUIRED", 401);
    const configuredGeneration = Number(env.OPENCLAW_REVOCATION_KEY_GENERATION);
    if (!Number.isSafeInteger(configuredGeneration) || configuredGeneration < 1) {
      return errorResponse("REVOCATION_CONFIGURATION_INVALID", 500);
    }
    let publicKey: CryptoKey;
    try {
      const publicKeyBytes = base64Decode(env.OPENCLAW_REVOCATION_PUBLIC_KEY_B64);
      if (
        publicKeyBytes.byteLength !== 44 ||
        !equalBytes(publicKeyBytes.subarray(0, ED25519_SPKI_PREFIX.byteLength), ED25519_SPKI_PREFIX)
      ) throw new Error("invalid Ed25519 SPKI");
      publicKey = await crypto.subtle.importKey(
        "spki",
        publicKeyBytes.slice().buffer,
        { name: "Ed25519" },
        true,
        ["verify"],
      );
      const exported = new Uint8Array(
        await crypto.subtle.exportKey("spki", publicKey) as ArrayBuffer,
      );
      if (!equalBytes(exported, publicKeyBytes)) throw new Error("non-canonical Ed25519 SPKI");
    } catch {
      return errorResponse("REVOCATION_CONFIGURATION_INVALID", 500);
    }
    const envelopeText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      base64UrlDecode(envelopeHeader),
    );
    const envelope = JSON.parse(envelopeText) as unknown;
    if (!exact(envelope, [
      "version", "audience", "operation", "timestamp", "nonce", "bodySha256", "keyGeneration",
    ])) return errorResponse("REVOCATION_ENVELOPE_INVALID", 403);
    if (
      envelope.version !== 1 || envelope.audience !== "openclaw-media-revocation" ||
      envelope.operation !== "generation.revoke" ||
      typeof envelope.timestamp !== "number" || !Number.isSafeInteger(envelope.timestamp) ||
      Math.abs(nowEpochSeconds - envelope.timestamp) > 60 ||
      typeof envelope.nonce !== "string" || !UUID.test(envelope.nonce) ||
      typeof envelope.bodySha256 !== "string" || !SHA256.test(envelope.bodySha256) ||
      envelope.keyGeneration !== configuredGeneration
    ) return errorResponse("REVOCATION_ENVELOPE_INVALID", 403);
    if (envelopeText !== canonical(envelope)) {
      return errorResponse("REVOCATION_ENVELOPE_INVALID", 403);
    }
    const validSignature = await crypto.subtle.verify(
      "Ed25519",
      publicKey,
      base64UrlDecode(signatureHeader),
      new TextEncoder().encode(
        `ihome-openclaw-media-revocation-v1\0${canonical(envelope)}`,
      ),
    );
    if (!validSignature) return errorResponse("REVOCATION_SIGNATURE_INVALID", 403);
    const bodyText = await readBoundedBody(request);
    if (await sha256Hex(bodyText) !== envelope.bodySha256) {
      return errorResponse("REVOCATION_BODY_HASH_INVALID", 403);
    }
    const body = JSON.parse(bodyText) as unknown;
    if (!exact(body, REVOCATION_BODY_KEYS)) return errorResponse("REVOCATION_BODY_INVALID", 403);
    const channelPrincipal = body.principalKind === "CHANNEL" &&
      typeof body.accountId === "string" && UUID.test(body.accountId) &&
      typeof body.cellId === "string" && UUID.test(body.cellId) &&
      body.maintenancePrincipalId === null;
    const maintenancePrincipal = body.principalKind === "MAINTENANCE" &&
      body.accountId === null && body.cellId === null &&
      typeof body.maintenancePrincipalId === "string" && UUID.test(body.maintenancePrincipalId);
    if (
      body.version !== 1 || (!channelPrincipal && !maintenancePrincipal) ||
      !["SESSION", "CREDENTIAL", "LEASE", "CELL"].includes(String(body.revocationKind)) ||
      (body.principalKind === "MAINTENANCE" && body.revocationKind === "SESSION") ||
      typeof body.organizationId !== "string" || !UUID.test(body.organizationId) ||
      typeof body.revocationId !== "string" || !UUID.test(body.revocationId) ||
      !Number.isSafeInteger(body.revokedGeneration) || Number(body.revokedGeneration) < 1 ||
      !Number.isSafeInteger(body.minimumValidGeneration) ||
      Number(body.minimumValidGeneration) <= Number(body.revokedGeneration)
    ) return errorResponse("REVOCATION_BODY_INVALID", 403);
    if (bodyText !== canonical(body)) return errorResponse("REVOCATION_BODY_INVALID", 403);

    const acknowledgement = {
      version: 1,
      revocationId: body.revocationId,
      minimumValidGeneration: Number(body.minimumValidGeneration),
    };
    const acknowledgementHash = await sha256Hex(
      `ihome-openclaw-media-revocation-ack-v1\0${canonical(acknowledgement)}`,
    );
    const responseBody = { ...acknowledgement, acknowledgementHash };
    let revocation;
    try {
      revocation = await applyGenerationRevocation(
      env,
      {
        organizationId: body.organizationId,
        principalKind: body.principalKind as "CHANNEL" | "MAINTENANCE",
        accountId: body.accountId as string | null,
        cellId: body.cellId as string | null,
        maintenancePrincipalId: body.maintenancePrincipalId as string | null,
        dimension: body.revocationKind as "SESSION" | "CREDENTIAL" | "LEASE" | "CELL",
      },
      envelope.nonce,
      nowEpochSeconds,
      Number(body.minimumValidGeneration),
      await sha256Hex(
        `ihome-openclaw-media-revocation-replay-v1\0${canonical(envelope)}.${signatureHeader}`,
      ),
      responseBody,
      );
    } catch (error) {
      if (error instanceof TicketStateConflictError) {
        return errorResponse("REVOCATION_REPLAY", 409);
      }
      throw error;
    }
    if (revocation.generation < Number(body.minimumValidGeneration)) {
      return errorResponse("REVOCATION_STATE_INVALID", 500);
    }
    return jsonResponse(revocation.acknowledgement ?? responseBody, 200);
  } catch {
    return errorResponse("REVOCATION_INVALID", 403);
  }
}
