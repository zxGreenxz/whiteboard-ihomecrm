import { buildCorsHeaders } from "../_shared/openclaw/cors.ts";
import { OPENCLAW_DEFAULT_JSON_LIMIT_BYTES } from "../_shared/openclaw/constants.ts";
import type { OpenClawEnvironment } from "../_shared/openclaw/env.ts";
import { OpenClawHttpError } from "../_shared/openclaw/errors.ts";
import { errorResponse, jsonResponse, readStrictJson } from "../_shared/openclaw/http.ts";
import { redactLogValue } from "../_shared/openclaw/redaction.ts";
import { requireBrowserUser } from "../_shared/openclaw/browser-auth.ts";
import { QR_OPERATION_RPCS, qrRequestSchema, type QrRequest } from "./schemas.ts";

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
  ): Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

export interface QrEnvironment extends OpenClawEnvironment {
  /** Base64 raw AES-256-GCM key that wraps QR material at rest. */
  qrEncryptionKeyB64: string;
}

export interface QrDependencies {
  environment: QrEnvironment;
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

function zero(bytes: Uint8Array | null): void {
  if (bytes) bytes.fill(0);
}

/**
 * Decrypts in memory and hands back the data URL exactly once. Every buffer that
 * touched plaintext is zeroed before returning, and no plaintext ever enters a
 * log, error, or analytics payload.
 */
async function revealQrMaterial(
  row: Record<string, unknown>,
  qrEncryptionKeyB64: string,
): Promise<string> {
  let ciphertext: Uint8Array | null = null;
  let iv: Uint8Array | null = null;
  let authTag: Uint8Array | null = null;
  let sealed: Uint8Array | null = null;
  let keyBytes: Uint8Array | null = null;
  let plaintext: Uint8Array | null = null;

  try {
    keyBytes = decodeBase64(qrEncryptionKeyB64, "key");
    if (keyBytes.byteLength !== 32) {
      throw new OpenClawHttpError(500, "QR_MATERIAL_INVALID", "QR key is unavailable.", {
        expose: false,
      });
    }
    ciphertext = decodeBase64(row.ciphertextB64, "ciphertext");
    iv = decodeBase64(row.cipherIvB64, "iv");
    authTag = decodeBase64(row.authTagB64, "tag");

    sealed = new Uint8Array(ciphertext.byteLength + authTag.byteLength);
    sealed.set(ciphertext, 0);
    sealed.set(authTag, ciphertext.byteLength);

    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes.slice().buffer,
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );
    plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv.slice().buffer, tagLength: 128 },
        key,
        sealed.slice().buffer,
      ),
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
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
    zero(keyBytes);
    zero(plaintext);
  }
}

function rpcArgs(request: QrRequest): Record<string, unknown> {
  if (request.operation === "POLL") {
    return {
      p_request: {
        version: 1,
        organizationId: request.organizationId,
        challengeId: request.challengeId,
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
      challengeId: request.challengeId,
      browserNonceHash: request.browserNonceHash,
      authSessionHash: request.authSessionHash,
    },
    p_client_operation_id: request.clientOperationId,
  };
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
    await requireBrowserUser(client);

    const { data, error } = await client.rpc(
      QR_OPERATION_RPCS[qrRequest.operation],
      rpcArgs(qrRequest),
    );
    if (error) {
      dependencies.logger?.error(
        "openclaw-qr rpc failed",
        redactLogValue({ requestId, operation: qrRequest.operation, code: error.code }),
      );
      throw mapRpcError(error);
    }
    if (!data || typeof data !== "object") throw QR_NOT_AVAILABLE();

    if (qrRequest.operation !== "CONSUME") {
      return jsonResponse({ version: 1, requestId, result: data }, 200, requestId, corsHeaders);
    }

    const row = data as Record<string, unknown>;
    const qrPngDataUrl = await revealQrMaterial(
      row,
      dependencies.environment.qrEncryptionKeyB64,
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