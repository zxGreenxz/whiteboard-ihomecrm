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
          const aruba = (payload.aruba as Array<{ externalKey: string }>).map((item, index) => ({
            externalKey: item.externalKey,
            id: `aruba-uuid-${inventoryPayloads.length}-${index}`,
          }));
          return { routerDeviceId: connection().deviceId, interfaces, aruba };
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
    expect(ingestPayloads.flatMap((payload) => payload.devices as unknown[])).toHaveLength(601);
    expect(Math.max(...ingestPayloads.map((payload) => (payload.devices as unknown[]).length))).toBe(256);
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

  it("emits incident updates only on reachability transitions", async () => {
    let incidentCalls = 0;
    const coordinator = new PollingCoordinator({
      api: {
        listConnections: async () => [connection()],
        heartbeat: async () => undefined,
        ingest: async () => undefined,
        inventory: async () => ({ routerDeviceId: connection().deviceId, interfaces: [], aruba: [] }),
        upsertIncident: async () => { incidentCalls += 1; },
      },
      connectorFactory: async () => ({
        poll: async () => { throw new Error("offline"); },
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
    expect(incidentCalls).toBe(1);
  });

  it("reuses stable inventory mappings between telemetry polls", async () => {
    let inventoryCalls = 0;
    let ingestCalls = 0;
    const coordinator = new PollingCoordinator({
      api: {
        listConnections: async () => [connection()],
        heartbeat: async () => undefined,
        inventory: async () => {
          inventoryCalls += 1;
          return {
            routerDeviceId: connection().deviceId,
            interfaces: [{ interfaceKey: "ether2", id: "interface-id" }],
            aruba: [],
          };
        },
        ingest: async () => { ingestCalls += 1; },
        upsertIncident: async () => undefined,
      },
      connectorFactory: async () => ({
        poll: async () => ({
          observedAt: new Date().toISOString(),
          device: {},
          interfaces: [{
            externalKey: "ether2",
            displayName: "ether2",
            role: "ACCESS",
            protected: false,
            enabled: true,
          }],
          clients: [],
          aruba: [],
        }),
        close: async () => undefined,
      }),
      interfaceRegistry: new InterfaceRegistry(),
      maxConcurrency: 1,
      now: () => new Date("2026-07-28T00:00:00.000Z"),
      startedAt: new Date(),
      workerVersion: "test",
      logger: { info() {}, warn() {}, error() {} },
    });

    await coordinator.runCycle();
    await coordinator.runCycle();
    expect(inventoryCalls).toBe(1);
    expect(ingestCalls).toBe(2);
  });

  it("combines telemetry from multiple buildings into bounded ingest calls", async () => {
    const second = {
      ...connection(),
      connectionId: "10000000-0000-4000-8000-000000000002",
      buildingId: "30000000-0000-4000-8000-000000000002",
      deviceId: "40000000-0000-4000-8000-000000000002",
    };
    const payloads: Array<Record<string, unknown>> = [];
    const coordinator = new PollingCoordinator({
      api: {
        listConnections: async () => [connection(), second],
        heartbeat: async () => undefined,
        inventory: async (payload: Record<string, unknown>) => ({
          routerDeviceId: String(payload.routerDeviceId),
          interfaces: [],
          aruba: [],
        }),
        ingest: async (payload: Record<string, unknown>) => { payloads.push(payload); },
        upsertIncident: async () => undefined,
      },
      connectorFactory: async (item) => ({
        poll: async () => ({
          observedAt: "2026-07-28T00:00:00.000Z",
          device: { identity: item.displayName },
          interfaces: [],
          clients: [],
          aruba: [],
        }),
        close: async () => undefined,
      }),
      interfaceRegistry: new InterfaceRegistry(),
      maxConcurrency: 2,
      now: () => new Date("2026-07-28T00:00:00.000Z"),
      startedAt: new Date(),
      workerVersion: "test",
      logger: { info() {}, warn() {}, error() {} },
    });

    await coordinator.runCycle();
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.devices).toHaveLength(2);
  });

  it("marks a previously discovered Aruba offline when it disappears", async () => {
    let pollNo = 0;
    const payloads: Array<Record<string, unknown>> = [];
    const coordinator = new PollingCoordinator({
      api: {
        listConnections: async () => [connection()],
        heartbeat: async () => undefined,
        inventory: async (payload: Record<string, unknown>) => ({
          routerDeviceId: connection().deviceId,
          interfaces: [],
          aruba: (payload.aruba as Array<{ externalKey: string }>).map((item) => ({
            externalKey: item.externalKey,
            id: "aruba-current-id",
          })),
        }),
        ingest: async (payload: Record<string, unknown>) => { payloads.push(payload); },
        upsertIncident: async () => undefined,
      },
      connectorFactory: async () => ({
        poll: async () => {
          pollNo += 1;
          return {
            observedAt: "2026-07-28T00:00:00.000Z",
            device: {},
            interfaces: [],
            clients: [],
            aruba: pollNo === 1
              ? [{ externalKey: "ap-1", displayName: "AP 1", reachable: true }]
              : [],
          };
        },
        close: async () => undefined,
      }),
      interfaceRegistry: new InterfaceRegistry(),
      maxConcurrency: 1,
      now: () => new Date("2026-07-28T00:00:00.000Z"),
      startedAt: new Date(),
      workerVersion: "test",
      logger: { info() {}, warn() {}, error() {} },
    });

    await coordinator.runCycle();
    await coordinator.runCycle();
    expect(payloads[1]?.devices).toEqual(expect.arrayContaining([
      expect.objectContaining({ deviceId: "aruba-current-id", reachable: false }),
    ]));
  });
});
