// Network Center out-of-band watchdog.
//
// The Vultr worker schedules its own periodic work, so nothing outside it can
// tell that it stopped: the browser keeps rendering the last known state and no
// incident is ever opened. This function is the detector that does not depend on
// the worker being alive. It holds no worker credential, takes no worker input,
// and only calls two service-role RPCs added by
// supabase/migrations/20260729139000_network_center_watchdog.sql.
//
// The HTTP status is the alert channel, on purpose. `network_outbox_deliveries`
// still has no consumer anywhere in this repo, so a domain event reaches no
// human; an uptime monitor pointed at /liveness does. Therefore:
//
//   200  the watchdog ran AND the fleet is healthy
//   400  the caller asked for an out-of-range staleness threshold
//   401  wrong or missing cron secret
//   404  unknown route
//   405  wrong method
//   500  the watchdog itself is misconfigured (no secret, no Supabase env)
//   503  the watchdog ran and the fleet is NOT healthy, OR liveness could not be
//        determined at all - both are alert conditions, never silence
//
// Schedules are declared outside this file; see the COMMENT block at the end of
// the migration for the pg_cron statements and the external-cron alternative.
import { createClient } from "@supabase/supabase-js";

import { watchdogSecretMatches, WatchdogConfigError } from "./watchdogAuth.ts";

type JsonObject = Record<string, unknown>;

type RpcError = { code?: string; message?: string };

type RpcResult = { data: unknown; error: RpcError | null };

type RpcCall = (
  name: string,
  args: Record<string, unknown>,
) => Promise<RpcResult>;

type ServiceRpcClient = {
  rpc: (name: string, args: Record<string, unknown>) => Promise<{
    data: unknown;
    error: null | RpcError;
  }>;
};

export type WatchdogHandlerDependencies = {
  getEnv?: (name: string) => string | undefined;
  rpc?: RpcCall;
};

const SECRET_HEADER = "x-network-watchdog-secret";

/** Mirrors the SQL bounds on `p_stale_after_seconds`. */
const MINIMUM_STALE_AFTER_SECONDS = 30;
const MAXIMUM_STALE_AFTER_SECONDS = 86_400;
const DEFAULT_STALE_AFTER_SECONDS = 300;

/**
 * How old the last COMPLETED assessment may be before a contended run stops
 * counting as evidence of health. A contended run reports the previous verdict
 * rather than doing the work twice; if that verdict is itself ancient then the
 * sweep has not actually succeeded for a long time, which is exactly the failure
 * this function exists to catch.
 */
const MAXIMUM_ASSESSMENT_AGE_MS = 15 * 60 * 1_000;

type RouteDefinition = {
  rpcName: string;
  buildArgs: (context: { staleAfterSeconds: number }) => Record<string, unknown>;
  evaluate: (data: unknown, context: EvaluationContext) => Verdict;
};

type EvaluationContext = { minimumWorkers: number; now: number };

type Verdict = { status: number; healthy: boolean; reason: string | null };

// A Map, never an object literal. `ROUTES["constructor"]` on a literal resolves
// through Object.prototype and answers truthy for eleven ordinary member names;
// Map#get has no prototype chain, so the class is closed by construction rather
// than by an allowlist somebody has to keep complete.
const ROUTES: ReadonlyMap<string, RouteDefinition> = new Map<string, RouteDefinition>([
  ["liveness", {
    rpcName: "network_center_watchdog_liveness_v1",
    buildArgs: ({ staleAfterSeconds }) => ({
      p_stale_after_seconds: staleAfterSeconds,
    }),
    evaluate: evaluateLiveness,
  }],
  ["maintenance", {
    rpcName: "network_center_watchdog_maintenance_v1",
    buildArgs: () => ({}),
    evaluate: evaluateMaintenance,
  }],
]);

class WatchdogRequestError extends Error {}

function jsonResponse(status: number, payload: unknown, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set("cache-control", "no-store");
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(payload), { status, headers });
}

function routeFromUrl(rawUrl: string): string {
  const { pathname } = new URL(rawUrl);
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  return segments.at(-1) ?? "";
}

