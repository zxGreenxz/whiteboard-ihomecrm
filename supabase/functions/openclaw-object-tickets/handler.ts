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
  ): Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

export interface ObjectTicketDependencies {
  environment: OpenClawEnvironment;
  createBrowserClient: (
    request: Request,
    environment: OpenClawEnvironment,
  ) => ObjectTicketSupabaseClient;
  signTicket: (claims: Record<string, unknown>) => Promise<string>;
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
    if (typeof payload.session_id !== "string" || payload.session_id.length === 0) {
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
      typeof media.objectKey !== "string" ||
      typeof media.sha256 !== "string" ||
      typeof media.accountId !== "string"
    ) {
      throw NOT_AVAILABLE();
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
      contentType: typeof media.mime === "string" ? media.mime : "application/octet-stream",
      contentLength: typeof media.byteLength === "number" ? media.byteLength : 0,
      sessionGeneration: typeof media.sessionGeneration === "number"
        ? media.sessionGeneration
        : 0,
      gatewayKeyGeneration: 1,
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