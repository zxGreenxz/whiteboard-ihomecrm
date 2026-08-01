import { buildCorsHeaders } from "../_shared/openclaw/cors.ts";
import { OPENCLAW_DEFAULT_JSON_LIMIT_BYTES } from "../_shared/openclaw/constants.ts";
import type { OpenClawEnvironment } from "../_shared/openclaw/env.ts";
import { OpenClawHttpError } from "../_shared/openclaw/errors.ts";
import { errorResponse, jsonResponse, readStrictJson } from "../_shared/openclaw/http.ts";
import { redactLogValue } from "../_shared/openclaw/redaction.ts";
import { requireBrowserUser } from "../_shared/openclaw/browser-auth.ts";
import { base64UrlDecode, sha256Hex, utf8 } from "../_shared/openclaw/crypto.ts";
import {
  OPENCLAW_QR_CHALLENGE_TTL_SECONDS,
  QR_OPERATION_RPCS,
  qrRequestSchema,
  type QrRequest,
} from "./schemas.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SQL_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/u;

export interface QrSupabaseClient {
  auth: {
    getUser(): Promise<{
      data: { user: { id: string } | null };
      error: unknown;
    }>;
  };
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

export interface QrDependencies {
  environment: OpenClawEnvironment;
  qrDecryptionKey: CryptoKey;
  createBrowserClient: (request: Request, environment: OpenClawEnvironment) => QrSupabaseClient;
  createAdminClient?: (environment: OpenClawEnvironment) => { rpc: QrSupabaseClient["rpc"] };
  logger?: { error: (message: string, context: unknown) => void };
  requestIdFactory?: () => string;
}

/**
 * Consume failures are deliberately indistinguishable. Expired, refreshed,
 * already-consumed, and never-existed challenges must all look identical so the
 * endpoint cannot be used to probe challenge state.
 */
const QR_NOT_AVAILABLE = () =>
  new OpenClawHttpError(404, "QR_NOT_AVAILABLE", "QR challenge is not available.");

function mapRpcError(error: { code?: string }): OpenClawHttpError {
  switch (error.code) {
    case "42501":
      return new OpenClawHttpError(403, "PERMISSION_DENIED", "Permission denied.");
    case "40001":
      return new OpenClawHttpError(409, "CONFLICT", "Concurrent update; retry.");
    case "P0003":
      return new OpenClawHttpError(
        429,
        "QR_RATE_LIMITED",
        "Too many QR requests; retry later.",
      );
    case "P0002":
    case "P0001":
      return QR_NOT_AVAILABLE();
    default:
      return QR_NOT_AVAILABLE();
  }
}

function decodeBase64(value: unknown, label: string): Uint8Array {
  if (typeof value !== "string" || value.length === 0) {
    throw new OpenClawHttpError(500, "QR_MATERIAL_INVALID", `QR ${label} is unavailable.`, {
      expose: false,
    });
  }
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new OpenClawHttpError(500, "QR_MATERIAL_INVALID", `QR ${label} is unavailable.`, {
      expose: false,
    });
  }
}

function decodeQrEncryptionKey(value: string): Uint8Array {
  if (
    value.length === 0 || value !== value.trim() || value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)
  ) throw new Error("OpenClaw QR encryption key is invalid.");
  try {
    const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    if (bytes.byteLength !== 32 || btoa(String.fromCharCode(...bytes)) !== value) throw new Error();
    return bytes;
  } catch {
    throw new Error("OpenClaw QR encryption key is invalid.");
  }
}

export async function importQrDecryptionKey(value: string): Promise<CryptoKey> {
  const keyBytes = decodeQrEncryptionKey(value);
  const importBytes = new Uint8Array(keyBytes.byteLength);
  importBytes.set(keyBytes);
  keyBytes.fill(0);
  try {
    return await crypto.subtle.importKey(
      "raw",
      importBytes.buffer,
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );
  } finally {
    importBytes.fill(0);
  }
}

export async function createQrRequestHandler(
  dependencies: Omit<QrDependencies, "qrDecryptionKey">,
  encodedKey: string,
): Promise<(request: Request) => Promise<Response>> {
  return bindQrRequestHandler({
    ...dependencies,
    qrDecryptionKey: await importQrDecryptionKey(encodedKey),
  });
}

function bindQrRequestHandler(
  dependencies: QrDependencies,
): (request: Request) => Promise<Response> {
  return (request) => handleQrRequest(request, dependencies);
}

function zero(bytes: Uint8Array | null): void {
  if (bytes) bytes.fill(0);
}

