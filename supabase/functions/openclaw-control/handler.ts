import { buildCorsHeaders } from "../_shared/openclaw/cors.ts";
import { OPENCLAW_DEFAULT_JSON_LIMIT_BYTES } from "../_shared/openclaw/constants.ts";
import type { OpenClawEnvironment } from "../_shared/openclaw/env.ts";
import { OpenClawHttpError } from "../_shared/openclaw/errors.ts";
import { errorResponse, jsonResponse, readStrictJson } from "../_shared/openclaw/http.ts";
import { redactLogValue } from "../_shared/openclaw/redaction.ts";
import { requireBrowserUser } from "../_shared/openclaw/browser-auth.ts";
import {
  CONTROL_OPERATION_RPCS,
  CONTROL_READ_OPERATION_RPCS,
  controlRequestSchema,
  isControlWriteRequest,
  type ControlRequest,
} from "./schemas.ts";

/**
 * Only the two members this handler actually uses. Keeping the surface narrow
 * lets tests inject a stub without dragging the Supabase client types (and their
 * `npm:` specifier) into the unit-test module graph.
 */
export interface ControlSupabaseClient {
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

export interface ControlDependencies {
  environment: OpenClawEnvironment;
  createBrowserClient: (request: Request, environment: OpenClawEnvironment) => ControlSupabaseClient;
  logger?: { error: (message: string, context: unknown) => void };
  requestIdFactory?: () => string;
}

/**
 * PostgREST surfaces the SQLSTATE of the failing facade. Map only the codes the
 * facades raise deliberately; everything else collapses into one opaque error so
 * the browser never learns whether a row, permission, or version check failed.
 */
function mapRpcError(error: { code?: string; message?: string }): OpenClawHttpError {
  switch (error.code) {
    case "42501":
      return new OpenClawHttpError(403, "PERMISSION_DENIED", "Permission denied.");
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

function resolveRpcName(request: ControlRequest): string {
  return isControlWriteRequest(request)
    ? CONTROL_OPERATION_RPCS[request.operation]
    : CONTROL_READ_OPERATION_RPCS[request.operation];
}

export async function handleControlRequest(
  request: Request,
  dependencies: ControlDependencies,
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
      schema: controlRequestSchema,
      requestIdFactory: dependencies.requestIdFactory,
    });
    requestId = parsed.requestId;
    const controlRequest = parsed.data;

    const client = dependencies.createBrowserClient(request, dependencies.environment);
    await requireBrowserUser(client);

    const rpcName = resolveRpcName(controlRequest);
    const args: Record<string, unknown> = { p_request: controlRequest.payload };
    if (isControlWriteRequest(controlRequest)) {
      args.p_client_operation_id = controlRequest.clientOperationId;
    }

    const { data, error } = await client.rpc(rpcName, args);
    if (error) {
      dependencies.logger?.error("openclaw-control rpc failed", redactLogValue({
        requestId,
        operation: controlRequest.operation,
        code: error.code,
        message: error.message,
      }));
      throw mapRpcError(error);
    }

    // The facades signal a same-key/different-payload collision in-band so the
    // audit trail keeps the original result; surface it as a conflict.
    if (data && typeof data === "object" && (data as { conflict?: unknown }).conflict === true) {
      throw new OpenClawHttpError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "The client operation id was reused with a different payload.",
      );
    }

    return jsonResponse({ version: 1, requestId, result: data }, 200, requestId, corsHeaders);
  } catch (error) {
    if (!(error instanceof OpenClawHttpError)) {
      dependencies.logger?.error(
        "openclaw-control failed",
        redactLogValue({ requestId, error }),
      );
    }
    const response = errorResponse(error, requestId);
    for (const [name, value] of Object.entries(corsHeaders)) {
      response.headers.set(name, value);
    }
    return response;
  }
}