import { OPENCLAW_DEFAULT_JSON_LIMIT_BYTES } from "../_shared/openclaw/constants.ts";
import { requireNoBrowserOrigin } from "../_shared/openclaw/cors.ts";
import type { OpenClawEnvironment } from "../_shared/openclaw/env.ts";
import { OpenClawHttpError } from "../_shared/openclaw/errors.ts";
import { errorResponse, jsonResponse, readBoundedBody } from "../_shared/openclaw/http.ts";
import { verifyGatewayReceipt } from "../_shared/openclaw/gateway-receipts.ts";
import { redactLogValue } from "../_shared/openclaw/redaction.ts";
import type { RuntimePrincipal, RuntimeVerification } from "../_shared/openclaw/types.ts";
import { canonicalJson, sha256Hex, utf8 } from "../_shared/openclaw/crypto.ts";
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
  ): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
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
  /** Signs the exact bytes consumed by the media gateway with the active ES256 key. */
  signGatewayPayload: (bytes: Uint8Array) => Promise<string>;
  /** Must equal the generation SQL locked into every ticket/authorization claim. */
  ticketKeyGeneration: number;
  historicalTicketSigningKeys?: Readonly<Record<number, {
    activatedAtEpochSeconds: number;
    retiredAtEpochSeconds: number;
    emergencyRevokedAtEpochSeconds: number | null;
    signGatewayPayload: (bytes: Uint8Array) => Promise<string>;
  }>>;
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
      return new OpenClawHttpError(
        503,
        "RUNTIME_DEPENDENCY_FAILED",
        "Runtime dependency failed; retry safely.",
      );
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

function assertRequestPrincipalBinding(
  route: RuntimeRouteDefinition,
  body: Record<string, unknown>,
  principal: RuntimePrincipal,
): void {
  if (route.path === "/v1/media/upload-complete") return;
  if (route.path !== "/v1/inbound/batch") return;
  if (
    principal.principalKind !== "CHANNEL" ||
    body.organizationId !== principal.organizationId ||
    body.accountId !== principal.accountId || body.cellId !== principal.cellId ||
    body.sessionGeneration !== principal.sessionGeneration
  ) {
    throw new OpenClawHttpError(
      403,
      "RUNTIME_BINDING_MISMATCH",
      "Runtime request does not match the verified principal.",
    );
  }
}

function gatewayReceiptClaimMismatch(): OpenClawHttpError {
  return new OpenClawHttpError(
    403,
    "GATEWAY_RECEIPT_CLAIM_MISMATCH",
    "Gateway receipt does not match the verified maintenance claim.",
  );
}

async function assertVerifiedMaintenanceReceipt(
  body: Record<string, unknown>,
  principal: RuntimePrincipal,
  environment: OpenClawEnvironment,
  route: RuntimeRouteDefinition,
): Promise<void> {
  if (!("gatewayReceipt" in body)) return;
  const receipt = body.gatewayReceipt;
  if (!receipt ||
    typeof receipt !== "object" || Array.isArray(receipt)
  ) {
    throw gatewayReceiptClaimMismatch();
  }
  const claims = receipt as Record<string, unknown>;
  const receiptKind = claims.receiptKind;
  const domain = receiptKind === "RETENTION_FINAL_DELETE"
    ? "ihome-openclaw-retention-receipt-v1"
    : receiptKind === "AUDIT_ANCHOR_VERIFY"
    ? "ihome-openclaw-audit-receipt-v1"
    : receiptKind === "MEDIA_UPLOAD"
    ? "ihome-openclaw-media-upload-receipt-v1"
    : null;
  if (!domain) throw gatewayReceiptClaimMismatch();

  await verifyGatewayReceipt({
    domain,
    receipt: claims,
    keyRegistry: environment.gatewayReceiptKeyRegistry,
  });

  if (receiptKind === "MEDIA_UPLOAD") {
    if (
      route.path !== "/v1/media/upload-complete" || principal.principalKind !== "CHANNEL" ||
      body.mediaId !== claims.mediaId || claims.organizationId !== principal.organizationId ||
      claims.accountId !== principal.accountId
    ) throw gatewayReceiptClaimMismatch();
    return;
  }
  const recoveryKind = body.recoveryKind;
  if (
    recoveryKind === "AUDIT_VERIFY_AUTHORIZED" ||
    recoveryKind === "RETENTION_DELETE_AUTHORIZED"
  ) {
    if (
      principal.principalKind !== "MAINTENANCE" ||
      claims.organizationId !== principal.organizationId ||
      claims.workItemId !== body.workItemId ||
      (recoveryKind === "AUDIT_VERIFY_AUTHORIZED" &&
        claims.verifyTicketJti !== body.verifyTicketJti) ||
      (recoveryKind === "RETENTION_DELETE_AUTHORIZED" &&
        claims.deletePhase !== "FINAL_DELETE")
    ) throw gatewayReceiptClaimMismatch();
    // The signed receipt remains bound to the frozen Gateway ticket lineage.
    // SQL authoritatively compares that lineage to the durable ticket row while
    // the current principal and fresh claim token authorize only recovery CAS.
    return;
  }
  if (
    principal.principalKind !== "MAINTENANCE" ||
    claims.organizationId !== principal.organizationId ||
    claims.maintenancePrincipalId !== principal.maintenancePrincipalId ||
    claims.credentialGeneration !== principal.credentialGeneration ||
    claims.leaseGeneration !== principal.leaseGeneration ||
    claims.fencingToken !== principal.fencingToken
  ) {
    throw gatewayReceiptClaimMismatch();
  }
  if (receiptKind === "RETENTION_FINAL_DELETE") {
    if (
      !("ticketId" in body) || claims.deletePhase !== "FINAL_DELETE" ||
      claims.proofJti !== claims.deleteAuthorizationJti
    ) {
      throw gatewayReceiptClaimMismatch();
    }
    return;
  }
  if (
    body.workItemId !== claims.workItemId || body.claimGeneration !== claims.claimGeneration ||
    body.verifyTicketJti !== claims.verifyTicketJti
  ) {
    throw gatewayReceiptClaimMismatch();
  }
}

