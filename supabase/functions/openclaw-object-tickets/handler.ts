import { buildCorsHeaders } from "../_shared/openclaw/cors.ts";
import { OPENCLAW_DEFAULT_JSON_LIMIT_BYTES } from "../_shared/openclaw/constants.ts";
import { sha256Hex, utf8 } from "../_shared/openclaw/crypto.ts";
import type { OpenClawEnvironment } from "../_shared/openclaw/env.ts";
import { OpenClawHttpError } from "../_shared/openclaw/errors.ts";
import { errorResponse, jsonResponse, readStrictJson } from "../_shared/openclaw/http.ts";
import { redactLogValue } from "../_shared/openclaw/redaction.ts";
import { requireBrowserUser } from "../_shared/openclaw/browser-auth.ts";
import {
  OBJECT_TICKET_RESOLVE_RPC,
  objectTicketRequestSchema,
  type ObjectTicketRequest,
} from "./schemas.ts";

export const OBJECT_TICKET_TTL_SECONDS = 60;

function decodeObjectTicketPrivateKey(value: string): Uint8Array {
  if (
    value.length === 0 || value !== value.trim() || value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)
  ) throw new Error("OpenClaw ticket private key is invalid.");
  try {
    const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    if (btoa(String.fromCharCode(...bytes)) !== value) throw new Error();
    return bytes;
  } catch {
    throw new Error("OpenClaw ticket private key is invalid.");
  }
}

export async function importObjectTicketSigningKey(value: string): Promise<CryptoKey> {
  const keyBytes = decodeObjectTicketPrivateKey(value);
  const importBytes = new Uint8Array(keyBytes.byteLength);
  importBytes.set(keyBytes);
  keyBytes.fill(0);
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      importBytes.buffer,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  } catch {
    throw new Error("OpenClaw ticket private key is invalid.");
  } finally {
    importBytes.fill(0);
  }
}

export interface ObjectTicketSupabaseClient {
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

export interface ObjectTicketDependencies {
  environment: OpenClawEnvironment;
  createBrowserClient: (
    request: Request,
    environment: OpenClawEnvironment,
  ) => ObjectTicketSupabaseClient;
  signTicket: (claims: Record<string, unknown>) => Promise<string>;
  /** Active ES256 ticket-signing generation; rotation invalidates older keys. */
  gatewayKeyGeneration: number;
  logger?: { error: (message: string, context: unknown) => void };
  requestIdFactory?: () => string;
  jtiFactory?: () => string;
  now?: () => Date;
}

/**
 * Ticket issuance is deliberately uninformative on failure: a caller must not be
 * able to tell "media does not exist" from "media is quarantined" from "you lack
 * permission".
 */
const NOT_AVAILABLE = () =>
  new OpenClawHttpError(404, "MEDIA_NOT_AVAILABLE", "Media object is not available.");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
const MAX_MEDIA_BYTES = 52_428_800;
const RESOLVED_MEDIA_KEYS = [
  "version", "mediaId", "organizationId", "accountId", "conversationId", "messageId",
  "objectKey", "mime", "byteLength", "sha256", "byteState", "sessionGeneration",
] as const;

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const target = [...expected].sort();
  return actual.length === target.length && actual.every((key, index) => key === target[index]);
}

