import { createHash } from "node:crypto";

import { readBoundedUtf8Response } from "./bounded-response.js";

/**
 * Maintenance principal authentication.
 *
 * The whole point of a separate maintenance principal is that retention and
 * audit anchoring survive events that kill the channel: the Zalo account can be
 * disconnected, replaced, or removed, and the channel cell can be offline, and
 * these jobs still run. Conversely, a send-work token must never reach them.
 */

export type MaintenanceOperation = "maintenance.claim" | "maintenance.complete";

export const MAINTENANCE_WORK_KINDS = Object.freeze([
  "RETENTION_DELETE",
  "AUDIT_ANCHOR",
] as const);

export type MaintenanceWorkKind = (typeof MAINTENANCE_WORK_KINDS)[number];

export interface MaintenancePrincipal {
  version: 1;
  principalKind: "MAINTENANCE";
  organizationId: string;
  maintenancePrincipalId: string;
  credentialGeneration: number;
  leaseGeneration: number;
  fencingToken: number;
}

export interface MaintenanceAuthState {
  principal: MaintenancePrincipal;
  credentialEnabled: boolean;
  credentialRevoked: boolean;
  leaseStatus: "ACTIVE" | "EXPIRED" | "RELEASED";
  leaseExpiresAtEpochMs: number;
  currentCredentialGeneration: number;
  currentLeaseGeneration: number;
  currentFencingToken: number;
  allowedScopes: readonly string[];
}

export type MaintenanceDenial =
  | "WRONG_PRINCIPAL_KIND"
  | "WRONG_ORGANIZATION"
  | "CREDENTIAL_DISABLED"
  | "CREDENTIAL_REVOKED"
  | "STALE_CREDENTIAL_GENERATION"
  | "LEASE_NOT_ACTIVE"
  | "LEASE_EXPIRED"
  | "STALE_LEASE_GENERATION"
  | "STALE_FENCING_TOKEN"
  | "SCOPE_NOT_GRANTED"
  | "WORK_KIND_FORBIDDEN";

export interface MaintenanceVerdict {
  allowed: boolean;
  denial?: MaintenanceDenial;
}

function deny(denial: MaintenanceDenial): MaintenanceVerdict {
  return { allowed: false, denial };
}

export function authorizeMaintenance({
  state,
  expectedOrganizationId,
  operation,
  workKind,
  nowEpochMs,
}: {
  state: MaintenanceAuthState;
  expectedOrganizationId: string;
  operation: MaintenanceOperation;
  workKind?: string;
  nowEpochMs: number;
}): MaintenanceVerdict {
  const principal = state.principal;

  if (principal.principalKind !== "MAINTENANCE") return deny("WRONG_PRINCIPAL_KIND");
  if (principal.organizationId !== expectedOrganizationId) return deny("WRONG_ORGANIZATION");

  if (!state.credentialEnabled) return deny("CREDENTIAL_DISABLED");
  if (state.credentialRevoked) return deny("CREDENTIAL_REVOKED");
  if (principal.credentialGeneration !== state.currentCredentialGeneration) {
    return deny("STALE_CREDENTIAL_GENERATION");
  }

  if (state.leaseStatus !== "ACTIVE") return deny("LEASE_NOT_ACTIVE");
  if (state.leaseExpiresAtEpochMs <= nowEpochMs) return deny("LEASE_EXPIRED");
  if (principal.leaseGeneration !== state.currentLeaseGeneration) {
    return deny("STALE_LEASE_GENERATION");
  }
  if (principal.fencingToken !== state.currentFencingToken) {
    return deny("STALE_FENCING_TOKEN");
  }

  if (!state.allowedScopes.includes(operation)) return deny("SCOPE_NOT_GRANTED");

  if (workKind !== undefined) {
    if (!(MAINTENANCE_WORK_KINDS as readonly string[]).includes(workKind)) {
      return deny("WORK_KIND_FORBIDDEN");
    }
  }

  return { allowed: true };
}

/**
 * Channel state is deliberately absent from the decision above. This helper
 * exists so the tests can state the invariant explicitly: no channel condition
 * may influence maintenance authorization.
 */
export function channelStateAffectsMaintenance(): false {
  return false;
}

export type MaintenanceRuntimeClientStage = "TOKEN_EXCHANGE" | "RUNTIME_REQUEST";

export class MaintenanceRuntimeApiError extends Error {
  readonly stage: MaintenanceRuntimeClientStage;
  readonly status: number | null;

  constructor(stage: MaintenanceRuntimeClientStage, status: number | null, message: string) {
    super(message);
    this.name = "MaintenanceRuntimeApiError";
    this.stage = stage;
    this.status = status;
  }
}

