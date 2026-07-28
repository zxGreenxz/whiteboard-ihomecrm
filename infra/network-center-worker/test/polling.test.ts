import { describe, expect, it } from "vitest";

import { InterfaceRegistry } from "../src/domain.js";
import { PollingCoordinator } from "../src/polling.js";
import type { RouterConnector } from "../src/routeros/connector.js";

function connection() {
  return {
    connectionId: "10000000-0000-4000-8000-000000000001",
    organizationId: "20000000-0000-4000-8000-000000000001",
    buildingId: "30000000-0000-4000-8000-000000000001",
    deviceId: "40000000-0000-4000-8000-000000000001",
    deviceKind: "MIKROTIK" as const,
    externalKey: "slot:primary",
    displayName: "Router demo",
    transport: "ROUTEROS_SSH" as const,
    managementIp: "10.88.0.2",
    managementPort: 22,
    credentialRef: "router/demo",
    hostKeyFingerprint: "SHA256:ZmFrZWhvc3RrZXk=",
    pollIntervalSeconds: 60,
    connectTimeoutMs: 5_000,
    monitoringEnabled: true,
    changesPaused: false,
  };
}

describe("polling coordinator", () => {
  it("sends every Aruba through repeated bounded inventory batches", async () => {
    const inventoryPayloads: Array<Record<string, unknown>> = [];
    const ingestPayloads: Array<Record<string, unknown>> = [];
    const heartbeatStatuses: string[] = [];
    const connector: Pick<RouterConnector, "poll" | "close"> = {
      poll: async () => ({
        observedAt: "2026-07-28T00:00:00.000Z",
        device: { reachable: true, identity: "demo" },
        interfaces: Array.from({ length: 300 }, (_, index) => ({
          externalKey: `ether${index}`,
          displayName: `ether${index}`,
          role: "ACCESS",
          protected: false,
          enabled: true,
          sample: { rxBps: index, txBps: index },
        })),
        clients: [],
        aruba: Array.from({ length: 600 }, (_, index) => ({
          externalKey: `aruba-${index}`,
          displayName: `Aruba ${index}`,
          reachable: true,
        })),
      }),
      close: async () => undefined,
    };
    const registry = new InterfaceRegistry();
    const coordinator = new PollingCoordinator({
      api: {
        listConnections: async () => [connection()],
        heartbeat: async (input: { status: string }) => { heartbeatStatuses.push(input.status); },
        ingest: async (payload: Record<string, unknown>) => { ingestPayloads.push(payload); },
        inventory: async (payload: Record<string, unknown>) => {
          inventoryPayloads.push(payload);
          const interfaces = (payload.interfaces as Array<{ interfaceKey: string }>).map((item, index) => ({
            interfaceKey: item.interfaceKey,
            id: `uuid-${inventoryPayloads.length}-${index}`,
          }));
          return { routerDeviceId: connection().deviceId, interfaces, aruba: [] };
        },
        upsertIncident: async () => undefined,
      },
      connectorFactory: async () => connector,
      interfaceRegistry: registry,
      maxConcurrency: 2,
      now: () => new Date("2026-07-28T00:00:00.000Z"),
      startedAt: new Date("2026-07-27T00:00:00.000Z"),
      workerVersion: "test",
      logger: { info() {}, warn() {}, error() {} },
    });

    await coordinator.runCycle();

    expect(inventoryPayloads).toHaveLength(3);
    expect(inventoryPayloads.flatMap((payload) => payload.aruba as unknown[])).toHaveLength(600);
    expect(Math.max(...inventoryPayloads.map((payload) => (payload.aruba as unknown[]).length))).toBe(256);
    expect(inventoryPayloads.flatMap((payload) => payload.interfaces as unknown[])).toHaveLength(300);
    expect(Math.max(...inventoryPayloads.map((payload) => (payload.interfaces as unknown[]).length))).toBe(256);
    expect(ingestPayloads.length).toBeGreaterThan(1);
    expect(heartbeatStatuses.at(-1)).toBe("ONLINE");
  });

  it("isolates a failed router and reconnects on the next cycle", async () => {
    let attempts = 0;
    const incidents: Array<Record<string, unknown>> = [];
    const coordinator = new PollingCoordinator({
      api: {
        listConnections: async () => [connection()],
        heartbeat: async () => undefined,
        ingest: async () => undefined,
        inventory: async () => ({ routerDeviceId: connection().deviceId, interfaces: [], aruba: [] }),
        upsertIncident: async (payload: Record<string, unknown>) => { incidents.push(payload); },
      },
      connectorFactory: async () => ({
        poll: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("connection lost");
          return { observedAt: new Date().toISOString(), device: {}, interfaces: [], clients: [], aruba: [] };
        },
        close: async () => undefined,
      }),
      interfaceRegistry: new InterfaceRegistry(),
      maxConcurrency: 1,
      now: () => new Date(),
      startedAt: new Date(),
      workerVersion: "test",
      logger: { info() {}, warn() {}, error() {} },
    });

    await coordinator.runCycle();
    await coordinator.runCycle();

    expect(attempts).toBe(2);
    expect(incidents).toHaveLength(2);
    expect(incidents[0]).toMatchObject({ resolved: false });
    expect(incidents[1]).toMatchObject({ resolved: true });
  });

  it("reports PAUSED while the emergency stop is active", async () => {
    const statuses: string[] = [];
    const coordinator = new PollingCoordinator({
      api: {
        listConnections: async () => [],
        heartbeat: async (input: { status: string }) => { statuses.push(input.status); },
        ingest: async () => undefined,
        inventory: async () => ({ routerDeviceId: connection().deviceId, interfaces: [], aruba: [] }),
        upsertIncident: async () => undefined,
      },
      connectorFactory: async () => { throw new Error("not called"); },
      interfaceRegistry: new InterfaceRegistry(),
      maxConcurrency: 1,
      now: () => new Date(),
      startedAt: new Date(),
      workerVersion: "test",
      paused: () => true,
      logger: { info() {}, warn() {}, error() {} },
    });

    await coordinator.runCycle();
    expect(statuses).toEqual(["PAUSED"]);
  });
});
