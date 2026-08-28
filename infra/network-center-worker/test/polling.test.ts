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
  it("never upgrades a database-revoked interface from live observation fields", async () => {
    const registry = new InterfaceRegistry();
    const authoritativeMapping = {
      managedResourceId: "50000000-0000-4000-8000-000000000001",
      id: "60000000-0000-4000-8000-000000000001",
      interfaceKey: "ether4",
      currentName: "room-401",
      immutableKey: "ether4",
      enrolledRole: "ACCESS",
      protected: false,
      enrollmentState: "REVOKED" as const,
    };
    const coordinator = new PollingCoordinator({
      api: {
        listConnections: async () => [connection()],
        heartbeat: async () => undefined,
        ingest: async () => undefined,
        inventory: async () => ({
          routerDeviceId: connection().deviceId,
          interfaces: [authoritativeMapping],
          aruba: [],
        }),
        upsertIncident: async () => undefined,
      },
      connectorFactory: async () => ({
        poll: async () => ({
          observedAt: "2026-07-28T00:00:00.000Z",
          device: { reachable: true },
          interfaces: [{
            externalKey: "ether4",
            displayName: "room-401",
            immutableKey: "ether4",
            role: "ACCESS",
            protected: false,
            enabled: true,
          }],
          clients: [],
          h196a: [],
          aruba: [],
        }),
        close: async () => undefined,
      }),
      interfaceRegistry: registry,
      maxConcurrency: 1,
      now: () => new Date("2026-07-28T00:00:00.000Z"),
      startedAt: new Date("2026-07-27T00:00:00.000Z"),
      workerVersion: "test",
      logger: { info() {}, warn() {}, error() {} },
    });

    await coordinator.runCycle();

    expect(registry.resolve(connection().deviceId, authoritativeMapping.id)).toBeNull();
  });

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
        h196a: [],
        aruba: Array.from({ length: 600 }, (_, index) => ({
          stableIdentity: `SERIAL-${index}`,
          identitySource: "SERIAL" as const,
          externalKey: `serial:SERIAL-${index}`,
          aliases: [`Aruba ${index}`],
          displayName: `Aruba ${index}`,
          displayOnly: true as const,
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
            managedResourceId: `managed-${inventoryPayloads.length}-${index}`,
            interfaceKey: item.interfaceKey,
            id: `uuid-${inventoryPayloads.length}-${index}`,
            currentName: item.interfaceKey,
            immutableKey: item.interfaceKey,
            enrolledRole: "ACCESS" as const,
            protected: false,
            enrollmentState: "ENROLLED" as const,
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
    expect(registry.resolve(connection().deviceId, "uuid-1-2")).toMatchObject({
      managedResourceId: "managed-1-2",
      immutableKey: "ether2",
      enrollmentState: "ENROLLED",
    });
  });

  it("keeps one discovery run across batches and degrades inventory without declaring a router outage", async () => {
    const inventoryPayloads: Array<Record<string, unknown>> = [];
    const ingestPayloads: Array<Record<string, unknown>> = [];
    const incidents: Array<Record<string, unknown>> = [];
    const connector: Pick<RouterConnector, "poll" | "close"> = {
      poll: async () => ({
        observedAt: "2026-07-28T00:00:00.000Z",
        device: { reachable: true, identity: "demo" },
        interfaces: [],
        clients: [],
        h196a: [],
        aruba: Array.from({ length: 300 }, (_, index) => ({
          stableIdentity: `SERIAL-${index}`,
          identitySource: "SERIAL" as const,
          externalKey: `serial:SERIAL-${index}`,
          aliases: [`Aruba ${index}`],
          displayName: `Aruba ${index}`,
          displayOnly: true as const,
          reachable: true,
        })),
        arubaQuarantine: [{
          code: "ARUBA_STABLE_IDENTITY_INVALID" as const,
          fingerprint: "a".repeat(64),
        }],
      }),
      close: async () => undefined,
    };
    const coordinator = new PollingCoordinator({
      api: {
        listConnections: async () => [connection()],
        heartbeat: async () => undefined,
        ingest: async (payload: Record<string, unknown>) => { ingestPayloads.push(payload); },
        inventory: async (payload: Record<string, unknown>) => {
          inventoryPayloads.push(payload);
          const batchIndex = Number(payload.batchIndex);
          return {
            routerDeviceId: connection().deviceId,
            interfaces: [],
            aruba: (payload.aruba as Array<{ externalKey: string }>).map((item) => ({
              externalKey: item.externalKey,
              id: `mapped-${item.externalKey}`,
            })),
            inventoryStatus: "DEGRADED",
            quarantinedCount: batchIndex === 0 ? 1 : 2,
          };
        },
        upsertIncident: async (payload: Record<string, unknown>) => { incidents.push(payload); },
      },
      connectorFactory: async () => connector,
      interfaceRegistry: new InterfaceRegistry(),
      maxConcurrency: 1,
      now: () => new Date("2026-07-28T00:00:00.000Z"),
      startedAt: new Date("2026-07-27T00:00:00.000Z"),
      workerVersion: "test",
      logger: { info() {}, warn() {}, error() {} },
    });

    await coordinator.runCycle();

    expect(inventoryPayloads).toHaveLength(2);
    expect(new Set(inventoryPayloads.map((payload) => payload.discoveryRunId)).size).toBe(1);
    expect(inventoryPayloads[0]?.discoveryRunId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(inventoryPayloads.map((payload) => payload.batchIndex)).toEqual([0, 1]);
    expect(inventoryPayloads.every((payload) => payload.batchCount === 2)).toBe(true);
    expect(inventoryPayloads.every(
      (payload) => payload.observedAt === "2026-07-28T00:00:00.000Z",
    )).toBe(true);
    expect(inventoryPayloads.flatMap(
      (payload) => (payload.quarantine ?? []) as unknown[],
    )).toHaveLength(1);
    expect(ingestPayloads.flatMap((payload) => payload.devices as unknown[])).toHaveLength(301);
    expect(incidents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        incidentType: "INVENTORY_DEGRADED",
        resolved: false,
        observedValues: { quarantinedCount: 3 },
      }),
    ]));
    expect(incidents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ incidentType: "ROUTER_UNREACHABLE", resolved: false }),
    ]));
  });

  it("keeps router telemetry when inventory RPC fails and never opens a router outage", async () => {
    const ingestPayloads: Array<Record<string, unknown>> = [];
    const incidents: Array<Record<string, unknown>> = [];
    const heartbeatStatuses: string[] = [];
    const registry = new InterfaceRegistry();
    registry.update(connection().deviceId, [{
      managedResourceId: "50000000-0000-4000-8000-000000000001",
      id: "60000000-0000-4000-8000-000000000001",
      interfaceKey: "ether4",
      currentName: "room-401",
      immutableKey: "ether4",
      enrolledRole: "ACCESS",
      protected: false,
      enrollmentState: "ENROLLED",
    }]);
    const coordinator = new PollingCoordinator({
      api: {
        listConnections: async () => [connection()],
        heartbeat: async (input: { status: string }) => { heartbeatStatuses.push(input.status); },
        ingest: async (payload: Record<string, unknown>) => { ingestPayloads.push(payload); },
        inventory: async () => { throw new Error("inventory control plane unavailable"); },
        upsertIncident: async (payload: Record<string, unknown>) => { incidents.push(payload); },
      },
      connectorFactory: async () => ({
        poll: async () => ({
          observedAt: "2026-07-28T00:00:00.000Z",
          device: { reachable: true, identity: "demo" },
          interfaces: [],
          clients: [],
          h196a: [],
          aruba: [],
        }),
        close: async () => undefined,
      }),
      interfaceRegistry: registry,
      maxConcurrency: 1,
      now: () => new Date("2026-07-28T00:00:00.000Z"),
      startedAt: new Date("2026-07-27T00:00:00.000Z"),
      workerVersion: "test",
      logger: { info() {}, warn() {}, error() {} },
    });

    await coordinator.runCycle();

    expect(registry.resolve(
      connection().deviceId,
      "60000000-0000-4000-8000-000000000001",
    )).toBeNull();

    expect(ingestPayloads.flatMap((payload) => payload.devices as unknown[])).toEqual([
      expect.objectContaining({ deviceId: connection().deviceId, reachable: true }),
    ]);
    expect(incidents).toEqual(expect.arrayContaining([
      expect.objectContaining({ incidentType: "INVENTORY_DEGRADED", resolved: false }),
    ]));
    expect(incidents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ incidentType: "ROUTER_UNREACHABLE", resolved: false }),
    ]));
    expect(heartbeatStatuses.at(-1)).toBe("DEGRADED");
  });

  it("uses distinct idempotency keys to resolve inventory degradation on the next clean poll", async () => {
    let pollNo = 0;
    const incidents: Array<Record<string, unknown>> = [];
    const coordinator = new PollingCoordinator({
      api: {
        listConnections: async () => [connection()],
        heartbeat: async () => undefined,
        ingest: async () => undefined,
        inventory: async (payload: Record<string, unknown>) => ({
          routerDeviceId: connection().deviceId,
          interfaces: [],
          aruba: [],
          inventoryStatus: (payload.quarantine as unknown[]).length > 0 ? "DEGRADED" : "OK",
          quarantinedCount: (payload.quarantine as unknown[]).length,
        }),
        upsertIncident: async (payload: Record<string, unknown>) => { incidents.push(payload); },
      },
      connectorFactory: async () => ({
        poll: async () => {
          pollNo += 1;
          return {
            observedAt: `2026-07-28T00:0${pollNo}:00.000Z`,
            device: { reachable: true },
            interfaces: [],
            clients: [],
            h196a: [],
            aruba: [],
            arubaQuarantine: pollNo === 1
              ? [{ code: "ARUBA_STABLE_IDENTITY_INVALID" as const, fingerprint: "a".repeat(64) }]
              : [],
          };
        },
        close: async () => undefined,
      }),
      interfaceRegistry: new InterfaceRegistry(),
      maxConcurrency: 1,
      now: () => new Date("2026-07-28T00:00:00.000Z"),
      startedAt: new Date("2026-07-27T00:00:00.000Z"),
      workerVersion: "test",
      inventoryRefreshIntervalMs: 0,
      logger: { info() {}, warn() {}, error() {} },
    });

    await coordinator.runCycle();
    await coordinator.runCycle();

    const inventoryIncidents = incidents.filter(
      (item) => item.incidentType === "INVENTORY_DEGRADED",
    );
    expect(inventoryIncidents).toHaveLength(2);
    expect(inventoryIncidents.map((item) => item.resolved)).toEqual([false, true]);
    expect(new Set(inventoryIncidents.map((item) => item.eventKey)).size).toBe(2);
  });

  it("isolates a failed router and reconnects on the next cycle", async () => {
    let attempts = 0;
    const incidents: Array<Record<string, unknown>> = [];
    const registry = new InterfaceRegistry();
    registry.update(connection().deviceId, [{
      managedResourceId: "50000000-0000-4000-8000-000000000001",
      id: "60000000-0000-4000-8000-000000000001",
      interfaceKey: "ether4",
      currentName: "room-401",
      immutableKey: "ether4",
      enrolledRole: "ACCESS",
      protected: false,
      enrollmentState: "ENROLLED",
    }]);
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
          return { observedAt: new Date().toISOString(), device: {}, interfaces: [], clients: [], h196a: [], aruba: [] };
        },
        close: async () => undefined,
      }),
      interfaceRegistry: registry,
      maxConcurrency: 1,
      now: () => new Date(),
      startedAt: new Date(),
      workerVersion: "test",
      logger: { info() {}, warn() {}, error() {} },
    });

    await coordinator.runCycle();
    expect(registry.resolve(
      connection().deviceId,
      "60000000-0000-4000-8000-000000000001",
    )).toBeNull();
    await coordinator.runCycle();

    expect(attempts).toBe(2);
    const routerIncidents = incidents.filter(
      (item) => item.incidentType === "ROUTER_UNREACHABLE",
    );
    expect(routerIncidents).toHaveLength(2);
    expect(routerIncidents[0]).toMatchObject({ resolved: false });
    expect(routerIncidents[1]).toMatchObject({ resolved: true });
    expect(new Set(routerIncidents.map((item) => item.eventKey)).size).toBe(2);
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
            interfaces: [{
              managedResourceId: "managed-resource-id",
              interfaceKey: "ether2",
              id: "interface-id",
              currentName: "ether2",
              immutableKey: "ether2",
              enrolledRole: "ACCESS",
              protected: false,
              enrollmentState: "ENROLLED",
            }],
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
          h196a: [],
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
          h196a: [],
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
            h196a: [],
            aruba: pollNo === 1
              ? [{
                stableIdentity: "AP-1",
                identitySource: "SERIAL" as const,
                externalKey: "serial:AP-1",
                aliases: ["AP 1"],
                displayName: "AP 1",
                displayOnly: true as const,
                reachable: true,
              }]
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