export interface MaintenanceRuntimeClientOptions {
  functionsBaseUrl: string;
  organizationId: string;
  maintenancePrincipalId: string;
  credential: string;
  fetch?: typeof globalThis.fetch;
  nowEpochSeconds?: () => number;
  nonce?: () => string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface MaintenanceRuntimeClient {
  post<T = unknown>(
    path: string,
    body: unknown,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<T>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_RESPONSE_BYTES = 1_048_576;
const NONCE_REUSE_WINDOW_SECONDS = 600;
const MAX_RECENT_NONCES = 65_536;
const MAINTENANCE_PATHS = new Set([
  "/v1/maintenance/work/claim",
  "/v1/maintenance/work/complete",
  "/v1/maintenance/media/upload-ticket",
  "/v1/maintenance/media/verify-ticket",
  "/v1/maintenance/retention/delete-ticket",
  "/v1/maintenance/retention/authorize-delete",
]);

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** RFC 8785-compatible for the JSON values accepted by the maintenance API. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON rejects non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (!plainRecord(value)) throw new TypeError("canonical JSON requires plain JSON values");
  return `{${Object.keys(value).sort().map((key) => {
    const entry = value[key];
    if (entry === undefined) throw new TypeError("canonical JSON rejects undefined values");
    return `${JSON.stringify(key)}:${canonicalJson(entry)}`;
  }).join(",")}}`;
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function requestSignal(
  timeoutMs: number,
  ...signals: Array<AbortSignal | undefined>
): AbortSignal {
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  active.push(AbortSignal.timeout(timeoutMs));
  return active.length === 1 ? active[0]! : AbortSignal.any(active);
}

function functionsOrigin(value: string): URL {
  const url = new URL(value.endsWith("/") ? value : `${value}/`);
  if (
    url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
    !url.pathname.endsWith("/functions/v1/")
  ) {
    throw new TypeError("functionsBaseUrl must be an exact HTTPS Supabase functions URL");
  }
  return url;
}

function maintenancePath(value: string): string {
  if (!MAINTENANCE_PATHS.has(value)) {
    throw new TypeError("maintenance runtime path is not allowlisted");
  }
  return value;
}

function exactEnvelope(value: unknown, stage: MaintenanceRuntimeClientStage): Record<string, unknown> {
  if (!plainRecord(value)) {
    throw new MaintenanceRuntimeApiError(stage, null, `${stage.toLowerCase()} returned invalid JSON`);
  }
  const keys = Object.keys(value).sort();
  if (
    keys.join("\0") !== ["requestId", "result", "version"].sort().join("\0") ||
    value.version !== 1 || typeof value.requestId !== "string" || !UUID.test(value.requestId)
  ) {
    throw new MaintenanceRuntimeApiError(stage, null, `${stage.toLowerCase()} returned invalid envelope`);
  }
  return value;
}

async function readResult(
  response: Response,
  stage: MaintenanceRuntimeClientStage,
): Promise<unknown> {
  if (!response.ok) {
    throw new MaintenanceRuntimeApiError(stage, response.status, `${stage.toLowerCase()} failed`);
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new MaintenanceRuntimeApiError(
      stage,
      response.status,
      `${stage.toLowerCase()} returned non-JSON`,
    );
  }
  let text: string;
  try {
    text = await readBoundedUtf8Response(response, MAX_RESPONSE_BYTES, {
      invalidContentLength: () => new MaintenanceRuntimeApiError(
        stage,
        response.status,
        `${stage.toLowerCase()} returned invalid content length`,
      ),
      invalidUtf8: () => new MaintenanceRuntimeApiError(
        stage,
        response.status,
        `${stage.toLowerCase()} returned invalid UTF-8`,
      ),
      tooLarge: () => new MaintenanceRuntimeApiError(
        stage,
        response.status,
        `${stage.toLowerCase()} response is too large`,
      ),
    });
  } catch (error) {
    if (error instanceof MaintenanceRuntimeApiError) throw error;
    throw new MaintenanceRuntimeApiError(
      stage,
      response.status,
      `${stage.toLowerCase()} response body failed`,
    );
  }
  try {
    return exactEnvelope(JSON.parse(text), stage).result;
  } catch (error) {
    if (error instanceof MaintenanceRuntimeApiError) throw error;
    throw new MaintenanceRuntimeApiError(
      stage,
      response.status,
      `${stage.toLowerCase()} returned invalid JSON`,
    );
  }
}

export function createMaintenanceRuntimeClient(
  options: MaintenanceRuntimeClientOptions,
): MaintenanceRuntimeClient {
  const baseUrl = functionsOrigin(options.functionsBaseUrl);
  if (!UUID.test(options.organizationId) || !UUID.test(options.maintenancePrincipalId)) {
    throw new TypeError("maintenance principal selector is invalid");
  }
  if (options.credential.length < 32 || options.credential !== options.credential.trim()) {
    throw new TypeError("maintenance credential is invalid");
  }
  const request = options.fetch ?? globalThis.fetch;
  const nowEpochSeconds = options.nowEpochSeconds ?? (() => Math.floor(Date.now() / 1_000));
  const nonce = options.nonce ?? (() => crypto.randomUUID());
  const usedNonces = new Map<string, number>();
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new TypeError("maintenance runtime timeout is invalid");
  }

  return Object.freeze({
    async post<T = unknown>(
      pathValue: string,
      body: unknown,
      callOptions: Readonly<{ signal?: AbortSignal }> = {},
    ): Promise<T> {
      const path = maintenancePath(pathValue);
      const bytes = canonicalJson(body);
      const timestamp = nowEpochSeconds();
      if (!Number.isSafeInteger(timestamp) || timestamp < 1) {
        throw new MaintenanceRuntimeApiError("TOKEN_EXCHANGE", null, "runtime clock is invalid");
      }
      for (const [value, usedAt] of usedNonces) {
        if (usedAt < timestamp - NONCE_REUSE_WINDOW_SECONDS) usedNonces.delete(value);
      }
      const runtimeNonce = nonce();
      const exchangeNonce = nonce();
      if (
        !UUID.test(runtimeNonce) || !UUID.test(exchangeNonce) || runtimeNonce === exchangeNonce ||
        usedNonces.has(runtimeNonce) || usedNonces.has(exchangeNonce) ||
        usedNonces.size > MAX_RECENT_NONCES - 2
      ) {
        throw new MaintenanceRuntimeApiError("TOKEN_EXCHANGE", null, "runtime nonces are invalid");
      }
      usedNonces.set(runtimeNonce, timestamp);
      usedNonces.set(exchangeNonce, timestamp);
      const exchangeBody = canonicalJson({
        version: 1,
        principalKind: "MAINTENANCE",
        organizationId: options.organizationId,
        maintenancePrincipalId: options.maintenancePrincipalId,
        runtimeMethod: "POST",
        runtimePath: path,
        runtimeTimestamp: timestamp,
        runtimeNonce,
        runtimeBodySha256: sha256Hex(bytes),
        exchangeNonce,
      });

      let tokenResponse: Response;
      try {
        tokenResponse = await request(new URL("openclaw-runtime-token", baseUrl), {
          method: "POST",
          redirect: "error",
          signal: requestSignal(timeoutMs, options.signal, callOptions.signal),
          headers: {
            "content-type": "application/json",
            "x-openclaw-credential": options.credential,
          },
          body: exchangeBody,
        });
      } catch {
        throw new MaintenanceRuntimeApiError(
          "TOKEN_EXCHANGE",
          null,
          "token exchange transport failed",
        );
      }
      const tokenResult = await readResult(tokenResponse, "TOKEN_EXCHANGE");
      if (
        !plainRecord(tokenResult) || tokenResult.version !== 1 ||
        Object.keys(tokenResult).sort().join("\0") !==
          ["expiresInSeconds", "token", "version"].sort().join("\0") ||
        typeof tokenResult.token !== "string" || tokenResult.token.length < 16 ||
        !Number.isSafeInteger(tokenResult.expiresInSeconds) ||
        Number(tokenResult.expiresInSeconds) < 1 || Number(tokenResult.expiresInSeconds) > 300
      ) {
        throw new MaintenanceRuntimeApiError(
          "TOKEN_EXCHANGE",
          tokenResponse.status,
          "token exchange result invalid",
        );
      }

      let runtimeResponse: Response;
      try {
        runtimeResponse = await request(new URL(`openclaw-runtime${path}`, baseUrl), {
          method: "POST",
          redirect: "error",
          signal: requestSignal(timeoutMs, options.signal, callOptions.signal),
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${tokenResult.token}`,
            "x-openclaw-nonce": runtimeNonce,
            "x-openclaw-timestamp": String(timestamp),
          },
          body: bytes,
        });
      } catch {
        throw new MaintenanceRuntimeApiError(
          "RUNTIME_REQUEST",
          null,
          "runtime request transport failed",
        );
      }
      return await readResult(runtimeResponse, "RUNTIME_REQUEST") as T;
    },
  });
}
