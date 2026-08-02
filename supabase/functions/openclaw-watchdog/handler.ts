import { OPENCLAW_DEFAULT_JSON_LIMIT_BYTES } from "../_shared/openclaw/constants.ts";
import { OpenClawHttpError } from "../_shared/openclaw/errors.ts";
import { errorResponse, jsonResponse, readStrictJson } from "../_shared/openclaw/http.ts";
import { redactLogValue } from "../_shared/openclaw/redaction.ts";
import {
  watchdogRequestSchema,
  type HostGuardRequest,
  type WatchdogControl,
  type WatchdogHealthEvent,
  type WatchdogRecordRequest,
} from "./schemas.ts";

export const WATCHDOG_HEALTH_RPC = "openclaw_service_record_watchdog_health_v1";

export interface WatchdogSnapshot {
  version: 1;
  organizationId: string;
  observedAt: string;
  probeOk: boolean;
  heartbeatAt: string | null;
  metrics: Record<string, number>;
}

export interface WatchdogDependencies {
  sharedSecret: string;
  probe: (organizationId: string, signal: AbortSignal) => Promise<WatchdogSnapshot>;
  recordHealth: (input: {
    organizationId: string;
    operationId: string;
    observedAt: string;
    events: WatchdogHealthEvent[];
  }) => Promise<{ recorded: number }>;
  applyCapacityControls: (input: {
    organizationId: string;
    operationId: string;
    controls: WatchdogControl[] | ["PAUSE_OUTBOUND_AI_MEDIA"];
    reasonFingerprint: string;
  }) => Promise<void>;
  notifyOwnerAdmins: (input: {
    organizationId: string;
    operationId: string;
    fingerprints: string[];
    repeatWindow: number;
  }) => Promise<{ push: number; email: number }>;
  logger?: { error: (message: string, context: unknown) => void };
  requestIdFactory?: () => string;
}

function secret(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return "";
  return authorization.slice(7);
}

async function equalSecret(left: string, right: string): Promise<boolean> {
  if (left.length < 32 || left.length > 512 || right.length < 32 || right.length > 512) return false;
  const encoder = new TextEncoder();
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const a = new Uint8Array(leftDigest);
  const b = new Uint8Array(rightDigest);
  let mismatch = a.length ^ b.length;
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) mismatch |= a[index]! ^ b[index]!;
  return mismatch === 0;
}

function hostGuardEvent(request: HostGuardRequest): WatchdogHealthEvent {
  return {
    accountId: null,
    cellId: request.cellId,
    severity: request.state === "CLEAR_PENDING" ? "INFO" : "CRITICAL",
    healthKind: "HOST_GUARD",
    status: request.state === "CLEAR_PENDING" ? "RECOVERED" : "OPEN",
    fingerprint: request.fingerprint,
    observedAt: request.observedAt,
    contentFreeMetrics: { ...request.contentFreeMetrics, guardState: request.state },
  };
}

async function record(
  request: WatchdogRecordRequest,
  dependencies: WatchdogDependencies,
): Promise<{ recorded: number; notified: { push: number; email: number } }> {
  const stored = request.events.length === 0
    ? { recorded: 0 }
    : await dependencies.recordHealth({
        organizationId: request.organizationId,
        operationId: request.operationId,
        observedAt: request.observedAt,
        events: request.events,
      });
  if (request.controls.length > 0) {
    await dependencies.applyCapacityControls({
      organizationId: request.organizationId,
      operationId: request.operationId,
      controls: request.controls,
      reasonFingerprint: request.events[0]?.fingerprint ?? "watchdog:capacity-control",
    });
  }
  const notified = request.notification === null
    ? { push: 0, email: 0 }
    : await dependencies.notifyOwnerAdmins({
        organizationId: request.organizationId,
        operationId: request.operationId,
        fingerprints: request.notification.fingerprints,
        repeatWindow: request.notification.repeatWindow,
      });
  return { recorded: stored.recorded, notified };
}

export async function handleWatchdogRequest(
  request: Request,
  dependencies: WatchdogDependencies,
): Promise<Response> {
  let requestId = dependencies.requestIdFactory?.() ?? crypto.randomUUID();
  try {
    if (request.headers.get("origin") !== null) {
      throw new OpenClawHttpError(403, "ORIGIN_FORBIDDEN", "Browser requests are forbidden.");
    }
    if (!await equalSecret(secret(request), dependencies.sharedSecret)) {
      throw new OpenClawHttpError(401, "WATCHDOG_AUTH_REQUIRED", "Watchdog authentication is required.");
    }
    const parsed = await readStrictJson(request, {
      method: "POST",
      maxBytes: OPENCLAW_DEFAULT_JSON_LIMIT_BYTES,
      schema: watchdogRequestSchema,
      requestIdFactory: dependencies.requestIdFactory,
    });
    requestId = parsed.requestId;
    if (parsed.data.operation === "PROBE") {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8_000);
      try {
        const snapshot = await dependencies.probe(parsed.data.organizationId, controller.signal);
        if (snapshot.organizationId !== parsed.data.organizationId) {
          throw new OpenClawHttpError(502, "PROBE_SCOPE_MISMATCH", "Health probe scope mismatch.");
        }
        return jsonResponse(snapshot, 200, requestId);
      } finally {
        clearTimeout(timeout);
      }
    }
    if (parsed.data.operation === "HOST_GUARD") {
      const guardEvent = hostGuardEvent(parsed.data);
      const stored = await dependencies.recordHealth({
        organizationId: parsed.data.organizationId,
        operationId: parsed.data.operationId,
        observedAt: parsed.data.observedAt,
        events: [guardEvent],
      });
      await dependencies.applyCapacityControls({
        organizationId: parsed.data.organizationId,
        operationId: parsed.data.operationId,
        controls: parsed.data.controls,
        reasonFingerprint: parsed.data.fingerprint,
      });
      return jsonResponse({ version: 1, requestId, recorded: stored.recorded, manualResumeRequired: true }, 200, requestId);
    }
    const result = await record(parsed.data, dependencies);
    return jsonResponse({ version: 1, requestId, ...result }, 200, requestId);
  } catch (error) {
    dependencies.logger?.error("openclaw-watchdog failed", redactLogValue({
      requestId,
      code: error instanceof OpenClawHttpError ? error.code : "WATCHDOG_DEPENDENCY_FAILED",
    }));
    return errorResponse(
      error instanceof OpenClawHttpError
        ? error
        : new OpenClawHttpError(503, "WATCHDOG_DEPENDENCY_FAILED", "Watchdog dependency failed."),
      requestId,
    );
  }
}