function consumedQrRow(
  value: unknown,
  organizationId: string,
  accountId: string,
  challengeId: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OpenClawHttpError(500, "QR_MATERIAL_INVALID", "QR material is unavailable.", {
      expose: false,
    });
  }
  const row = value as Record<string, unknown>;
  const expectedKeys = [
    "version", "organizationId", "accountId", "challengeId", "status", "materialVersion",
    "ciphertextB64", "cipherIvB64", "authTagB64",
  ].sort();
  if (
    Object.keys(row).sort().join("\0") !== expectedKeys.join("\0") ||
    row.version !== 1 || row.organizationId !== organizationId ||
    row.accountId !== accountId || row.challengeId !== challengeId ||
    row.status !== "CONSUMED" || row.materialVersion !== 1
  ) {
    throw new OpenClawHttpError(500, "QR_MATERIAL_INVALID", "QR material is unavailable.", {
      expose: false,
    });
  }
  return row;
}

function beginQrRow(
  value: unknown,
  request: Extract<QrRequest, { operation: "BEGIN" }>,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OpenClawHttpError(500, "QR_CHALLENGE_INVALID", "QR challenge is unavailable.", {
      expose: false,
    });
  }
  const row = value as Record<string, unknown>;
  const expectedKeys = [
    "version", "organizationId", "accountId", "cellId", "challengeId",
    "runtimeCommandId", "issuedAt", "expiresAt", "status",
  ].sort();
  const issuedAt = typeof row.issuedAt === "string" ? Date.parse(row.issuedAt) : Number.NaN;
  const expiresAt = typeof row.expiresAt === "string" ? Date.parse(row.expiresAt) : Number.NaN;
  if (
    Object.keys(row).sort().join("\0") !== expectedKeys.join("\0") ||
    row.version !== 1 || row.organizationId !== request.organizationId ||
    row.accountId !== request.accountId || row.cellId !== request.cellId ||
    typeof row.challengeId !== "string" || !UUID.test(row.challengeId) ||
    typeof row.runtimeCommandId !== "string" || !UUID.test(row.runtimeCommandId) ||
    row.status !== "PENDING" || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) ||
    !SQL_TIMESTAMP.test(String(row.issuedAt)) || !SQL_TIMESTAMP.test(String(row.expiresAt)) ||
    expiresAt - issuedAt !== OPENCLAW_QR_CHALLENGE_TTL_SECONDS * 1_000
  ) {
    throw new OpenClawHttpError(500, "QR_CHALLENGE_INVALID", "QR challenge is unavailable.", {
      expose: false,
    });
  }
  return row;
}

function pollQrRow(
  value: unknown,
  request: Extract<QrRequest, { operation: "POLL" }>,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OpenClawHttpError(500, "QR_CHALLENGE_INVALID", "QR challenge is unavailable.", {
      expose: false,
    });
  }
  const result = value as Record<string, unknown>;
  if (
    Object.keys(result).sort().join("\0") !== ["challenge", "version"].join("\0") ||
    result.version !== 1
  ) {
    throw new OpenClawHttpError(500, "QR_CHALLENGE_INVALID", "QR challenge is unavailable.", {
      expose: false,
    });
  }
  if (result.challenge === null) throw QR_NOT_AVAILABLE();
  if (typeof result.challenge !== "object" || Array.isArray(result.challenge)) {
    throw new OpenClawHttpError(500, "QR_CHALLENGE_INVALID", "QR challenge is unavailable.", {
      expose: false,
    });
  }
  const challenge = result.challenge as Record<string, unknown>;
  const expectedKeys = [
    "challengeId", "accountId", "cellId", "challengeVersion", "challengeStatus",
    "materialVersion", "issuedAt", "expiresAt", "consumedAt", "revokedAt",
  ].sort();
  const issuedAt = typeof challenge.issuedAt === "string" ? Date.parse(challenge.issuedAt) : Number.NaN;
  const expiresAt = typeof challenge.expiresAt === "string" ? Date.parse(challenge.expiresAt) : Number.NaN;
  const optionalTimestamp = (timestamp: unknown) =>
    timestamp === null ||
    (typeof timestamp === "string" && SQL_TIMESTAMP.test(timestamp) && Number.isFinite(Date.parse(timestamp)));
  if (
    Object.keys(challenge).sort().join("\0") !== expectedKeys.join("\0") ||
    challenge.challengeId !== request.challengeId ||
    typeof challenge.accountId !== "string" || !UUID.test(challenge.accountId) ||
    typeof challenge.cellId !== "string" || !UUID.test(challenge.cellId) ||
    !Number.isSafeInteger(challenge.challengeVersion) || Number(challenge.challengeVersion) < 1 ||
    !["PENDING", "READY", "EXPIRED", "CONSUMED", "REVOKED"].includes(String(challenge.challengeStatus)) ||
    !Number.isSafeInteger(challenge.materialVersion) || ![0, 1].includes(Number(challenge.materialVersion)) ||
    !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) ||
    !SQL_TIMESTAMP.test(String(challenge.issuedAt)) || !SQL_TIMESTAMP.test(String(challenge.expiresAt)) ||
    expiresAt - issuedAt !== OPENCLAW_QR_CHALLENGE_TTL_SECONDS * 1_000 ||
    !optionalTimestamp(challenge.consumedAt) || !optionalTimestamp(challenge.revokedAt)
  ) {
    throw new OpenClawHttpError(500, "QR_CHALLENGE_INVALID", "QR challenge is unavailable.", {
      expose: false,
    });
  }
  return {
    version: 1,
    challenge: {
      challengeId: challenge.challengeId,
      accountId: challenge.accountId,
      cellId: challenge.cellId,
      challengeVersion: challenge.challengeVersion,
      challengeStatus: challenge.challengeStatus,
      materialVersion: challenge.materialVersion,
      issuedAt: challenge.issuedAt,
      expiresAt: challenge.expiresAt,
      consumedAt: challenge.consumedAt,
      revokedAt: challenge.revokedAt,
    },
  };
}

