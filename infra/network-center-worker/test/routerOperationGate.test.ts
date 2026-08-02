import { describe, expect, it } from "vitest";

import type { BackupStore } from "../src/backupStore.js";
import { CommandProcessor } from "../src/commands.js";
import { AsyncSemaphore } from "../src/concurrency.js";
import {
  InterfaceRegistry,
  type CommandClaim,
  type NetworkConnection,
} from "../src/domain.js";
import { PollingCoordinator } from "../src/polling.js";
import type { RouterConnector } from "../src/routeros/connector.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Condition was not reached");
}

function connection(deviceId: string): NetworkConnection {
  return {
    connectionId: `10000000-0000-4000-8000-${deviceId.slice(-12)}`,
    organizationId: "20000000-0000-4000-8000-000000000001",
    buildingId: "30000000-0000-4000-8000-000000000001",
    deviceId,
    deviceKind: "MIKROTIK",
    externalKey: `slot:${deviceId}`,
    displayName: "Router gate test",
    transport: "ROUTEROS_SSH",
    managementIp: "10.88.0.2",
    managementPort: 22,
    credentialRef: "router/test",
    hostKeyFingerprint: "SHA256:ZmFrZWhvc3RrZXk=",
    pollIntervalSeconds: 60,
    connectTimeoutMs: 5_000,
    monitoringEnabled: true,
    changesPaused: false,
  };
}

function claim(commandId: string, leaseToken: string, deviceId: string): CommandClaim {
  return {
    commandId,
    organizationId: "20000000-0000-4000-8000-000000000001",
    buildingId: "30000000-0000-4000-8000-000000000001",
    deviceId,
    interfaceId: null,
    actionType: "FLUSH_DNS_CACHE",
    reason: "Gate ordering test",
    parameters: {},
    attemptNo: 1,
    leaseToken,
    leaseExpiresAt: "2026-07-28T00:02:00.000Z",
    reconciliation: true,
    intentType: "FLUSH_DNS_CACHE",
    managedTarget: {},
    preObservation: {
      observedAt: "2026-07-28T00:00:00.000Z",
      reachable: true,
    },
    expectedPostcondition: { kind: "FLUSH_DNS_CACHE" },
    observationDeadline: "2026-07-28T00:05:00.000Z",
    transitionVersion: 3,
    fencingGeneration: 9,
  };
}