function sqlPrincipal(
  principal: RuntimePrincipal,
  serviceOperation: string,
): Record<string, unknown> {
  return principal.principalKind === "CHANNEL"
    ? {
        version: 1,
        principalKind: "CHANNEL",
        organizationId: principal.organizationId,
        accountId: principal.accountId,
        cellId: principal.cellId,
        maintenancePrincipalId: null,
        credentialGeneration: principal.credentialGeneration,
        leaseGeneration: principal.leaseGeneration,
        fencingToken: principal.fencingToken,
        sessionGeneration: principal.sessionGeneration,
        localSessionGeneration: principal.localSessionGeneration,
        authMode: principal.authMode,
        allowedOperations: [serviceOperation],
      }
    : {
        version: 1,
        principalKind: "MAINTENANCE",
        organizationId: principal.organizationId,
        accountId: null,
        cellId: null,
        maintenancePrincipalId: principal.maintenancePrincipalId,
        credentialGeneration: principal.credentialGeneration,
        leaseGeneration: principal.leaseGeneration,
        fencingToken: principal.fencingToken,
        sessionGeneration: 0,
        localSessionGeneration: 0,
        authMode: "NORMAL",
        allowedOperations: [serviceOperation],
      };
}

async function serviceRequestHash(
  serviceOperation: string,
  body: unknown,
): Promise<string> {
  return await sha256Hex(utf8(
    `ihome-openclaw-service-request-v1\0${serviceOperation}\0${canonicalJson(body)}`,
  ));
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * How long a service facade may hold a PostgREST connection.
 *
 * Comfortably above a healthy call (measured at 300-900ms) and far below the ~2
 * minutes Supabase waits before it gives up on its own - which was long enough for
 * every later heartbeat to queue behind the stuck one.
 */
const RUNTIME_FACADE_TIMEOUT_MS = 8_000;

const SIGNED_TICKET_ROUTES = new Set([
  "/v1/media/upload-ticket",
  "/v1/maintenance/media/upload-ticket",
  "/v1/maintenance/media/verify-ticket",
  "/v1/maintenance/retention/delete-ticket",
]);

function signingKeyMismatch(): OpenClawHttpError {
  return new OpenClawHttpError(
    502,
    "TICKET_KEY_GENERATION_MISMATCH",
    "Runtime ticket signing generation does not match trusted SQL state.",
  );
}

async function signSqlGatewayResult(
  path: string,
  value: unknown,
  dependencies: RuntimeDependencies,
): Promise<unknown> {
  if (!SIGNED_TICKET_ROUTES.has(path) &&
    path !== "/v1/maintenance/retention/authorize-delete" &&
    path !== "/v1/maintenance/work/claim") return value;
  if (
    !Number.isSafeInteger(dependencies.ticketKeyGeneration) ||
    dependencies.ticketKeyGeneration < 1 || !plainObject(value)
  ) throw signingKeyMismatch();

  const historicalSigner = (
    generation: unknown,
    issuedAtEpochSeconds: unknown,
  ): ((bytes: Uint8Array) => Promise<string>) => {
    if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(issuedAtEpochSeconds)) {
      throw signingKeyMismatch();
    }
    const keyring = dependencies.historicalTicketSigningKeys ?? {};
    if (Object.keys(keyring).length > 8) throw signingKeyMismatch();
    const entry = keyring[Number(generation)];
    if (!entry || !Number.isSafeInteger(entry.activatedAtEpochSeconds) ||
      !Number.isSafeInteger(entry.retiredAtEpochSeconds) ||
      entry.activatedAtEpochSeconds >= entry.retiredAtEpochSeconds ||
      entry.emergencyRevokedAtEpochSeconds !== null ||
      Number(issuedAtEpochSeconds) < entry.activatedAtEpochSeconds ||
      Number(issuedAtEpochSeconds) >= entry.retiredAtEpochSeconds
    ) throw signingKeyMismatch();
    return entry.signGatewayPayload;
  };
  const signTicket = async (
    ticket: unknown,
    allowHistoricalRecovery = false,
  ): Promise<Record<string, unknown>> => {
    if (!plainObject(ticket) || "signature" in ticket) {
      throw new OpenClawHttpError(502, "RUNTIME_RESPONSE_INVALID", "Unsigned SQL ticket is invalid.");
    }
    const signer = ticket.gatewayKeyGeneration === dependencies.ticketKeyGeneration
      ? dependencies.signGatewayPayload
      : allowHistoricalRecovery
      ? historicalSigner(ticket.gatewayKeyGeneration, ticket.iat)
      : (() => { throw signingKeyMismatch(); })();
    const signature = await signer(utf8(canonicalJson(ticket)));
    return { ...ticket, signature };
  };
  const signAuthorization = async (
    authorization: unknown,
    allowHistoricalRecovery = false,
  ): Promise<Record<string, unknown>> => {
    if (!plainObject(authorization) || "signature" in authorization) {
      throw new OpenClawHttpError(
        502,
        "RUNTIME_RESPONSE_INVALID",
        "Unsigned SQL delete authorization is invalid.",
      );
    }
    const issuedAtEpochSeconds = typeof authorization.iat === "string"
      ? Math.floor(Date.parse(authorization.iat) / 1_000)
      : NaN;
    const signer = authorization.gatewaySigningKeyGeneration === dependencies.ticketKeyGeneration
      ? dependencies.signGatewayPayload
      : allowHistoricalRecovery
      ? historicalSigner(authorization.gatewaySigningKeyGeneration, issuedAtEpochSeconds)
      : (() => { throw signingKeyMismatch(); })();
    const signature = await signer(utf8(
      `ihome-openclaw-retention-authorization-v1\0${canonicalJson(authorization)}`,
    ));
    return { ...authorization, signature };
  };

  if (path === "/v1/maintenance/work/claim") {
    if (!Array.isArray(value.items)) {
      throw new OpenClawHttpError(502, "RUNTIME_RESPONSE_INVALID", "SQL recovery claim is invalid.");
    }
    const items = await Promise.all(value.items.map(async (item) => {
      if (!plainObject(item) || !("recoveryKind" in item)) return item;
      if (item.recoveryKind === "AUDIT_VERIFY_AUTHORIZED") {
        return { ...item, verifyTicket: await signTicket(item.verifyTicket, true) };
      }
      if (item.recoveryKind === "RETENTION_DELETE_AUTHORIZED") {
        return {
          ...item,
          ticket: await signTicket(item.ticket, true),
          authorization: await signAuthorization(item.authorization, true),
        };
      }
      throw new OpenClawHttpError(502, "RUNTIME_RESPONSE_INVALID", "Unknown recovery claim kind.");
    }));
    return { ...value, items };
  }

  if (SIGNED_TICKET_ROUTES.has(path)) {
    return {
      ...value,
      ticket: await signTicket(value.ticket, value.state === "RECOVERY_REFRESHED"),
    };
  }
  if (value.state === "RECOVERY_REFRESHED") {
    return {
      ...value,
      ticket: await signTicket(value.ticket, true),
      authorization: await signAuthorization(value.authorization, true),
    };
  }
  return { ...value, authorization: await signAuthorization(value.authorization) };
}