function asPlainObject(value: unknown): JsonObject | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  return value as JsonObject;
}

function asCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function parseBoundedInteger(raw: string, field: string): number {
  const parsed = Number(raw);
  if (
    raw.trim().length === 0
    || !Number.isInteger(parsed)
    || parsed < MINIMUM_STALE_AFTER_SECONDS
    || parsed > MAXIMUM_STALE_AFTER_SECONDS
  ) {
    throw new WatchdogRequestError(`${field} is out of range`);
  }
  return parsed;
}

/**
 * Turns the SQL report into an HTTP verdict. Every path that cannot positively
 * establish health returns LIVENESS_INDETERMINATE: a null payload, a payload of
 * the wrong shape, or a payload whose counts are not integers is a broken
 * detector, and a broken detector must page rather than answer 200.
 */
function evaluateLiveness(data: unknown, context: EvaluationContext): Verdict {
  const report = asPlainObject(data);
  if (report === null) {
    return { status: 503, healthy: false, reason: "LIVENESS_INDETERMINATE" };
  }
  const staleBuildings = asCount(report.staleBuildings);
  const staleWorkers = asCount(report.staleWorkers);
  const monitoredWorkers = asCount(report.monitoredWorkers);
  const monitoredBuildings = asCount(report.monitoredBuildings);
  if (
    staleBuildings === null || staleWorkers === null
    || monitoredWorkers === null || monitoredBuildings === null
  ) {
    return { status: 503, healthy: false, reason: "LIVENESS_INDETERMINATE" };
  }
  if (staleBuildings > 0 || staleWorkers > 0) {
    return { status: 503, healthy: false, reason: "WORKER_HEARTBEAT_STALE" };
  }

  const assessedAt = typeof report.assessedAt === "string"
    ? Date.parse(report.assessedAt)
    : Number.NaN;
  if (!Number.isFinite(assessedAt)) {
    return { status: 503, healthy: false, reason: "ASSESSMENT_STALE" };
  }
  if (context.now - assessedAt > MAXIMUM_ASSESSMENT_AGE_MS) {
    return { status: 503, healthy: false, reason: "ASSESSMENT_STALE" };
  }

  // An empty assignment registry is normal before Task 16 provisions the first
  // worker, and an alert nobody can act on trains people to ignore alerts. Once
  // the operator sets NETWORK_WATCHDOG_MIN_WORKERS, a registry that has lost its
  // workers becomes the alert it should be - which is the one blind spot a
  // heartbeat-only detector otherwise has.
  if (monitoredWorkers < context.minimumWorkers) {
    return { status: 503, healthy: false, reason: "FLEET_UNDER_PROVISIONED" };
  }
  return { status: 200, healthy: true, reason: null };
}

function evaluateMaintenance(data: unknown): Verdict {
  const report = asPlainObject(data);
  if (report === null || report.job !== "MAINTENANCE") {
    return { status: 503, healthy: false, reason: "MAINTENANCE_FAILED" };
  }
  return { status: 200, healthy: true, reason: null };
}

function createServiceRpc(getEnv: (name: string) => string | undefined): RpcCall {
  let client: ServiceRpcClient | undefined;
  return async (name, args) => {
    const supabaseUrl = getEnv("SUPABASE_URL")?.trim();
    const serviceRoleKey = getEnv("SUPABASE_SERVICE_ROLE_KEY")?.trim();
    if (!supabaseUrl || !serviceRoleKey) {
      return { data: null, error: { code: "WATCHDOG_CONFIG_MISSING" } };
    }
    client ??= createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    }) as unknown as ServiceRpcClient;
    const { data, error } = await client.rpc(name, args);
    return {
      data,
      error: error ? { code: error.code, message: error.message } : null,
    };
  };
}