describe("shared RouterOS operation gate", () => {
  it("caps three polling and three command slots at three process-wide connectors", async () => {
    const routerOperationSemaphore = new AsyncSemaphore(3);
    const releaseOperations = deferred();
    let active = 0;
    let maximumActive = 0;
    let starts = 0;

    const connectorFactory = async (): Promise<RouterConnector> => {
      starts += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      return {
        poll: async () => {
          await releaseOperations.promise;
          return {
            observedAt: "2026-07-28T00:00:15.000Z",
            device: { reachable: true },
            interfaces: [],
            clients: [],
            aruba: [],
          };
        },
        captureBackup: async () => { throw new Error("not used"); },
        healthCheck: async () => ({ reachable: true, wanUp: true, dnsOk: true }),
        observeAction: async () => {
          await releaseOperations.promise;
          return {
            observedAt: "2026-07-28T00:00:15.000Z",
            reachable: true,
            dns: { commandAck: true },
          };
        },
        flushDnsCache: async () => undefined,
        renewDhcpLease: async () => true,
        cycleAccessPort: async () => undefined,
        reboot: async () => undefined,
        close: async () => {
          active -= 1;
        },
      };
    };
    const processor = new CommandProcessor({
      api: {
        renewLease: async () => undefined,
        stage: async () => undefined,
        observe: async (input) => ({
          accepted: true,
          transitionVersion: input.transitionVersion + 1,
        }),
        complete: async () => undefined,
        snapshot: async () => undefined,
      },
      connectorFactory,
      backupStore: {
        pressure: async () => ({ state: "OK", volumeBytes: 0, freeBytes: 1 }),
        assertReserve: async () => ({ state: "OK", volumeBytes: 0, freeBytes: 1 }),
        saveVerified: async () => { throw new Error("not used"); },
        rotate: async () => ({ deleted: 0, reclaimedBytes: 0, remainingBytes: 0 }),
      },
      interfaceRegistry: new InterfaceRegistry(),
      emergencyStop: () => false,
      clock: {
        now: () => new Date("2026-07-28T00:00:15.000Z"),
        setInterval: () => 1,
        clearInterval: () => undefined,
        sleep: async () => undefined,
      },
      leaseSeconds: 90,
      logger: { info() {}, warn() {}, error() {} },
      routerOperationSemaphore,
    });
    const pollConnections = Array.from({ length: 3 }, (_, index) =>
      connection(`40000000-0000-4000-8000-00000000010${index + 1}`));
    const polling = new PollingCoordinator({
      api: {
        listConnections: async () => pollConnections,
        heartbeat: async () => undefined,
        ingest: async () => undefined,
        inventory: async (payload) => ({
          routerDeviceId: String(payload.routerDeviceId),
          interfaces: [],
          aruba: [],
        }),
        upsertIncident: async () => undefined,
      },
      connectorFactory,
      interfaceRegistry: new InterfaceRegistry(),
      maxConcurrency: 3,
      now: () => new Date("2026-07-28T00:00:15.000Z"),
      startedAt: new Date("2026-07-28T00:00:00.000Z"),
      workerVersion: "test",
      logger: { info() {}, warn() {}, error() {} },
      routerOperationSemaphore,
    });
    const commandRuns = Array.from({ length: 3 }, (_, index) => {
      const deviceId = `40000000-0000-4000-8000-00000000020${index + 1}`;
      return processor.processClaim(
        claim(
          `50000000-0000-4000-8000-00000000010${index + 1}`,
          `60000000-0000-4000-8000-00000000010${index + 1}`,
          deviceId,
        ),
        connection(deviceId),
      );
    });
    const pollRun = polling.runCycle();

    try {
      await waitUntil(() => starts >= 3);
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
      expect(starts).toBe(3);
      expect(maximumActive).toBe(3);
    } finally {
      releaseOperations.resolve();
      await Promise.allSettled([...commandRuns, pollRun]);
    }

    expect(starts).toBe(6);
    expect(maximumActive).toBe(3);
    expect(active).toBe(0);
  });

  it("admits polling after the current command closes and before its same-device successor", async () => {
    const commandDeviceId = "40000000-0000-4000-8000-000000000001";
    const pollDeviceId = "40000000-0000-4000-8000-000000000002";
    const commandConnection = connection(commandDeviceId);
    const pollConnection = connection(pollDeviceId);
    const routerOperationSemaphore = new AsyncSemaphore(1);
    const starts: string[] = [];
    const closeStarts: string[] = [];
    const operationBlocks: Array<{ label: string; release: () => void }> = [];
    const closeBlocks: Array<{ label: string; release: () => void }> = [];
    let commandConnectorCount = 0;
    let draining = false;

    const block = async (
      blocks: Array<{ label: string; release: () => void }>,
      label: string,
    ): Promise<void> => {
      if (draining) return;
      const gate = deferred();
      blocks.push({ label, release: gate.resolve });
      await gate.promise;
    };
    const release = (
      blocks: Array<{ label: string; release: () => void }>,
      label: string,
    ) => {
      const item = blocks.find((candidate) => candidate.label === label);
      if (!item) throw new Error(`Missing ${label} block`);
      item.release();
    };

    const connectorFactory = async (item: NetworkConnection): Promise<RouterConnector> => {
      const label = item.deviceId === pollDeviceId
        ? "poll"
        : `command-${++commandConnectorCount}`;
      starts.push(label);
      return {
        poll: async () => {
          await block(operationBlocks, label);
          return {
            observedAt: "2026-07-28T00:00:15.000Z",
            device: { reachable: true },
            interfaces: [],
            clients: [],
            aruba: [],
          };
        },
        captureBackup: async () => { throw new Error("not used"); },
        healthCheck: async () => ({ reachable: true, wanUp: true, dnsOk: true }),
        observeAction: async () => {
          await block(operationBlocks, label);
          return {
            observedAt: "2026-07-28T00:00:15.000Z",
            reachable: true,
            dns: { commandAck: true },
          };
        },
        flushDnsCache: async () => undefined,
        renewDhcpLease: async () => true,
        cycleAccessPort: async () => undefined,
        reboot: async () => undefined,
        close: async () => {
          closeStarts.push(label);
          await block(closeBlocks, label);
        },
      };
    };

    const backupStore: BackupStore = {
      pressure: async () => ({ state: "OK", volumeBytes: 0, freeBytes: 1 }),
      assertReserve: async () => ({ state: "OK", volumeBytes: 0, freeBytes: 1 }),
      saveVerified: async () => { throw new Error("not used"); },
      rotate: async () => ({ deleted: 0, reclaimedBytes: 0, remainingBytes: 0 }),
    };
    const processor = new CommandProcessor({
      api: {
        renewLease: async () => undefined,
        stage: async () => undefined,
        observe: async (input) => ({
          accepted: true,
          transitionVersion: input.transitionVersion + 1,
        }),
        complete: async () => undefined,
        snapshot: async () => undefined,
      },
      connectorFactory,
      backupStore,
      interfaceRegistry: new InterfaceRegistry(),
      emergencyStop: () => false,
      clock: {
        now: () => new Date("2026-07-28T00:00:15.000Z"),
        setInterval: () => 1,
        clearInterval: () => undefined,
        sleep: async () => undefined,
      },
      leaseSeconds: 90,
      logger: { info() {}, warn() {}, error() {} },
      routerOperationSemaphore,
    });
    const polling = new PollingCoordinator({
      api: {
        listConnections: async () => [pollConnection],
        heartbeat: async () => undefined,
        ingest: async () => undefined,
        inventory: async (payload) => ({
          routerDeviceId: String(payload.routerDeviceId),
          interfaces: [],
          aruba: [],
        }),
        upsertIncident: async () => undefined,
      },
      connectorFactory,
      interfaceRegistry: new InterfaceRegistry(),
      maxConcurrency: 3,
      now: () => new Date("2026-07-28T00:00:15.000Z"),
      startedAt: new Date("2026-07-28T00:00:00.000Z"),
      workerVersion: "test",
      logger: { info() {}, warn() {}, error() {} },
      routerOperationSemaphore,
    });

    const first = processor.processClaim(
      claim(
        "50000000-0000-4000-8000-000000000001",
        "60000000-0000-4000-8000-000000000001",
        commandDeviceId,
      ),
      commandConnection,
    );
    await waitUntil(() => operationBlocks.some((item) => item.label === "command-1"));
    const second = processor.processClaim(
      claim(
        "50000000-0000-4000-8000-000000000002",
        "60000000-0000-4000-8000-000000000002",
        commandDeviceId,
      ),
      commandConnection,
    );
    const poll = polling.runCycle();

    try {
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
      expect(starts).toEqual(["command-1"]);

      release(operationBlocks, "command-1");
      await waitUntil(() => closeStarts.includes("command-1"));
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
      expect(starts).toEqual(["command-1"]);

      release(closeBlocks, "command-1");
      await waitUntil(() => starts.length === 2);
      expect(starts).toEqual(["command-1", "poll"]);

      release(operationBlocks, "poll");
      await waitUntil(() => closeStarts.includes("poll"));
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
      expect(starts).toEqual(["command-1", "poll"]);

      release(closeBlocks, "poll");
      await waitUntil(() => starts.length === 3);
      expect(starts).toEqual(["command-1", "poll", "command-2"]);

      await waitUntil(() => operationBlocks.some((item) => item.label === "command-2"));
      release(operationBlocks, "command-2");
      await waitUntil(() => closeStarts.includes("command-2"));
      release(closeBlocks, "command-2");
    } finally {
      draining = true;
      for (const item of operationBlocks) item.release();
      for (const item of closeBlocks) item.release();
      await Promise.allSettled([first, second, poll]);
    }
  });
});