function exactMediaObjectKey({
  objectKey,
  organizationId,
  accountId,
  conversationId,
  messageId,
  mediaId,
}: {
  objectKey: string;
  organizationId: string;
  accountId: string;
  conversationId: string;
  messageId: string;
  mediaId: string;
}): boolean {
  const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^v1/org/${escaped(organizationId)}/account/${escaped(accountId)}` +
      `/conversation/${escaped(conversationId)}/message/${escaped(messageId)}` +
      `/media/${escaped(mediaId)}/(?:original|thumbnail|preview)$`,
  ).test(objectKey);
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ") || authorization.length <= 7) {
    throw new OpenClawHttpError(
      401,
      "AUTHENTICATION_REQUIRED",
      "Browser authentication is required.",
    );
  }
  return authorization.slice(7);
}

/**
 * The Supabase session id, taken from the JWT body. The ticket binds to its
 * hash, so a refreshed session cannot reuse an old ticket.
 */
function sessionIdFromJwt(token: string): string {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new OpenClawHttpError(401, "AUTHENTICATION_REQUIRED", "Browser session is invalid.");
  }
  try {
    const payload = JSON.parse(
      atob(parts[1].replace(/-/g, "+").replace(/_/g, "/").padEnd(
        Math.ceil(parts[1].length / 4) * 4,
        "=",
      )),
    ) as { session_id?: unknown };
    if (typeof payload.session_id !== "string" || !UUID_PATTERN.test(payload.session_id)) {
      throw new Error("missing session id");
    }
    return payload.session_id;
  } catch {
    throw new OpenClawHttpError(401, "AUTHENTICATION_REQUIRED", "Browser session is invalid.");
  }
}

export async function handleObjectTicketRequest(
  request: Request,
  dependencies: ObjectTicketDependencies,
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
    const token = bearerToken(request);
    const parsed = await readStrictJson(request, {
      method: "POST",
      maxBytes: OPENCLAW_DEFAULT_JSON_LIMIT_BYTES,
      schema: objectTicketRequestSchema,
      requestIdFactory: dependencies.requestIdFactory,
    });
    requestId = parsed.requestId;
    const ticketRequest: ObjectTicketRequest = parsed.data;

    const client = dependencies.createBrowserClient(request, dependencies.environment);
    const user = await requireBrowserUser(client);

    // SQL owns the permission check, the tenant binding, and the byte state; the
    // Edge layer never derives an object key from caller input.
    const { data, error } = await client.rpc(OBJECT_TICKET_RESOLVE_RPC, {
      p_request: {
        version: 1,
        organizationId: ticketRequest.organizationId,
        mediaId: ticketRequest.mediaId,
      },
    });
    if (error || !data || typeof data !== "object") {
      dependencies.logger?.error(
        "openclaw-object-tickets resolve failed",
        redactLogValue({ requestId, code: error?.code }),
      );
      throw NOT_AVAILABLE();
    }
    const media = data as Record<string, unknown>;
    if (
      !exactKeys(media, RESOLVED_MEDIA_KEYS) || media.version !== 1 ||
      media.mediaId !== ticketRequest.mediaId ||
      media.organizationId !== ticketRequest.organizationId ||
      typeof media.accountId !== "string" || !UUID_PATTERN.test(media.accountId) ||
      typeof media.conversationId !== "string" || !UUID_PATTERN.test(media.conversationId) ||
      typeof media.messageId !== "string" || !UUID_PATTERN.test(media.messageId) ||
      typeof media.objectKey !== "string" ||
      !exactMediaObjectKey({
        objectKey: media.objectKey,
        organizationId: ticketRequest.organizationId,
        accountId: media.accountId,
        conversationId: media.conversationId,
        messageId: media.messageId,
        mediaId: ticketRequest.mediaId,
      }) ||
      typeof media.sha256 !== "string" || !SHA256_PATTERN.test(media.sha256) ||
      typeof media.mime !== "string" || !MIME_PATTERN.test(media.mime) ||
      !Number.isSafeInteger(media.byteLength) || Number(media.byteLength) < 1 ||
      Number(media.byteLength) > MAX_MEDIA_BYTES ||
      !Number.isSafeInteger(media.sessionGeneration) || Number(media.sessionGeneration) < 0 ||
      !["CACHED", "AVAILABLE"].includes(String(media.byteState))
    ) {
      throw NOT_AVAILABLE();
    }
    if (
      !Number.isSafeInteger(dependencies.gatewayKeyGeneration) ||
      dependencies.gatewayKeyGeneration < 1
    ) {
      throw new OpenClawHttpError(
        500,
        "TICKET_KEY_GENERATION_INVALID",
        "Ticket signing configuration is invalid.",
        { expose: false },
      );
    }

    const issuedAt = Math.floor((dependencies.now?.() ?? new Date()).getTime() / 1000);
    const claims = {
      version: 1,
      aud: "openclaw-media-gateway",
      operation: ticketRequest.operation,
      subject: "BROWSER",
      jti: dependencies.jtiFactory?.() ?? crypto.randomUUID(),
      organizationId: ticketRequest.organizationId,
      accountId: media.accountId,
      objectKey: media.objectKey,
      sha256: media.sha256,
      contentType: media.mime,
      contentLength: media.byteLength,
      sessionGeneration: media.sessionGeneration,
      gatewayKeyGeneration: dependencies.gatewayKeyGeneration,
      iat: issuedAt,
      exp: issuedAt + OBJECT_TICKET_TTL_SECONDS,
      browserUserId: user.id,
      // Binding both hashes is what makes a stolen ticket useless on its own.
      browserSessionIdSha256: await sha256Hex(utf8(sessionIdFromJwt(token))),
      browserAccessTokenSha256: await sha256Hex(utf8(token)),
    };

    const signature = await dependencies.signTicket(claims);

    return jsonResponse(
      {
        version: 1,
        requestId,
        result: { version: 1, ticket: { ...claims, signature } },
      },
      200,
      requestId,
      corsHeaders,
    );
  } catch (error) {
    if (!(error instanceof OpenClawHttpError)) {
      dependencies.logger?.error(
        "openclaw-object-tickets failed",
        redactLogValue({ requestId }),
      );
    }
    const response = errorResponse(error, requestId);
    for (const [name, value] of Object.entries(corsHeaders)) {
      response.headers.set(name, value);
    }
    return response;
  }
}