export async function handleRuntimeRequest(
  request: Request,
  dependencies: RuntimeDependencies,
): Promise<Response> {
  const requestId = dependencies.requestIdFactory?.() ?? crypto.randomUUID();
  // Arrival marker, content-free. `function_edge_logs` only records requests that
  // COMPLETE, so a request the client gives up on leaves no trace there at all -
  // which made "the bridge sent it and got nothing" indistinguishable from "it never
  // arrived". This line is the only thing that tells those two apart. Method and
  // path only: no headers, no body, no principal.
  dependencies.logger?.error("openclaw-runtime received", {
    requestId,
    method: request.method,
    path: new URL(request.url).pathname,
  });
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

    const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      throw new OpenClawHttpError(415, "CONTENT_TYPE_REQUIRED", "Content-Type must be application/json.");
    }

    // Reject a missing/invalid machine envelope before spending work on an
    // attacker-controlled stream. Signature verification still happens only
    // after the exact raw bytes have been bounded and parsed.
    const token = bearerToken(request);
    const timestamp = numericHeader(request, "x-openclaw-timestamp");
    const nonce = requiredHeader(request, "x-openclaw-nonce");
    const rawBody = await readBoundedBody(request, OPENCLAW_DEFAULT_JSON_LIMIT_BYTES);
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
    if (!route.validateRequest(body)) {
      throw new OpenClawHttpError(
        400,
        "ROUTE_SCHEMA_INVALID",
        "Runtime request does not match the route contract.",
      );
    }

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
        timestamp,
        nonce,
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
    assertRequestPrincipalBinding(
      route,
      body as Record<string, unknown>,
      verification.principal,
    );
    await assertVerifiedMaintenanceReceipt(
      body as Record<string, unknown>,
      verification.principal,
      dependencies.environment,
      route,
    );

    // Bound the facade call, or one slow RPC poisons every later one.
    //
    // These facades take `FOR UPDATE` on the account, cell and command rows. When two
    // overlap, the second waits - and nothing here used to stop it waiting. The Bridge
    // gives up after its own timeout, but the function does NOT: the RPC kept a
    // PostgREST connection until Supabase killed it at about two minutes with
    // "upstream request timeout". The next heartbeat then queued behind it, and the
    // one after that behind them both.
    //
    // Measured during the failure: all twenty PostgREST connections were the SAME
    // facade, `openclaw_service_runtime_heartbeat_v1`, every one waiting on
    // `Lock: tuple`. A convoy that never drains - so no command was ever claimed and
    // no QR was ever produced until the Bridge was restarted.
    //
    // Failing fast turns that into a retryable error on the next tick, which the
    // Bridge already handles, and hands the connection straight back to the pool.
    const rpcDeadline = AbortSignal.timeout(RUNTIME_FACADE_TIMEOUT_MS);
    const { data, error } = await client.rpc(route.facade, {
      p_principal: sqlPrincipal(verification.principal, route.serviceOperation),
      p_envelope: {
        version: 1,
        operation: route.serviceOperation,
        nonce: verification.nonce,
        iat: new Date(verification.issuedAtEpochSeconds * 1_000).toISOString(),
        exp: new Date(verification.expiresAtEpochSeconds * 1_000).toISOString(),
        requestHash: await serviceRequestHash(route.serviceOperation, body),
      },
      p_request: body,
    }).abortSignal(rpcDeadline);
    if (error) {
      // `code` alone was useless: it came back `undefined`, which is what PostgREST
      // reports for a TRANSPORT failure rather than a SQL error - and with no message
      // there was no way to tell a dropped connection from a rejected statement.
      dependencies.logger?.error(
        "openclaw-runtime facade failed",
        redactLogValue({
          requestId,
          path: route.path,
          code: error.code,
          message: error.message,
        }),
      );
      throw mapRpcError(error);
    }
    const signedData = await signSqlGatewayResult(route.path, data, dependencies);
    if (route.path === "/v1/outbox/claim" && utf8(JSON.stringify(signedData)).byteLength > 256 * 1024) {
      throw new OpenClawHttpError(
        502,
        "RUNTIME_RESPONSE_TOO_LARGE",
        "Outbox claim exceeds the bounded Bridge contract.",
      );
    }
    if (utf8(JSON.stringify(signedData)).byteLength > 512 * 1024) {
      throw new OpenClawHttpError(
        502,
        "RUNTIME_RESPONSE_TOO_LARGE",
        "Runtime service response exceeds the bounded client contract.",
      );
    }
    if (!route.validateResponse(signedData)) {
      throw new OpenClawHttpError(
        502,
        "RUNTIME_RESPONSE_INVALID",
        "Runtime service returned an invalid response.",
      );
    }
    if (
      route.path.endsWith("/claim") && plainObject(signedData) && Array.isArray(signedData.items) &&
      typeof (body as Record<string, unknown>).limit === "number" &&
      signedData.items.length > Number((body as Record<string, unknown>).limit)
    ) {
      throw new OpenClawHttpError(
        502,
        "RUNTIME_RESPONSE_INVALID",
        "Runtime service returned more items than requested.",
      );
    }

    return jsonResponse({ version: 1, requestId, result: signedData }, 200, requestId);
  } catch (error) {
    if (!(error instanceof OpenClawHttpError)) {
      dependencies.logger?.error("openclaw-runtime failed", redactLogValue({ requestId }));
    }
    return errorResponse(error, requestId);
  }
}