/**
 * Decrypts in memory and hands back the data URL exactly once. Every buffer that
 * touched plaintext is zeroed before returning, and no plaintext ever enters a
 * log, error, or analytics payload.
 */
async function revealQrMaterial(
  row: Record<string, unknown>,
  qrDecryptionKey: CryptoKey,
): Promise<string> {
  let ciphertext: Uint8Array | null = null;
  let iv: Uint8Array | null = null;
  let authTag: Uint8Array | null = null;
  let sealed: Uint8Array | null = null;
  let plaintext: Uint8Array | null = null;
  let pngBytes: Uint8Array | null = null;

  try {
    ciphertext = decodeBase64(row.ciphertextB64, "ciphertext");
    iv = decodeBase64(row.cipherIvB64, "iv");
    authTag = decodeBase64(row.authTagB64, "tag");

    sealed = new Uint8Array(ciphertext.byteLength + authTag.byteLength);
    sealed.set(ciphertext, 0);
    sealed.set(authTag, ciphertext.byteLength);

    plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv.slice().buffer, tagLength: 128 },
        qrDecryptionKey,
        sealed.slice().buffer,
      ),
    );
    const dataUrl = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    if (
      dataUrl.length > 1_048_576 ||
      !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u.test(dataUrl)
    ) {
      throw new OpenClawHttpError(500, "QR_MATERIAL_INVALID", "QR material is unavailable.", {
        expose: false,
      });
    }
    pngBytes = decodeBase64(dataUrl.slice("data:image/png;base64,".length), "PNG");
    const pngMagic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (
      pngBytes.byteLength < pngMagic.length ||
      pngMagic.some((byte, index) => pngBytes?.[index] !== byte)
    ) {
      throw new OpenClawHttpError(500, "QR_MATERIAL_INVALID", "QR material is unavailable.", {
        expose: false,
      });
    }
    return dataUrl;
  } catch (error) {
    if (error instanceof OpenClawHttpError) throw error;
    // Never surface the underlying crypto error: it can echo ciphertext bytes.
    throw new OpenClawHttpError(500, "QR_MATERIAL_INVALID", "QR material is unavailable.", {
      expose: false,
    });
  } finally {
    zero(ciphertext);
    zero(iv);
    zero(authTag);
    zero(sealed);
    zero(plaintext);
    zero(pngBytes);
  }
}

function rpcArgs(request: QrRequest, actorId?: string): Record<string, unknown> {
  if (request.operation === "POLL") {
    return {
      p_request: {
        version: 1,
        organizationId: request.organizationId,
        challengeId: request.challengeId,
        browserNonceHash: request.browserNonceHash,
        authSessionHash: request.authSessionHash,
      },
    };
  }
  if (request.operation === "BEGIN") {
    return {
      p_request: {
        version: 1,
        organizationId: request.organizationId,
        accountId: request.accountId,
        cellId: request.cellId,
        browserNonceHash: request.browserNonceHash,
        authSessionHash: request.authSessionHash,
        disclosureVersion: request.disclosureVersion,
      },
      p_client_operation_id: request.clientOperationId,
    };
  }
  return {
    p_request: {
      version: 1,
      organizationId: request.organizationId,
      accountId: request.accountId,
      challengeId: request.challengeId,
      browserNonceHash: request.browserNonceHash,
      authSessionHash: request.authSessionHash,
    },
    p_client_operation_id: request.clientOperationId,
    p_actor_id: actorId,
  };
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ") || authorization.length <= 7) {
    throw new OpenClawHttpError(401, "AUTHENTICATION_REQUIRED", "Browser authentication is required.");
  }
  return authorization.slice(7);
}

