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
  type ControlWriteRequest,
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
  ): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

export interface ControlDependencies {
  environment: OpenClawEnvironment;
  createBrowserClient: (request: Request, environment: OpenClawEnvironment) => ControlSupabaseClient;
  createAdminClient?: (environment: OpenClawEnvironment) => Pick<ControlSupabaseClient, "rpc">;
  propagateGenerationRevocation?: (
    revocation: DisconnectRevocationV1,
  ) => Promise<{ acknowledgementHash: string }>;
  logger?: { error: (message: string, context: unknown) => void };
  requestIdFactory?: () => string;
}

export interface DisconnectRevocationV1 {
  version: 1;
  organizationId: string;
  accountId: string;
  cellId: string;
  runtimeCommandId: string;
  revocationId: string;
  revocationKind: "SESSION";
  revokedGeneration: number;
  minimumValidGeneration: number;
  connectionState: "DISCONNECTING";
  effectiveMode: "DRAFT_ONLY";
}

interface DisconnectAcknowledgementV1 {
  version: 1;
  acknowledged: true;
  connectionState: "DISCONNECTING" | "DISCONNECTED";
}

const REVOCATION_PENDING = () =>
  new OpenClawHttpError(
    503,
    "REVOCATION_PENDING",
    "Disconnect is pending generation revocation; retry safely.",
  );

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SQL_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/u;

function disconnectRevocation(
  value: unknown,
  expectedOrganizationId: unknown,
  expectedAccountId: unknown,
): DisconnectRevocationV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OpenClawHttpError(500, "REVOCATION_INVALID", "Disconnect revocation is invalid.", {
      expose: false,
    });
  }
  const row = value as Record<string, unknown>;
  const required = [
    "version", "organizationId", "accountId", "cellId", "runtimeCommandId",
    "revocationId", "revocationKind", "revokedGeneration", "minimumValidGeneration",
    "connectionState", "effectiveMode",
  ];
  if (
    Object.keys(row).sort().join("\0") !== required.sort().join("\0") ||
    row.version !== 1 || row.revocationKind !== "SESSION" ||
    row.organizationId !== expectedOrganizationId || row.accountId !== expectedAccountId ||
    row.connectionState !== "DISCONNECTING" || row.effectiveMode !== "DRAFT_ONLY" ||
    ["organizationId", "accountId", "cellId", "runtimeCommandId", "revocationId"]
      .some((key) => typeof row[key] !== "string" || !UUID.test(String(row[key]))) ||
    !Number.isSafeInteger(row.revokedGeneration) ||
    !Number.isSafeInteger(row.minimumValidGeneration) ||
    Number(row.revokedGeneration) < 1 ||
    Number(row.minimumValidGeneration) !== Number(row.revokedGeneration) + 1
  ) {
    throw new OpenClawHttpError(500, "REVOCATION_INVALID", "Disconnect revocation is invalid.", {
      expose: false,
    });
  }
  return row as unknown as DisconnectRevocationV1;
}

function disconnectAcknowledgement(
  value: unknown,
  revocation: DisconnectRevocationV1,
): DisconnectAcknowledgementV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OpenClawHttpError(502, "REVOCATION_ACK_INVALID", "Revocation acknowledgement is invalid.", {
      expose: false,
    });
  }
  const row = value as Record<string, unknown>;
  const connectionState = row.connectionState;
  const expected = [
    "version", "organizationId", "accountId", "revocationId",
    "minimumValidGeneration", "acknowledged", "connectionState",
  ].sort();
  if (
    Object.keys(row).sort().join("\0") !== expected.join("\0") ||
    row.version !== 1 || row.organizationId !== revocation.organizationId ||
    row.accountId !== revocation.accountId || row.revocationId !== revocation.revocationId ||
    row.minimumValidGeneration !== revocation.minimumValidGeneration ||
    row.acknowledged !== true ||
    (connectionState !== "DISCONNECTING" && connectionState !== "DISCONNECTED")
  ) {
    throw new OpenClawHttpError(502, "REVOCATION_ACK_INVALID", "Revocation acknowledgement is invalid.", {
      expose: false,
    });
  }
  return { version: 1, acknowledged: true, connectionState };
}

function disclosureAcknowledgement(
  value: unknown,
  request: Record<string, unknown>,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OpenClawHttpError(500, "DISCLOSURE_ACK_INVALID", "Disclosure acknowledgement is invalid.", {
      expose: false,
    });
  }
  const row = value as Record<string, unknown>;
  const expected = [
    "version", "organizationId", "accountId", "disclosureAcknowledgedVersion",
    "disclosureAcknowledgedAt", "idempotentReplay",
  ].sort();
  const acknowledgedAt = typeof row.disclosureAcknowledgedAt === "string"
    ? Date.parse(row.disclosureAcknowledgedAt)
    : Number.NaN;
  if (
    Object.keys(row).sort().join("\0") !== expected.join("\0") ||
    row.version !== 1 || row.organizationId !== request.organizationId ||
    row.accountId !== request.accountId ||
    row.disclosureAcknowledgedVersion !== request.disclosureVersion ||
    typeof row.idempotentReplay !== "boolean" || !Number.isFinite(acknowledgedAt) ||
    !SQL_TIMESTAMP.test(String(row.disclosureAcknowledgedAt))
  ) {
    throw new OpenClawHttpError(500, "DISCLOSURE_ACK_INVALID", "Disclosure acknowledgement is invalid.", {
      expose: false,
    });
  }
  return row;
}

