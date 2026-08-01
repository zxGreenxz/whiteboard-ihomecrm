import { OPENCLAW_DEFAULT_JSON_LIMIT_BYTES } from "../_shared/openclaw/constants.ts";
import { requireNoBrowserOrigin } from "../_shared/openclaw/cors.ts";
import type { OpenClawEnvironment } from "../_shared/openclaw/env.ts";
import { OpenClawHttpError } from "../_shared/openclaw/errors.ts";
import { errorResponse, jsonResponse } from "../_shared/openclaw/http.ts";
import { redactLogValue } from "../_shared/openclaw/redaction.ts";
import type { RuntimePrincipal, RuntimeVerification } from "../_shared/openclaw/types.ts";
import {
  findRuntimeRoute,
  findSecretLikeField,
  validateInboundBatch,
  workKindIsAllowed,
  type RuntimeRouteDefinition,
} from "./schemas.ts";

export interface RuntimeServiceClient {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

export interface RuntimeDependencies {
  environment: OpenClawEnvironment;
  createServiceClient: (environment: OpenClawEnvironment) => RuntimeServiceClient;
  verifyRuntimeRequest: (input: {
    token: string;
    method: string;
    path: string;
    body: Uint8Array;
    routeBody: unknown;
    timestamp: number;
    nonce: string;
    signingKey: Uint8Array;
    nowEpochSeconds: number;
    revalidatePrincipal: (principal: RuntimePrincipal) => Promise<RuntimePrincipal>;
    consumeNonce: (input: unknown) => Promise<void>;
  }) => Promise<RuntimeVerification>;
  logger?: { error: (message: string, context: unknown) => void };
  requestIdFactory?: () => string;
  now?: () => Date;
}

function mapRpcError(error: { code?: string }): OpenClawHttpError {
  switch (error.code) {
    case "42501":
      return new OpenClawHttpError(403, "RUNTIME_DENIED", "Runtime operation denied.");
    case "40001":
      return new OpenClawHttpError(409, "CONFLICT", "Concurrent update; retry.");
    case "22023":
      return new OpenClawHttpError(400, "INVALID_REQUEST", "Request is invalid.");
    case "P0002":
      return new OpenClawHttpError(404, "NOT_FOUND", "Resource was not found.");
    default:
      return new OpenClawHttpError(400, "OPERATION_FAILED", "Operation failed.");
  }
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ") || authorization.length <= 7) {
    throw new OpenClawHttpError(401, "RUNTIME_TOKEN_REQUIRED", "Runtime token is required.");
  }
  return authorization.slice(7);
}

function numericHeader(request: Request, name: string): number {
  const raw = request.headers.get(name);
  if (raw === null || !/^\d+$/.test(raw)) {
    throw new OpenClawHttpError(401, "RUNTIME_ENVELOPE_INVALID", "Runtime envelope is invalid.");
  }
  return Number(raw);
}

function requiredHeader(request: Request, name: string): string {
  const raw = request.headers.get(name);
  if (!raw) {
    throw new OpenClawHttpError(401, "RUNTIME_ENVELOPE_INVALID", "Runtime envelope is invalid.");
  }
  return raw;
}

/**
 * The principal audience is fixed by the route table, not by the caller. A
 * channel token can never reach a maintenance route and vice versa, even if the
 * token itself is otherwise valid.
 */
function assertPrincipalAudience(
  route: RuntimeRouteDefinition,
  principal: RuntimePrincipal,
): void {
  if (principal.principalKind !== route.principalKind) {
    throw new OpenClawHttpError(403, "PRINCIPAL_ROUTE_MISMATCH", "Principal does not match the route.");
  }
}

export async function handleRuntimeRequest(
  request: Request,
  dependencies: RuntimeDependencies,
): Promise<Response> {
  const requestId = dependencies.requestIdFactory?.() ?? crypto.randomUUID();
  try {
    // Runtime endpoints are machine-to-machine: a browser Origin is a hard stop.
    requireNoBrowserOrigin(request.headers.get("origin"));

    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/openclaw-runtime/, "");
    const route = findRuntimeRoute(request.method, path);
    if (!route) {
      throw new OpenClawHttpError(404, "ROUTE_NOT_FOUND", "Runtime route was not found.");
    }
    if (url.search.length > 0) {
      throw new OpenClawHttpError(400, "INVALID_REQUEST", "Runtime routes take no query string.");
    }

    const rawBody = new Uint8Array(await request.arrayBuffer());
    if (rawBody.byteLength > OPENCLAW_DEFAULT_JSON_LIMIT_BYTES) {
      throw new OpenClawHttpError(413, "BODY_TOO_LARGE", "Request body is too large.");
    }
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody));
    } catch {
      throw new OpenClawHttpError(400, "INVALID_JSON", "Request body is not valid JSON.");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new OpenClawHttpError(400, "INVALID_REQUEST", "Request body must be an object.");
    }

    // Structural checks run before authentication work that touches the DB, so a
    // malformed or secret-bearing body can never reach a facade.
    const secretField = findSecretLikeField(body);
    if (secretField) {
      throw new OpenClawHttpError(400, "SECRET_FIELD_FORBIDDEN", "Request carries a forbidden field.");
    }
    if (route.path === "/v1/inbound/batch") {
      const batch = validateInboundBatch(body);
      if (!batch.ok) {
        throw new OpenClawHttpError(400, batch.reason ?? "BATCH_INVALID", "Inbound batch is invalid.");
      }
    }
    if (
      !workKindIsAllowed(route, (body as { requestedKinds?: unknown }).requestedKinds)
    ) {
      throw new OpenClawHttpError(403, "WORK_KIND_FORBIDDEN", "Work kind is outside this route.");
    }

    const token = bearerToken(request);
    const nowEpochSeconds = Math.floor(
      (dependencies.now?.() ?? new Date()).getTime() / 1000,
    );

    const client = dependencies.createServiceClient(dependencies.environment);
    let verification: RuntimeVerification;
    try {
      verification = await dependencies.verifyRuntimeRequest({
        token,
        method: request.method,
        path: route.path,
        body: rawBody,
        routeBody: body,
        timestamp: numericHeader(request, "x-openclaw-timestamp"),
        nonce: requiredHeader(request, "x-openclaw-nonce"),
        signingKey: new TextEncoder().encode(
          dependencies.environment.runtimeTokenSigningKey,
        ),
        nowEpochSeconds,
        revalidatePrincipal: (principal) => Promise.resolve(principal),
        consumeNonce: () => Promise.resolve(),
      });
    } catch (error) {
      if (error instanceof OpenClawHttpError) throw error;
      throw new OpenClawHttpError(401, "RUNTIME_TOKEN_INVALID", "Runtime token is invalid.");
    }

    assertPrincipalAudience(route, verification.principal);

    const { data, error } = await client.rpc(route.facade, {
      p_principal: verification.principal,
      p_envelope: {
        version: 1,
        operation: route.operation,
        nonce: verification.nonce,
        path: route.path,
      },
      p_request: body,
    });
    if (error) {
      dependencies.logger?.error(
        "openclaw-runtime facade failed",
        redactLogValue({ requestId, path: route.path, code: error.code }),
      );
      throw mapRpcError(error);
    }

    return jsonResponse({ version: 1, requestId, result: data }, 200, requestId);
  } catch (error) {
    if (!(error instanceof OpenClawHttpError)) {
      dependencies.logger?.error("openclaw-runtime failed", redactLogValue({ requestId }));
    }
    return errorResponse(error, requestId);
  }
}