async function browserSessionHash(request: Request): Promise<string> {
  const token = bearerToken(request);
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new OpenClawHttpError(401, "AUTHENTICATION_REQUIRED", "Browser authentication is required.");
  }
  try {
    const encodedPayload = parts[1];
    if (!encodedPayload) throw new Error();
    const payload = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(base64UrlDecode(encodedPayload)),
    ) as { session_id?: unknown };
    if (typeof payload.session_id !== "string" || payload.session_id.length === 0) throw new Error();
    return await sha256Hex(utf8(payload.session_id));
  } catch {
    throw new OpenClawHttpError(401, "AUTHENTICATION_REQUIRED", "Browser authentication is required.");
  }
}

export async function handleQrRequest(
  request: Request,
  dependencies: QrDependencies,
): Promise<Response> {
  const origin = request.headers.get("origin");
  let corsHeaders: Record<string, string>;
  try {
    corsHeaders = buildCorsHeaders(origin, dependencies.environment.browserOrigins);
  } catch (error) {
    return errorResponse(error, dependencies.requestIdFactory?.() ?? crypto.randomUUID());
  }

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  let requestId = dependencies.requestIdFactory?.() ?? crypto.randomUUID();
  try {
    const parsed = await readStrictJson(request, {
      method: "POST",
      maxBytes: OPENCLAW_DEFAULT_JSON_LIMIT_BYTES,
      schema: qrRequestSchema,
      requestIdFactory: dependencies.requestIdFactory,
    });
    requestId = parsed.requestId;
    const qrRequest = parsed.data;

    const client = dependencies.createBrowserClient(request, dependencies.environment);
    // Every operation, including each poll, rechecks the caller. SQL rechecks
    // manage_connections independently.
    const user = await requireBrowserUser(client);
    if (qrRequest.authSessionHash !== await browserSessionHash(request)) {
      throw new OpenClawHttpError(403, "SESSION_BINDING_INVALID", "Browser session binding is invalid.");
    }
    if (
      qrRequest.operation === "CONSUME" &&
      (
        dependencies.qrDecryptionKey.type !== "secret" ||
        dependencies.qrDecryptionKey.algorithm.name !== "AES-GCM" ||
        !dependencies.qrDecryptionKey.usages.includes("decrypt")
      )
    ) {
      throw new OpenClawHttpError(500, "QR_SERVICE_UNAVAILABLE", "QR service is unavailable.", {
        expose: false,
      });
    }

    const rpcClient = qrRequest.operation === "CONSUME"
      ? dependencies.createAdminClient?.(dependencies.environment)
      : client;
    if (!rpcClient) {
      throw new OpenClawHttpError(500, "QR_SERVICE_UNAVAILABLE", "QR service is unavailable.", {
        expose: false,
      });
    }
    const { data, error } = await rpcClient.rpc(
      QR_OPERATION_RPCS[qrRequest.operation],
      rpcArgs(qrRequest, user.id),
    );
    if (error) {
      dependencies.logger?.error(
        "openclaw-qr rpc failed",
        redactLogValue({ requestId, operation: qrRequest.operation, code: error.code }),
      );
      throw mapRpcError(error);
    }
    if (!data || typeof data !== "object") throw QR_NOT_AVAILABLE();
    if ((data as { conflict?: unknown }).conflict === true) {
      if (qrRequest.operation === "CONSUME") throw QR_NOT_AVAILABLE();
      throw new OpenClawHttpError(409, "IDEMPOTENCY_CONFLICT", "QR operation conflicts with an earlier request.");
    }

    if (qrRequest.operation !== "CONSUME") {
      const result = qrRequest.operation === "BEGIN"
        ? beginQrRow(data, qrRequest)
        : pollQrRow(data, qrRequest);
      return jsonResponse({ version: 1, requestId, result }, 200, requestId, corsHeaders);
    }

    const row = consumedQrRow(
      data,
      qrRequest.organizationId,
      qrRequest.accountId,
      qrRequest.challengeId,
    );
    const qrPngDataUrl = await revealQrMaterial(
      row,
      dependencies.qrDecryptionKey,
    );

    // Rebuild the response from safe fields only; the encrypted columns and any
    // provider metadata never leave this function.
    return jsonResponse(
      {
        version: 1,
        requestId,
        result: {
          version: 1,
          challengeId: row.challengeId,
          status: row.status,
          qrPngDataUrl,
        },
      },
      200,
      requestId,
      corsHeaders,
    );
  } catch (error) {
    if (!(error instanceof OpenClawHttpError)) {
      dependencies.logger?.error("openclaw-qr failed", redactLogValue({ requestId }));
    }
    const response = errorResponse(error, requestId);
    for (const [name, value] of Object.entries(corsHeaders)) {
      response.headers.set(name, value);
    }
    return response;
  }
}