async function acknowledgeDisconnectRevocation(
  admin: Pick<ControlSupabaseClient, "rpc">,
  actorId: string,
  revocation: DisconnectRevocationV1,
  acknowledgementHash: string,
): Promise<DisconnectAcknowledgementV1> {
  if (!/^[0-9a-f]{64}$/.test(acknowledgementHash)) {
    throw new OpenClawHttpError(502, "REVOCATION_ACK_INVALID", "Revocation acknowledgement is invalid.", {
      expose: false,
    });
  }
  let acknowledged: Awaited<ReturnType<ControlSupabaseClient["rpc"]>>;
  try {
    acknowledged = await admin.rpc("openclaw_service_ack_disconnect_revocation_v1", {
      p_actor_id: actorId,
      p_request: {
        version: 1,
        organizationId: revocation.organizationId,
        accountId: revocation.accountId,
        revocationId: revocation.revocationId,
        minimumValidGeneration: revocation.minimumValidGeneration,
        acknowledgementHash,
      },
    });
  } catch {
    throw REVOCATION_PENDING();
  }
  if (acknowledged.error) throw REVOCATION_PENDING();
  return disconnectAcknowledgement(acknowledged.data, revocation);
}

async function recoverDeniedDisconnect(
  admin: Pick<ControlSupabaseClient, "rpc"> | undefined,
  propagate: ControlDependencies["propagateGenerationRevocation"],
  actorId: string,
  request: ControlWriteRequest,
): Promise<void> {
  const organizationId = request.payload.organizationId;
  const accountId = request.payload.accountId;
  if (
    !admin || !propagate || typeof organizationId !== "string" || !UUID.test(organizationId) ||
    typeof accountId !== "string" || !UUID.test(accountId)
  ) throw REVOCATION_PENDING();
  let recovered: Awaited<ReturnType<ControlSupabaseClient["rpc"]>>;
  try {
    recovered = await admin.rpc("openclaw_service_resume_disconnect_revocation_v1", {
      p_actor_id: actorId,
      p_organization_id: organizationId,
      p_client_operation_id: request.clientOperationId,
    });
  } catch (error) {
    if (
      error && typeof error === "object" &&
      (error as { code?: unknown }).code === "P0002"
    ) return;
    throw REVOCATION_PENDING();
  }
  if (recovered.error) {
    if (recovered.error.code === "P0002") return;
    throw REVOCATION_PENDING();
  }

  let revocation: DisconnectRevocationV1;
  try {
    revocation = disconnectRevocation(recovered.data, organizationId, accountId);
  } catch {
    throw REVOCATION_PENDING();
  }
  try {
    const { acknowledgementHash } = await propagate(revocation);
    await acknowledgeDisconnectRevocation(admin, actorId, revocation, acknowledgementHash);
  } catch {
    throw REVOCATION_PENDING();
  }
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
    const user = await requireBrowserUser(client);

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
      }));
      if (controlRequest.operation === "DISCONNECT_ACCOUNT" && error.code === "42501") {
        await recoverDeniedDisconnect(
          dependencies.createAdminClient?.(dependencies.environment),
          dependencies.propagateGenerationRevocation,
          user.id,
          controlRequest,
        );
      }
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

    let result = data;
    if (controlRequest.operation === "ACKNOWLEDGE_DISCLOSURE") {
      result = disclosureAcknowledgement(data, controlRequest.payload);
    }
    if (controlRequest.operation === "DISCONNECT_ACCOUNT") {
      const revocation = disconnectRevocation(
        data,
        controlRequest.payload.organizationId,
        controlRequest.payload.accountId,
      );
      const admin = dependencies.createAdminClient?.(dependencies.environment);
      const propagate = dependencies.propagateGenerationRevocation;
      if (!admin || !propagate) {
        throw new OpenClawHttpError(500, "REVOCATION_SERVICE_UNAVAILABLE", "Revocation service is unavailable.", {
          expose: false,
        });
      }
      let acknowledgementHash: string;
      try {
        ({ acknowledgementHash } = await propagate(revocation));
      } catch {
        // The DB transition is intentionally already durable. A retry with the
        // same client operation id receives the same revocation and propagates
        // it idempotently; until then the account stays DISCONNECTING.
        throw REVOCATION_PENDING();
      }
      result = await acknowledgeDisconnectRevocation(admin, user.id, revocation, acknowledgementHash);
    }

    return jsonResponse({ version: 1, requestId, result }, 200, requestId, corsHeaders);
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