export function createWatchdogHandler(
  dependencies: WatchdogHandlerDependencies = {},
): (request: Request) => Promise<Response> {
  const getEnv = dependencies.getEnv ?? ((name) => Deno.env.get(name));
  const rpc = dependencies.rpc ?? createServiceRpc(getEnv);

  return async (request: Request): Promise<Response> => {
    // Authenticate first, and never read the request body at all: with no body
    // there is no byte cap to get wrong and no unauthenticated read to bound.
    const presented = request.headers.get(SECRET_HEADER) ?? "";
    let authorized: boolean;
    try {
      authorized = await watchdogSecretMatches(
        presented,
        getEnv("NETWORK_WATCHDOG_CRON_SECRET")?.trim(),
      );
    } catch (error) {
      if (error instanceof WatchdogConfigError) {
        return jsonResponse(500, { ok: false, error: "watchdog_config_error" });
      }
      return jsonResponse(500, { ok: false, error: "watchdog_auth_error" });
    }
    if (!authorized) {
      return jsonResponse(401, { ok: false, error: "unauthorized" });
    }

    if (request.method !== "POST") {
      return jsonResponse(405, { ok: false, error: "method_not_allowed" }, {
        allow: "POST",
      });
    }

    const route = ROUTES.get(routeFromUrl(request.url));
    if (!route) {
      return jsonResponse(404, { ok: false, error: "route_not_found" });
    }

    // Both Supabase variables are required for every route. Checking them here
    // rather than inside the RPC client keeps a misconfigured deployment a 500
    // instead of an "indeterminate liveness" alert that would send an operator
    // looking at the worker.
    if (
      !getEnv("SUPABASE_URL")?.trim()
      || !getEnv("SUPABASE_SERVICE_ROLE_KEY")?.trim()
    ) {
      return jsonResponse(500, { ok: false, error: "watchdog_config_error" });
    }

    let staleAfterSeconds: number;
    let minimumWorkers: number;
    try {
      const requested = new URL(request.url).searchParams.get("staleAfterSeconds");
      const configured = getEnv("NETWORK_WATCHDOG_STALE_AFTER_SECONDS")?.trim();
      if (requested !== null) {
        staleAfterSeconds = parseBoundedInteger(requested, "staleAfterSeconds");
      } else if (configured) {
        try {
          staleAfterSeconds = parseBoundedInteger(
            configured,
            "NETWORK_WATCHDOG_STALE_AFTER_SECONDS",
          );
        } catch {
          // A threshold the operator set but this function cannot honour is a
          // configuration fault, not a bad request from the scheduler.
          return jsonResponse(500, { ok: false, error: "watchdog_config_error" });
        }
      } else {
        staleAfterSeconds = DEFAULT_STALE_AFTER_SECONDS;
      }
      const minimum = getEnv("NETWORK_WATCHDOG_MIN_WORKERS")?.trim();
      minimumWorkers = minimum ? Number(minimum) : 0;
      if (!Number.isInteger(minimumWorkers) || minimumWorkers < 0) {
        return jsonResponse(500, { ok: false, error: "watchdog_config_error" });
      }
    } catch (error) {
      if (error instanceof WatchdogRequestError) {
        return jsonResponse(400, { ok: false, error: "invalid_request" });
      }
      return jsonResponse(400, { ok: false, error: "invalid_request" });
    }

    let result: RpcResult;
    try {
      result = await rpc(route.rpcName, route.buildArgs({ staleAfterSeconds }));
    } catch {
      result = { data: null, error: { code: "WATCHDOG_TRANSPORT_ERROR" } };
    }

    if (result.error) {
      // Deliberately no error.message in the body. A PostgreSQL error string can
      // quote the failing statement, and the failing statement is the one the
      // service-role key just ran.
      const verdict = route.evaluate(null, { minimumWorkers, now: Date.now() });
      return jsonResponse(verdict.status, {
        ok: false,
        healthy: false,
        reason: verdict.reason,
        code: result.error.code ?? "UNKNOWN",
      });
    }

    const verdict = route.evaluate(result.data, {
      minimumWorkers,
      now: Date.now(),
    });
    return jsonResponse(verdict.status, {
      ok: true,
      healthy: verdict.healthy,
      reason: verdict.reason,
      report: result.data,
    });
  };
}

if (import.meta.main) {
  Deno.serve(createWatchdogHandler());
}
