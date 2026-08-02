import { describe, expect, it, vi } from "vitest";

import { handleWatchdogRequest, WATCHDOG_HEALTH_RPC, type WatchdogDependencies } from "./handler";

const ORG = "dddd0000-0000-4000-8000-000000000001";
const CELL = "dddd2000-0000-4000-8000-000000000001";
const SECRET = "s".repeat(48);

function dependencies(): WatchdogDependencies {
  return {
    sharedSecret: SECRET,
    probe: vi.fn(async (organizationId) => ({
      version: 1,
      organizationId,
      observedAt: "2026-08-02T00:00:00.000Z",
      probeOk: true,
      heartbeatAt: "2026-08-01T23:59:59.000Z",
      metrics: {},
    })),
    recordHealth: vi.fn(async ({ events }) => ({ recorded: events.length })),
    applyCapacityControls: vi.fn(async () => undefined),
    notifyOwnerAdmins: vi.fn(async () => ({ push: 1, email: 1 })),
    requestIdFactory: () => "request-1",
  };
}

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://project.supabase.co/functions/v1/openclaw-watchdog", {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("openclaw-watchdog Edge handler", () => {
  it("exposes only the dedicated content-free probe operation", async () => {
    const deps = dependencies();
    const response = await handleWatchdogRequest(request({
      version: 1,
      operation: "PROBE",
      organizationId: ORG,
      probeId: "dddd4000-0000-4000-8000-000000000001",
      observedAt: "2026-08-02T00:00:00.000Z",
    }), deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ version: 1, organizationId: ORG, probeOk: true });
    expect(deps.recordHealth).not.toHaveBeenCalled();
  });

  it("records through the narrow watchdog facade and notifies owner/admin once requested", async () => {
    expect(WATCHDOG_HEALTH_RPC).toBe("openclaw_service_record_watchdog_health_v1");
    const deps = dependencies();
    const response = await handleWatchdogRequest(request({
      version: 1,
      operation: "RECORD",
      organizationId: ORG,
      operationId: "dddd4000-0000-4000-8000-000000000002",
      observedAt: "2026-08-02T00:00:00.000Z",
      events: [{
        accountId: null,
        cellId: null,
        severity: "CRITICAL",
        healthKind: "WATCHDOG_HEARTBEAT_STALE",
        status: "OPEN",
        fingerprint: "heartbeat:stale",
        observedAt: "2026-08-02T00:00:00.000Z",
        contentFreeMetrics: { heartbeatAgeSeconds: 91 },
      }],
      controls: ["PAUSE_ALL_OUTBOUND_MEDIA"],
      notification: { fingerprints: ["heartbeat:stale"], repeatWindow: 42, requiredWithinSeconds: 180 },
    }), deps);
    expect(response.status).toBe(200);
    expect(deps.recordHealth).toHaveBeenCalledTimes(1);
    expect(deps.applyCapacityControls).toHaveBeenCalledTimes(1);
    expect(deps.notifyOwnerAdmins).toHaveBeenCalledTimes(1);
  });

  it("accepts host guard pause but never grants automatic resume", async () => {
    const deps = dependencies();
    const response = await handleWatchdogRequest(request({
      version: 1,
      operation: "HOST_GUARD",
      organizationId: ORG,
      operationId: "dddd4000-0000-4000-8000-000000000003",
      observedAt: "2026-08-02T00:00:00.000Z",
      cellId: CELL,
      state: "TRIPPED",
      fingerprint: "host-guard:ram",
      controls: ["PAUSE_OUTBOUND_AI_MEDIA"],
      contentFreeMetrics: { ramPercent: 76 },
    }), deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ manualResumeRequired: true });
    expect(deps.applyCapacityControls).toHaveBeenCalledWith(expect.objectContaining({
      controls: ["PAUSE_OUTBOUND_AI_MEDIA"],
    }));
  });

  it("allows a repeat-window notification without duplicating the incident row", async () => {
    const deps = dependencies();
    const response = await handleWatchdogRequest(request({
      version: 1,
      operation: "RECORD",
      organizationId: ORG,
      operationId: "dddd4000-0000-4000-8000-000000000004",
      observedAt: "2026-08-02T00:15:00.000Z",
      events: [],
      controls: [],
      notification: { fingerprints: ["heartbeat:stale"], repeatWindow: 43, requiredWithinSeconds: 180 },
    }), deps);
    expect(response.status).toBe(200);
    expect(deps.recordHealth).not.toHaveBeenCalled();
    expect(deps.notifyOwnerAdmins).toHaveBeenCalledTimes(1);
  });

  it("rejects browser origins and Gateway-shaped fields before dependencies", async () => {
    const deps = dependencies();
    const browser = await handleWatchdogRequest(request({}, { origin: "https://ptcrm.vercel.app" }), deps);
    expect(browser.status).toBe(403);
    const gateway = await handleWatchdogRequest(request({
      version: 1,
      operation: "PROBE",
      organizationId: ORG,
      probeId: "dddd4000-0000-4000-8000-000000000001",
      observedAt: "2026-08-02T00:00:00.000Z",
      gatewayUrl: "http://cell:18789",
    }), deps);
    expect(gateway.status).toBe(400);
    expect(deps.probe).not.toHaveBeenCalled();
  });
});
