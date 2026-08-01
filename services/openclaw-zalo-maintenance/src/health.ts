import { createServer, type Server } from "node:http";

export interface MaintenanceHealthSnapshot {
  retentionReady: boolean;
  auditReady: boolean;
  runtimeReachable: boolean;
  stale: boolean;
}

export interface MaintenanceUnresolvedFailures {
  retentionDelete: number;
  auditAnchor: number;
}

export interface MaintenanceHealthState {
  markRuntimeHealthy(at?: Date): void;
  markRuntimeFailure(): void;
  hydrateUnresolvedFailures(value: MaintenanceUnresolvedFailures): void;
  markWorkFailureReported(
    kind: "RETENTION_DELETE" | "AUDIT_ANCHOR",
    workItemId: string,
  ): void;
  markWorkHealthy(kind: "RETENTION_DELETE" | "AUDIT_ANCHOR", workItemId: string): void;
  markWorkFailure(kind: "RETENTION_DELETE" | "AUDIT_ANCHOR", workItemId: string): void;
  snapshot(at?: Date): MaintenanceHealthSnapshot;
}

export function createMaintenanceHealthState(
  options: { staleAfterMs?: number } = {},
): MaintenanceHealthState {
  const staleAfterMs = options.staleAfterMs ?? 90_000;
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 1_000 || staleAfterMs > 3_600_000) {
    throw new TypeError("maintenance staleAfterMs is invalid");
  }
  let runtimeReachable = false;
  let lastHealthyAtEpochMs: number | null = null;
  let retentionValidated = false;
  let auditValidated = false;
  let retentionUnresolved = 0;
  let auditUnresolved = 0;
  const retentionFailures = new Set<string>();
  const auditFailures = new Set<string>();
  return Object.freeze({
    markRuntimeHealthy(at = new Date()) {
      if (!Number.isFinite(at.getTime())) throw new TypeError("health timestamp is invalid");
      runtimeReachable = true;
      lastHealthyAtEpochMs = at.getTime();
    },
    markRuntimeFailure() {
      runtimeReachable = false;
    },
    hydrateUnresolvedFailures(value: MaintenanceUnresolvedFailures) {
      if (
        !Number.isSafeInteger(value.retentionDelete) || value.retentionDelete < 0 ||
        !Number.isSafeInteger(value.auditAnchor) || value.auditAnchor < 0
      ) throw new TypeError("maintenance unresolved failure counts are invalid");
      retentionUnresolved = value.retentionDelete;
      auditUnresolved = value.auditAnchor;
    },
    markWorkFailureReported(
      kind: "RETENTION_DELETE" | "AUDIT_ANCHOR",
      workItemId: string,
    ) {
      if (kind === "RETENTION_DELETE") {
        retentionFailures.delete(workItemId);
        retentionUnresolved += 1;
      } else {
        auditFailures.delete(workItemId);
        auditUnresolved += 1;
      }
    },
    markWorkHealthy(kind: "RETENTION_DELETE" | "AUDIT_ANCHOR", workItemId: string) {
      if (kind === "RETENTION_DELETE") {
        retentionValidated = true;
        retentionFailures.delete(workItemId);
      } else {
        auditValidated = true;
        auditFailures.delete(workItemId);
      }
    },
    markWorkFailure(kind: "RETENTION_DELETE" | "AUDIT_ANCHOR", workItemId: string) {
      if (kind === "RETENTION_DELETE") retentionFailures.add(workItemId);
      else auditFailures.add(workItemId);
    },
    snapshot(at = new Date()): MaintenanceHealthSnapshot {
      if (!Number.isFinite(at.getTime())) throw new TypeError("health timestamp is invalid");
      const stale = lastHealthyAtEpochMs === null ||
        at.getTime() - lastHealthyAtEpochMs > staleAfterMs ||
        at.getTime() < lastHealthyAtEpochMs;
      const runtimeReady = runtimeReachable && !stale;
      return {
        retentionReady: runtimeReady && retentionValidated && retentionUnresolved === 0 &&
          retentionFailures.size === 0,
        auditReady: runtimeReady && auditValidated && auditUnresolved === 0 &&
          auditFailures.size === 0,
        runtimeReachable,
        stale,
      };
    },
  });
}

export function maintenanceHealthResponse(
  path: string,
  health: MaintenanceHealthState,
  at = new Date(),
): { status: number; body: Record<string, unknown> } {
  if (path === "/livez") return { status: 200, body: { version: 1, live: true } };
  if (path === "/readyz") {
    const snapshot = health.snapshot(at);
    return {
      status: snapshot.retentionReady && snapshot.auditReady ? 200 : 503,
      body: { version: 1, ...snapshot },
    };
  }
  return { status: 404, body: { version: 1, error: "NOT_FOUND" } };
}

export function createMaintenanceHealthServer({
  health,
  now,
}: {
  health: MaintenanceHealthState;
  now?: () => Date;
}): Server {
  return createServer((request, response) => {
    if (request.method !== "GET" || request.url === undefined) {
      response.writeHead(404, {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      });
      response.end('{"error":"NOT_FOUND","version":1}');
      return;
    }
    const url = new URL(request.url, "http://maintenance.invalid");
    const result = maintenanceHealthResponse(url.pathname, health, now?.() ?? new Date());
    const body = JSON.stringify(result.body);
    response.writeHead(result.status, {
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(body),
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    });
    response.end(body);
  });
}

export function closeMaintenanceHealthServer(
  server: Server,
  forceAfterMs = 1_000,
): Promise<void> {
  if (!Number.isSafeInteger(forceAfterMs) || forceAfterMs < 10 || forceAfterMs > 30_000) {
    throw new TypeError("health shutdown bound is invalid");
  }
  return new Promise((resolve, reject) => {
    const forceClose = setTimeout(() => server.closeAllConnections(), forceAfterMs);
    server.close((error) => {
      clearTimeout(forceClose);
      if (error) reject(error);
      else resolve();
    });
    server.closeIdleConnections();
  });
}

/** Compatibility helper for pure readiness callers. */
export function evaluateMaintenanceReadiness(input: {
  credentialValid: boolean;
  leaseActive: boolean;
  fencingCurrent: boolean;
}): Pick<MaintenanceHealthSnapshot, "retentionReady" | "auditReady"> {
  const ready = input.credentialValid && input.leaseActive && input.fencingCurrent;
  return { retentionReady: ready, auditReady: ready };
}
