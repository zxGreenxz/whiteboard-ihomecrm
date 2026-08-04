import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ApiClientError } from "../src/apiClient.js";
import {
  CommandCoordinator,
  CommandProcessor,
  OBSERVATION_READ_HEADROOM_MS,
  REBOOT_SETTLE_BUDGET_SHARE,
  rebootSettleCeilingMs,
  sanitizeRouterExport,
} from "../src/commands.js";
import type { BackupStore } from "../src/backupStore.js";
import { AsyncSemaphore } from "../src/concurrency.js";
import { InterfaceRegistry, RouterOperationError, type WorkerClock } from "../src/domain.js";
import { FilePortCycleEvidenceStore, type PortCycleEvidenceStore } from "../src/portCycleEvidence.js";
import type { RouterConnector } from "../src/routeros/connector.js";

const temporaryDirectories: string[] = [];

async function evidenceDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "network-center-cycle-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterAll(async () => {
  for (const directory of temporaryDirectories) {
    await rm(directory, { recursive: true, force: true });
  }
});

const connection = {
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

function claim(actionType = "FLUSH_DNS_CACHE") {
  return {
    commandId: "50000000-0000-4000-8000-000000000001",
    organizationId: connection.organizationId,
    buildingId: connection.buildingId,
    deviceId: connection.deviceId,
    interfaceId: null,
    actionType,
    reason: "Kiểm tra worker",
    parameters: {},
    attemptNo: 1,
    leaseToken: "60000000-0000-4000-8000-000000000001",
    leaseExpiresAt: "2026-07-28T00:02:00.000Z",
    reconciliation: false,
    intentType: actionType,
    managedTarget: {},
    preObservation: null,
    expectedPostcondition: { kind: actionType },
    observationDeadline: "2026-07-28T00:05:00.000Z",
    transitionVersion: 3,
    fencingGeneration: 9,
  };
}

function harness(
  overrides: Partial<RouterConnector> = {},
  emergencyStop: boolean | (() => boolean) = false,
  backupStoreOverrides: Partial<BackupStore> = {},
  processorOverrides: {
    clock?: WorkerClock;
    renewLease?: () => Promise<void>;
    routerOperationSemaphore?: AsyncSemaphore;
    stage?: (input: { eventKind: string }) => Promise<void>;
    observe?: (input: Record<string, unknown>) => Promise<void>;
    portCycleEvidence?: PortCycleEvidenceStore;
  } = {},
) {
  const calls: string[] = [];
  const completions: Array<Record<string, unknown>> = [];
  const observations: Array<Record<string, unknown>> = [];
  const snapshots: Array<Record<string, unknown>> = [];
  const stages: Array<{ eventKind: string; payload: Record<string, unknown> }> = [];
  const interfaceRegistry = new InterfaceRegistry();
  let dnsAck = false;
  let dhcpRenewed = false;
  let observedDisable: { managedResourceId: string; immutableKey: string } | null = null;
  let rebooted = false;
  let renewCallback: (() => void | Promise<void>) | undefined;
  const connector: RouterConnector = {
    poll: async () => ({ observedAt: new Date().toISOString(), device: {}, interfaces: [], clients: [], aruba: [] }),
    captureBackup: async () => {
      calls.push("backup");
      return {
        artifact: {
          path: "/staging/safe.backup.part",
          sha256: "a".repeat(64),
          bytes: 3,
          dispose: async () => { calls.push("dispose-staging"); },
        },
        redactedExport: "/system identity set name=demo",
      };
    },
    healthCheck: async () => {
      calls.push("post-check");
      return { reachable: true, wanUp: true, dnsOk: true };
    },
    observeAction: async (intent) => {
      calls.push("observe-action");
      if (intent.actionType === "FLUSH_DNS_CACHE") {
        return {
          observedAt: "2026-07-28T00:00:00.000Z",
          reachable: true,
          ...(dnsAck ? { dns: { commandAck: true } } : {}),
        };
      }
      if (intent.actionType === "RENEW_DHCP_LEASE") {
        return {
          observedAt: "2026-07-28T00:00:00.000Z",
          reachable: true,
          dhcp: {
            leaseKey: "wan-dhcp",
            status: "bound",
            expiresInSeconds: dhcpRenewed ? 3_600 : 120,
          },
        };
      }
      if (intent.actionType === "CYCLE_ACCESS_PORT") {
        return {
          observedAt: "2026-07-28T00:00:00.000Z",
          reachable: true,
          accessInterface: {
            managedResourceId: "50000000-0000-4000-8000-000000000001",
            immutableKey: "ether4",
            enabled: true,
            disabledObserved: observedDisable !== null,
            enabledObserved: true,
          },
        };
      }
      if (intent.actionType === "REBOOT_ROUTER") {
        return {
          observedAt: "2026-07-28T00:00:00.000Z",
          reachable: true,
          boot: {
            bootId: rebooted ? "boot-2" : "boot-1",
            uptimeSeconds: rebooted ? 15 : 86_400,
          },
        };
      }
      return { observedAt: "2026-07-28T00:00:00.000Z", reachable: true };
    },
    flushDnsCache: async () => { calls.push("flush"); dnsAck = true; },
    renewDhcpLease: async () => { calls.push("renew-dhcp"); dhcpRenewed = true; return true; },
    // Mirrors the SSH connector: the disable is remembered from the identity the
    // router itself confirmed, and it is the only thing that can seed evidence.
    cycleAccessPort: async (target) => {
      calls.push("cycle-port");
      observedDisable = {
        managedResourceId: target.managedResourceId,
        immutableKey: target.immutableKey ?? "",
      };
    },
    observedPortDisable: () => observedDisable,
    reboot: async () => { calls.push("reboot"); rebooted = true; },
    close: async () => { calls.push("close"); },
    ...overrides,
  };
  const processor = new CommandProcessor({
    api: {
      renewLease: processorOverrides.renewLease ?? (async () => { calls.push("renew-lease"); }),
      stage: async (input: { eventKind: string; payload?: Record<string, unknown> }) => {
        calls.push(input.eventKind);
        stages.push({ eventKind: input.eventKind, payload: input.payload ?? {} });
        await processorOverrides.stage?.(input);
      },
      observe: async (input: Record<string, unknown>) => {
        calls.push(`observe-${String(input.observationKind)}`);
        observations.push(input);
        await processorOverrides.observe?.(input);
        return {
          accepted: true,
          transitionVersion: Number(input.transitionVersion) + 1,
        };
      },
      complete: async (input: Record<string, unknown>) => {
        calls.push("complete");
        completions.push(input);
      },
      snapshot: async (payload: Record<string, unknown>) => {
        calls.push("snapshot");
        snapshots.push(payload);
      },
    },
    connectorFactory: async () => connector,
    backupStore: {
      pressure: async () => ({ state: "OK", volumeBytes: 0, freeBytes: 40 * 1024 ** 3 }),
      assertReserve: async () => {
        calls.push("reserve");
        return { state: "OK", volumeBytes: 0, freeBytes: 40 * 1024 ** 3 };
      },
      rotate: async () => ({ deleted: 0, reclaimedBytes: 0, remainingBytes: 0 }),
      saveVerified: async () => ({
        path: "/backups/safe.backup",
        deviceId: connection.deviceId,
        sha256: "a".repeat(64),
        bytes: 3,
        createdAt: new Date("2026-07-28T00:00:00.000Z"),
        release: () => { calls.push("release-backup"); },
      }),
      ...backupStoreOverrides,
    },
    interfaceRegistry,
    emergencyStop: typeof emergencyStop === "function" ? emergencyStop : () => emergencyStop,
    clock: processorOverrides.clock ?? {
      now: () => new Date("2026-07-28T00:00:00.000Z"),
      setInterval: (callback) => { renewCallback = callback; return 1; },
      clearInterval: () => undefined,
      sleep: async () => undefined,
    },
    leaseSeconds: 90,
    logger: { info() {}, warn() {}, error() {} },
    ...(processorOverrides.routerOperationSemaphore
      ? { routerOperationSemaphore: processorOverrides.routerOperationSemaphore }
      : {}),
    ...(processorOverrides.portCycleEvidence
      ? { portCycleEvidence: processorOverrides.portCycleEvidence }
      : {}),
  });
  return {
    calls,
    completions,
    observations,
    snapshots,
    stages,
    interfaceRegistry,
    processor,
    triggerRenew: async () => renewCallback?.(),
  };
}

describe("command processor", () => {
  it("bounds redacted exports by UTF-8 bytes for the Edge snapshot envelope", () => {
    const sanitized = sanitizeRouterExport(`comment=${"á".repeat(600_000)}`);
    expect(Buffer.byteLength(sanitized, "utf8")).toBeLessThanOrEqual(900_000);
    expect(sanitized).not.toContain("�");
    expect(sanitized).toContain("comment=");
    expect(sanitizeRouterExport(Array.from({ length: 60_000 }, () => "x").join("\n")).split("\n"))
      .toHaveLength(20_000);
    expect(sanitizeRouterExport('/system script add source=":local password hunter2"'))
      .not.toContain("hunter2");
  });

  it("does not reload connections while the queue is empty", async () => {
    const calls: string[] = [];
    const coordinator = new CommandCoordinator({
      api: {
        claimCommands: async () => { calls.push("claim"); return []; },
        listConnections: async () => { calls.push("connections"); return []; },
        complete: async () => undefined,
      },
      processor: {} as CommandProcessor,
      leaseSeconds: 90,
      logger: { info() {}, warn() {}, error() {} },
    });
    await coordinator.runCycle();
    expect(calls).toEqual(["claim"]);
  });

  it("does not claim commands while the global emergency stop is active", async () => {
    const calls: string[] = [];
    const coordinator = new CommandCoordinator({
      api: {
        claimCommands: async () => { calls.push("claim"); return []; },
        listConnections: async () => { calls.push("connections"); return []; },
        complete: async () => undefined,
      },
      processor: {} as CommandProcessor,
      leaseSeconds: 90,
      claimLimit: 3,
      maxConcurrency: 3,
      paused: () => true,
      logger: { info() {}, warn() {}, error() {} },
    });
    await coordinator.runCycle();
    expect(calls).toEqual([]);
  });

  it("rejects an over-returned claim batch before any downstream work", async () => {
    const calls: string[] = [];
    let requestedLimit = 0;
    const claims = Array.from({ length: 4 }, (_, index) => ({
      ...claim(),
      commandId: `command-${index}`,
      deviceId: `device-${index}`,
    }));
    const coordinator = new CommandCoordinator({
      api: {
        claimCommands: async (limit) => {
          calls.push("claim");
          requestedLimit = limit ?? 0;
          return claims;
        },
        listConnections: async () => {
          calls.push("connections");
          return [];
        },
        complete: async () => {
          calls.push("complete");
        },
      },
      processor: {
        processClaim: async () => {
          calls.push("process");
        },
      },
      leaseSeconds: 90,
      claimLimit: 3,
      maxConcurrency: 2,
      paused: () => false,
      logger: { info() {}, warn() {}, error() {} },
    });
    await expect(coordinator.runCycle()).rejects.toThrow(/more claims than requested/i);
    expect(requestedLimit).toBe(3);
    expect(calls).toEqual(["claim"]);
  });

  it("settles every claimed command before reporting a completion failure", async () => {
    const first = {
      ...claim(),
      commandId: "50000000-0000-4000-8000-000000000001",
      deviceId: "40000000-0000-4000-8000-000000000099",
    };
    const second = {
      ...claim(),
      commandId: "50000000-0000-4000-8000-000000000002",
      leaseToken: "60000000-0000-4000-8000-000000000002",
      deviceId: connection.deviceId,
    };
    const processed: string[] = [];
    const logged: unknown[] = [];
    const coordinator = new CommandCoordinator({
      api: {
        claimCommands: async () => [first, second],
        listConnections: async () => [connection],
        complete: async () => {
          throw new Error("completion transport failed with secret material");
        },
      },
      processor: {
        processClaim: async (item) => {
          processed.push(item.commandId);
        },
      },
      leaseSeconds: 90,
      claimLimit: 3,
      maxConcurrency: 1,
      logger: {
        info() {},
        warn() {},
        error(_message, context) {
          logged.push(context);
        },
      },
    });

    await expect(coordinator.runCycle()).rejects.toThrow(/claimed command task failed/i);

    expect(processed).toEqual([second.commandId]);
    expect(logged).toEqual([
      expect.objectContaining({
        commandId: first.commandId,
        error: "Error",
      }),
    ]);
    expect(JSON.stringify(logged)).not.toContain("secret material");
  });

  it("renews the lease, backs up, executes an allowlisted action, and post-checks", async () => {
    const test = harness();
    const processing = test.processor.processClaim(claim(), connection);
    await Promise.resolve();
    await test.triggerRenew();
    await processing;

    expect(test.calls).toEqual(expect.arrayContaining([
      "VALIDATED",
      "reserve",
      "BACKUP_STARTED",
      "backup",
      "snapshot",
      "BACKUP_COMPLETED",
      "EXECUTION_STARTED",
      "flush",
      "EXECUTION_COMPLETED",
      "POST_CHECK_STARTED",
      "observe-action",
      "POST_CHECK_COMPLETED",
      "close",
      "renew-lease",
      "release-backup",
    ]));
    expect(test.completions).toHaveLength(1);
    expect(test.completions[0]).toMatchObject({
      outcome: "EVALUATE_POSTCONDITION",
      transitionVersion: 5,
      fencingGeneration: 9,
      result: { actionType: "FLUSH_DNS_CACHE" },
    });
    expect(JSON.stringify(test.completions[0])).not.toContain("reconciliationDecision");
    expect(test.calls.indexOf("observe-PRE_ACTION"))
      .toBeLessThan(test.calls.indexOf("EXECUTION_STARTED"));
    expect(test.calls.indexOf("observe-PRE_ACTION"))
      .toBeLessThan(test.calls.indexOf("flush"));
    expect(test.calls.indexOf("observe-POST_ACTION"))
      .toBeLessThan(test.calls.indexOf("complete"));
  });

  it("passes an enrolled immutable target to access-port execution", async () => {
    let receivedTarget: unknown;
    const test = harness({
      cycleAccessPort: async (target) => {
        receivedTarget = target;
      },
    });
    test.interfaceRegistry.update(connection.deviceId, [{
      managedResourceId: "50000000-0000-4000-8000-000000000001",
      id: "70000000-0000-4000-8000-000000000001",
      interfaceKey: "ether4",
      currentName: "room-401",
      immutableKey: "ether4",
      enrolledRole: "ACCESS",
      protected: false,
      enrollmentState: "ENROLLED",
    }]);

    await test.processor.processClaim({
      ...claim("CYCLE_ACCESS_PORT"),
      interfaceId: "70000000-0000-4000-8000-000000000001",
      parameters: { durationSeconds: 5 },
    }, connection);

    expect(receivedTarget).toMatchObject({
      managedResourceId: "50000000-0000-4000-8000-000000000001",
      currentName: "room-401",
      immutableKey: "ether4",
      enrolledRole: "ACCESS",
      protected: false,
      enrollmentState: "ENROLLED",
    });
  });

  it("cancels before connecting when a global or building kill switch is active", async () => {
    const stopped = harness({}, true);
    await stopped.processor.processClaim(claim(), connection);
    expect(stopped.calls).not.toContain("backup");
    expect(stopped.completions[0]).toMatchObject({ outcome: "CANCELLED_BY_KILL_SWITCH" });

    const paused = harness();
    await paused.processor.processClaim(claim(), { ...connection, changesPaused: true });
    expect(paused.calls).not.toContain("backup");
    expect(paused.completions[0]).toMatchObject({ outcome: "CANCELLED_BY_KILL_SWITCH" });
  });

  it("rechecks the emergency stop after backup and before execution", async () => {
    let stopped = false;
    const test = harness({
      captureBackup: async () => {
        stopped = true;
        return {
          artifact: {
            path: "/staging/emergency.backup.part",
            sha256: "a".repeat(64),
            bytes: 1,
            dispose: async () => undefined,
          },
          redactedExport: "/system identity print",
        };
      },
    }, () => stopped);

    await test.processor.processClaim(claim(), connection);
    expect(test.calls).not.toContain("flush");
    expect(test.completions[0]).toMatchObject({ outcome: "CANCELLED_BY_KILL_SWITCH" });
  });

  it("fails before router backup or mutation when disk reserve is unavailable", async () => {
    const test = harness({}, false, {
      assertReserve: async () => {
        throw new RouterOperationError("BACKUP_RESERVE_UNAVAILABLE", {
          retryable: true,
          mayHaveExecuted: false,
        });
      },
    });

    await test.processor.processClaim(claim("REBOOT_ROUTER"), connection);

    expect(test.calls).not.toContain("backup");
    expect(test.calls).not.toContain("reboot");
    expect(test.completions[0]).toMatchObject({
      outcome: "RETRYABLE_FAILURE",
      result: { code: "BACKUP_RESERVE_UNAVAILABLE" },
    });
  });

  it("does not replay actions during reconciliation", async () => {
    const test = harness({
      observeAction: async () => ({
        observedAt: "2026-07-28T00:00:15.000Z",
        reachable: true,
        boot: { bootId: "boot-2", uptimeSeconds: 15 },
      }),
    });
    await test.processor.processClaim({
      ...claim("REBOOT_ROUTER"),
      reconciliation: true,
      preObservation: {
        observedAt: "2026-07-28T00:00:00.000Z",
        reachable: true,
        boot: { bootId: "boot-1", uptimeSeconds: 86_400 },
      },
    }, connection);
    expect(test.calls).not.toContain("backup");
    expect(test.calls).not.toContain("reboot");
    expect(test.calls).toEqual(expect.arrayContaining([
      "RECONCILIATION_STARTED",
      "RECONCILIATION_COMPLETED",
    ]));
    expect(test.completions[0]).toMatchObject({
      outcome: "EVALUATE_POSTCONDITION",
      transitionVersion: 4,
    });
    expect(test.observations[0]).toMatchObject({
      observationKind: "RECONCILIATION",
      fencingGeneration: 9,
      transitionVersion: 3,
    });
    expect(JSON.stringify(test.completions[0])).not.toContain("reconciliationDecision");
  });

  it("allows read-only reconciliation when backup storage is under pressure", async () => {
    const test = harness({
      observeAction: async () => ({
        observedAt: "2026-07-28T00:00:15.000Z",
        reachable: true,
        boot: { bootId: "boot-2", uptimeSeconds: 15 },
      }),
    }, false, {
      assertReserve: async () => {
        throw new RouterOperationError("BACKUP_RESERVE_UNAVAILABLE", {
          retryable: true,
          mayHaveExecuted: false,
        });
      },
    });

    await test.processor.processClaim({
      ...claim("REBOOT_ROUTER"),
      reconciliation: true,
      preObservation: {
        observedAt: "2026-07-28T00:00:00.000Z",
        reachable: true,
        boot: { bootId: "boot-1", uptimeSeconds: 86_400 },
      },
    }, connection);

    expect(test.calls).toContain("RECONCILIATION_COMPLETED");
    expect(test.calls).not.toContain("backup");
    expect(test.completions[0]).toMatchObject({
      outcome: "EVALUATE_POSTCONDITION",
      transitionVersion: 4,
    });
  });

  it("reports UNCERTAIN when a disruptive action may have executed", async () => {
    const test = harness({
      reboot: async () => {
        throw new RouterOperationError("connection_lost", { retryable: true, mayHaveExecuted: true });
      },
    });
    await test.processor.processClaim(claim("REBOOT_ROUTER"), connection);
    expect(test.completions[0]).toMatchObject({ outcome: "UNCERTAIN" });
  });

  it("retries a command when the control plane fails before the router action", async () => {
    const test = harness({}, false, {}, {
      stage: async (input) => {
        if (input.eventKind === "BACKUP_STARTED") {
          throw new ApiClientError({ code: "HTTP_503", retryable: true, status: 503 });
        }
      },
    });

    await test.processor.processClaim(claim(), connection);

    expect(test.calls).not.toContain("flush");
    expect(test.completions[0]).toMatchObject({
      outcome: "RETRYABLE_FAILURE",
      result: { code: "HTTP_503" },
    });
  });

  it("keeps a disruptive command uncertain when the control plane fails after execution", async () => {
    const test = harness({}, false, {}, {
      stage: async (input) => {
        if (input.eventKind === "EXECUTION_COMPLETED") {
          throw new ApiClientError({ code: "NETWORK_ERROR", retryable: true });
        }
      },
    });

    await test.processor.processClaim(claim("REBOOT_ROUTER"), connection);

    expect(test.calls).toContain("reboot");
    expect(test.completions[0]).toMatchObject({
      outcome: "UNCERTAIN",
      result: { code: "NETWORK_ERROR" },
    });
  });

  it("abandons a command whose observation deadline has already passed", async () => {
    const test = harness();

    await test.processor.processClaim({
      ...claim(),
      observationDeadline: "2026-07-27T23:59:00.000Z",
    }, connection);

    expect(test.calls).not.toContain("backup");
    expect(test.calls).not.toContain("flush");
    expect(test.completions[0]).toMatchObject({
      outcome: "FAILED",
      result: { code: "OBSERVATION_DEADLINE_EXCEEDED" },
    });
  });

  it("refuses a port cycle it could never observe before the deadline", async () => {
    const test = harness();
    test.interfaceRegistry.update(connection.deviceId, [{
      managedResourceId: "50000000-0000-4000-8000-000000000001",
      id: "70000000-0000-4000-8000-000000000001",
      interfaceKey: "ether4",
      currentName: "room-401",
      immutableKey: "ether4",
      enrolledRole: "ACCESS",
      protected: false,
      enrollmentState: "ENROLLED",
    }]);

    await test.processor.processClaim({
      ...claim("CYCLE_ACCESS_PORT"),
      interfaceId: "70000000-0000-4000-8000-000000000001",
      parameters: { durationSeconds: 30 },
      observationDeadline: "2026-07-28T00:00:20.000Z",
    }, connection);

    // Doomed on arrival, so it must be refused before the router backup, the SFTP
    // staging and the snapshot upload — minutes of work whose only product would be
    // a backup for a command that can never be recorded.
    expect(test.calls).not.toContain("backup");
    expect(test.calls).not.toContain("reserve");
    expect(test.calls).not.toContain("snapshot");
    expect(test.calls).not.toContain("cycle-port");
    expect(test.completions[0]).toMatchObject({
      outcome: "FAILED",
      result: { code: "OBSERVATION_DEADLINE_UNREACHABLE" },
    });
  });

  it("counts the reports it still owes between the deadline gate and the observation", async () => {
    const test = harness();
    test.interfaceRegistry.update(connection.deviceId, [{
      managedResourceId: "50000000-0000-4000-8000-000000000001",
      id: "70000000-0000-4000-8000-000000000001",
      interfaceKey: "ether4",
      currentName: "room-401",
      immutableKey: "ether4",
      enrolledRole: "ACCESS",
      protected: false,
      enrollmentState: "ENROLLED",
    }]);

    await test.processor.processClaim({
      ...claim("CYCLE_ACCESS_PORT"),
      interfaceId: "70000000-0000-4000-8000-000000000001",
      parameters: { durationSeconds: 5 },
      // Room for the cycle itself plus the router read, and one second more. The
      // worker still owes the control plane EXECUTION_STARTED, EXECUTION_COMPLETED
      // and POST_CHECK_STARTED before `observedAt` is stamped, so a budget of just
      // "action + read" lets a command execute that can never be recorded.
      observationDeadline: new Date(
        Date.parse("2026-07-28T00:00:00.000Z") + 5_000 + OBSERVATION_READ_HEADROOM_MS + 1_000,
      ).toISOString(),
    }, connection);

    expect(test.calls).not.toContain("cycle-port");
    expect(test.completions[0]).toMatchObject({
      outcome: "FAILED",
      result: { code: "OBSERVATION_DEADLINE_UNREACHABLE" },
    });
  });

  it("abandons a reconciliation that can no longer be observed in time", async () => {
    const test = harness({
      observeAction: async () => ({
        observedAt: "2026-07-28T00:00:15.000Z",
        reachable: true,
        boot: { bootId: "boot-2", uptimeSeconds: 15 },
      }),
    });

    await test.processor.processClaim({
      ...claim("REBOOT_ROUTER"),
      reconciliation: true,
      preObservation: {
        observedAt: "2026-07-27T23:58:00.000Z",
        reachable: true,
        boot: { bootId: "boot-1", uptimeSeconds: 86_400 },
      },
      observationDeadline: "2026-07-27T23:59:00.000Z",
    }, connection);

    expect(test.calls).not.toContain("observe-action");
    expect(test.observations).toHaveLength(0);
    expect(test.completions[0]).toMatchObject({
      outcome: "FAILED",
      result: { code: "OBSERVATION_DEADLINE_EXCEEDED" },
    });
  });

  it("reconciles a port cycle from evidence a previous connector left behind", async () => {
    const directory = await evidenceDirectory();
    const managedTarget = {
      managedResourceId: "50000000-0000-4000-8000-000000000001",
      immutableKey: "ether4",
    };
    const cycleClaim = {
      ...claim("CYCLE_ACCESS_PORT"),
      interfaceId: "70000000-0000-4000-8000-000000000001",
      parameters: { durationSeconds: 5 },
      managedTarget,
    };
    const mapping = [{
      managedResourceId: "50000000-0000-4000-8000-000000000001",
      id: "70000000-0000-4000-8000-000000000001",
      interfaceKey: "ether4",
      currentName: "room-401",
      immutableKey: "ether4",
      enrolledRole: "ACCESS" as const,
      protected: false,
      enrollmentState: "ENROLLED" as const,
    }];

    const first = harness({}, false, {}, {
      portCycleEvidence: new FilePortCycleEvidenceStore(directory, {
        now: () => new Date("2026-07-28T00:00:00.000Z"),
      }),
    });
    first.interfaceRegistry.update(connection.deviceId, mapping);
    await first.processor.processClaim(cycleClaim, connection);
    expect(first.calls).toContain("cycle-port");

    const second = harness({}, false, {}, {
      portCycleEvidence: new FilePortCycleEvidenceStore(directory, {
        now: () => new Date("2026-07-28T00:00:00.000Z"),
      }),
    });
    second.interfaceRegistry.update(connection.deviceId, mapping);
    await second.processor.processClaim({
      ...cycleClaim,
      reconciliation: true,
      leaseToken: "60000000-0000-4000-8000-000000000002",
      fencingGeneration: cycleClaim.fencingGeneration + 1,
      transitionVersion: cycleClaim.transitionVersion + 2,
      preObservation: {
        observedAt: "2026-07-27T23:59:50.000Z",
        reachable: true,
        accessInterface: { ...managedTarget, enabled: true },
      },
    }, connection);

    expect(second.calls).not.toContain("cycle-port");
    expect(second.observations[0]).toMatchObject({
      observationKind: "RECONCILIATION",
      evidence: {
        accessInterface: {
          managedResourceId: "50000000-0000-4000-8000-000000000001",
          immutableKey: "ether4",
          enabled: true,
          disabledObserved: true,
          enabledObserved: true,
        },
      },
    });
  });

  it("records durable cycle evidence when the session dies after the router disabled the port", async () => {
    // The scenario the evidence store exists for. A cycle whose SSH session dies
    // inside the router-side `:delay` REJECTS, so evidence written only on the
    // success path is never written at all — and the command that most needs to be
    // reconcilable is the one left with nothing to reconcile from.
    const directory = await evidenceDirectory();
    const managedTarget = {
      managedResourceId: "50000000-0000-4000-8000-000000000001",
      immutableKey: "ether4",
    };
    const cycleClaim = {
      ...claim("CYCLE_ACCESS_PORT"),
      interfaceId: "70000000-0000-4000-8000-000000000001",
      parameters: { durationSeconds: 5 },
      managedTarget,
    };
    const mapping = [{
      managedResourceId: "50000000-0000-4000-8000-000000000001",
      id: "70000000-0000-4000-8000-000000000001",
      interfaceKey: "ether4",
      currentName: "room-401",
      immutableKey: "ether4",
      enrolledRole: "ACCESS" as const,
      protected: false,
      enrollmentState: "ENROLLED" as const,
    }];

    const interrupted = harness({
      // The router printed NC_CYCLE_DISABLED and then the channel died in the delay.
      observedPortDisable: () => managedTarget,
      cycleAccessPort: async () => {
        throw new RouterOperationError("SSH_COMMAND_TIMEOUT", {
          retryable: true,
          mayHaveExecuted: true,
        });
      },
    }, false, {}, {
      portCycleEvidence: new FilePortCycleEvidenceStore(directory, {
        now: () => new Date("2026-07-28T00:00:00.000Z"),
      }),
    });
    interrupted.interfaceRegistry.update(connection.deviceId, mapping);
    await interrupted.processor.processClaim(cycleClaim, connection);

    expect(interrupted.completions[0]).toMatchObject({
      outcome: "UNCERTAIN",
      result: { code: "SSH_COMMAND_TIMEOUT" },
    });
    expect(await new FilePortCycleEvidenceStore(directory, {
      now: () => new Date("2026-07-28T00:00:00.000Z"),
    }).read(cycleClaim.commandId)).toMatchObject(managedTarget);

    // And the reconciliation that follows can now prove the transition happened.
    const reconciling = harness({}, false, {}, {
      portCycleEvidence: new FilePortCycleEvidenceStore(directory, {
        now: () => new Date("2026-07-28T00:00:00.000Z"),
      }),
    });
    reconciling.interfaceRegistry.update(connection.deviceId, mapping);
    await reconciling.processor.processClaim({
      ...cycleClaim,
      reconciliation: true,
      leaseToken: "60000000-0000-4000-8000-000000000002",
      fencingGeneration: cycleClaim.fencingGeneration + 1,
      transitionVersion: cycleClaim.transitionVersion + 2,
      preObservation: {
        observedAt: "2026-07-27T23:59:50.000Z",
        reachable: true,
        accessInterface: { ...managedTarget, enabled: true },
      },
    }, connection);

    expect(reconciling.observations[0]).toMatchObject({
      observationKind: "RECONCILIATION",
      evidence: { accessInterface: { disabledObserved: true, enabled: true } },
    });
    expect(reconciling.stages.find((entry) => entry.eventKind === "RECONCILIATION_COMPLETED")
      ?.payload.decision).toMatchObject({ outcome: "SUCCEEDED" });
  });

  it("records no evidence for a port the router never reported disabled", async () => {
    const directory = await evidenceDirectory();
    const managedTarget = {
      managedResourceId: "50000000-0000-4000-8000-000000000001",
      immutableKey: "ether4",
    };
    const test = harness({
      // A disable really happened, but on a different managed port than this command
      // owns. Evidence stays bound to the command's own target or is not written.
      observedPortDisable: () => ({
        managedResourceId: "50000000-0000-4000-8000-0000000000cc",
        immutableKey: "ether9",
      }),
      cycleAccessPort: async () => {
        throw new RouterOperationError("SSH_COMMAND_TIMEOUT", {
          retryable: true,
          mayHaveExecuted: true,
        });
      },
    }, false, {}, {
      portCycleEvidence: new FilePortCycleEvidenceStore(directory, {
        now: () => new Date("2026-07-28T00:00:00.000Z"),
      }),
    });
    test.interfaceRegistry.update(connection.deviceId, [{
      managedResourceId: "50000000-0000-4000-8000-000000000001",
      id: "70000000-0000-4000-8000-000000000001",
      interfaceKey: "ether4",
      currentName: "room-401",
      immutableKey: "ether4",
      enrolledRole: "ACCESS",
      protected: false,
      enrollmentState: "ENROLLED",
    }]);

    const cycleClaim = {
      ...claim("CYCLE_ACCESS_PORT"),
      interfaceId: "70000000-0000-4000-8000-000000000001",
      parameters: { durationSeconds: 5 },
      managedTarget,
    };
    await test.processor.processClaim(cycleClaim, connection);

    expect(await new FilePortCycleEvidenceStore(directory, {
      now: () => new Date("2026-07-28T00:00:00.000Z"),
    }).read(cycleClaim.commandId)).toBeNull();
  });

  it("never lets stored evidence outvote a live read of the port", async () => {
    // A stored disable may only ever restore the *transition*. Whether the port is up
    // again is read off the router every time, so a cycle that left the port down can
    // never be turned into a SUCCEEDED verdict by anything on disk.
    const directory = await evidenceDirectory();
    const managedTarget = {
      managedResourceId: "50000000-0000-4000-8000-000000000001",
      immutableKey: "ether4",
    };
    const cycleClaim = {
      ...claim("CYCLE_ACCESS_PORT"),
      interfaceId: "70000000-0000-4000-8000-000000000001",
      parameters: { durationSeconds: 5 },
      managedTarget,
    };
    await new FilePortCycleEvidenceStore(directory, {
      now: () => new Date("2026-07-28T00:00:00.000Z"),
    }).record({
      commandId: cycleClaim.commandId,
      ...managedTarget,
      observedAt: "2026-07-28T00:00:00.000Z",
    });

    const test = harness({
      observeAction: async () => ({
        observedAt: "2026-07-28T00:00:00.000Z",
        reachable: true,
        // The guard has not fired yet: the tenant's port is still down.
        accessInterface: {
          ...managedTarget,
          enabled: false,
          disabledObserved: false,
          enabledObserved: false,
        },
      }),
    }, false, {}, {
      portCycleEvidence: new FilePortCycleEvidenceStore(directory, {
        now: () => new Date("2026-07-28T00:00:00.000Z"),
      }),
    });

    await test.processor.processClaim({
      ...cycleClaim,
      reconciliation: true,
      preObservation: {
        observedAt: "2026-07-27T23:59:50.000Z",
        reachable: true,
        accessInterface: { ...managedTarget, enabled: true },
      },
    }, connection);

    expect(test.observations[0]).toMatchObject({
      evidence: {
        accessInterface: { disabledObserved: true, enabled: false, enabledObserved: false },
      },
    });
    expect(test.stages.find((entry) => entry.eventKind === "RECONCILIATION_COMPLETED")
      ?.payload.decision).toMatchObject({ outcome: "UNCERTAIN" });
  });

  it("never invents port-cycle evidence for another command", async () => {
    const directory = await evidenceDirectory();
    const managedTarget = {
      managedResourceId: "50000000-0000-4000-8000-000000000001",
      immutableKey: "ether4",
    };
    const test = harness({}, false, {}, {
      portCycleEvidence: new FilePortCycleEvidenceStore(directory, {
        now: () => new Date("2026-07-28T00:00:00.000Z"),
      }),
    });
    test.interfaceRegistry.update(connection.deviceId, [{
      managedResourceId: "50000000-0000-4000-8000-000000000001",
      id: "70000000-0000-4000-8000-000000000001",
      interfaceKey: "ether4",
      currentName: "room-401",
      immutableKey: "ether4",
      enrolledRole: "ACCESS",
      protected: false,
      enrollmentState: "ENROLLED",
    }]);

    await test.processor.processClaim({
      ...claim("CYCLE_ACCESS_PORT"),
      commandId: "50000000-0000-4000-8000-0000000000ff",
      interfaceId: "70000000-0000-4000-8000-000000000001",
      parameters: { durationSeconds: 5 },
      managedTarget,
      reconciliation: true,
      preObservation: {
        observedAt: "2026-07-27T23:59:50.000Z",
        reachable: true,
        accessInterface: { ...managedTarget, enabled: true },
      },
    }, connection);

    expect(test.observations[0]).toMatchObject({
      observationKind: "RECONCILIATION",
      evidence: { accessInterface: { disabledObserved: false } },
    });
  });

  it("ignores stored evidence that names a different managed port", async () => {
    // The store returns the managed identity exactly as it found it on disk; the
    // binding that makes it trustworthy is here, against the port the live read
    // actually observed. Anything that reaches the file is therefore still unable to
    // put a disable on a port this command does not own.
    const directory = await evidenceDirectory();
    const managedTarget = {
      managedResourceId: "50000000-0000-4000-8000-000000000001",
      immutableKey: "ether4",
    };
    const cycleClaim = {
      ...claim("CYCLE_ACCESS_PORT"),
      interfaceId: "70000000-0000-4000-8000-000000000001",
      parameters: { durationSeconds: 5 },
      managedTarget,
    };
    await new FilePortCycleEvidenceStore(directory, {
      now: () => new Date("2026-07-28T00:00:00.000Z"),
    }).record({
      commandId: cycleClaim.commandId,
      managedResourceId: "50000000-0000-4000-8000-0000000000cc",
      immutableKey: "ether9",
      observedAt: "2026-07-28T00:00:00.000Z",
    });

    const test = harness({}, false, {}, {
      portCycleEvidence: new FilePortCycleEvidenceStore(directory, {
        now: () => new Date("2026-07-28T00:00:00.000Z"),
      }),
    });
    await test.processor.processClaim({
      ...cycleClaim,
      reconciliation: true,
      preObservation: {
        observedAt: "2026-07-27T23:59:50.000Z",
        reachable: true,
        accessInterface: { ...managedTarget, enabled: true },
      },
    }, connection);

    expect(test.observations[0]).toMatchObject({
      evidence: { accessInterface: { disabledObserved: false } },
    });
  });

  it("reports DHCP renew as not applicable without failing PPPoE sites", async () => {
    const test = harness({
      observeAction: async () => ({
        observedAt: "2026-07-28T00:00:00.000Z",
        reachable: true,
        dhcp: { notApplicable: true },
      }),
      renewDhcpLease: async () => false,
    });
    await test.processor.processClaim(claim("RENEW_DHCP_LEASE"), connection);
    expect(test.completions[0]).toMatchObject({
      outcome: "EVALUATE_POSTCONDITION",
      result: {
        actionResult: { applied: false, reason: "DHCP_RENEW_NOT_APPLICABLE" },
      },
    });
  });

  it("never promotes generic reachable health to worker-authored success", async () => {
    const test = harness({
      observeAction: async () => ({
        observedAt: "2026-07-28T00:00:00.000Z",
        reachable: true,
      }),
    });

    await test.processor.processClaim(claim("FLUSH_DNS_CACHE"), connection);

    expect(test.completions[0]).toMatchObject({
      outcome: "EVALUATE_POSTCONDITION",
      result: { actionType: "FLUSH_DNS_CACHE" },
    });
    expect(JSON.stringify(test.completions[0])).not.toContain("reconciliationDecision");
    expect(test.completions[0]).not.toMatchObject({ outcome: "SUCCEEDED" });
  });

  it("persists redacted and encrypted hashes as snapshot postcondition evidence", async () => {
    const test = harness();
    await test.processor.processClaim(claim("CAPTURE_SNAPSHOT"), connection);

    expect(test.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        observationKind: "POST_ACTION",
        evidence: expect.objectContaining({
          snapshot: expect.objectContaining({
            redactedContentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
            encryptedArtifactHash: "a".repeat(64),
          }),
        }),
      }),
    ]));
    expect(test.snapshots[0]).toMatchObject({
      encryptedArtifactHash: "a".repeat(64),
    });
  });

  it("deduplicates the same command attempt in one worker process", async () => {
    const test = harness();
    await test.processor.processClaim(claim(), connection);
    await test.processor.processClaim(claim(), connection);
    expect(test.calls.filter((value) => value === "flush")).toHaveLength(1);
    expect(test.completions).toHaveLength(1);
  });

  it("processes a later reconciliation lease even when the attempt number is unchanged", async () => {
    const test = harness({
      observeAction: async () => ({
        observedAt: "2026-07-28T00:00:15.000Z",
        reachable: true,
        boot: { bootId: "boot-2", uptimeSeconds: 15 },
      }),
    });
    const first = {
      ...claim("REBOOT_ROUTER"),
      reconciliation: true,
      preObservation: {
        observedAt: "2026-07-28T00:00:00.000Z",
        reachable: true,
        boot: { bootId: "boot-1", uptimeSeconds: 86_400 },
      },
    };
    await test.processor.processClaim(first, connection);
    await test.processor.processClaim({
      ...first,
      leaseToken: "60000000-0000-4000-8000-000000000002",
      fencingGeneration: first.fencingGeneration + 1,
      transitionVersion: first.transitionVersion + 2,
    }, connection);

    expect(test.observations).toHaveLength(2);
    expect(test.observations[0]?.observationId)
      .not.toBe(test.observations[1]?.observationId);
    expect(test.completions).toHaveLength(2);
  });

  it("serializes concurrent commands for the same MikroTik", async () => {
    let active = 0;
    let maximumActive = 0;
    const releases: Array<() => void> = [];
    const test = harness({
      flushDnsCache: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
      },
    });
    const first = test.processor.processClaim(claim(), connection);
    const second = test.processor.processClaim({
      ...claim(),
      commandId: "50000000-0000-4000-8000-000000000002",
      leaseToken: "60000000-0000-4000-8000-000000000002",
    }, connection);
    while (releases.length < 1) await Promise.resolve();
    expect(releases).toHaveLength(1);
    releases.shift()?.();
    while (releases.length < 1) await Promise.resolve();
    releases.shift()?.();
    await Promise.all([first, second]);

    expect(maximumActive).toBe(1);
  });

  it("renews a claimed command while it waits beyond the renewal threshold for the RouterOS gate", async () => {
    const routerOperationSemaphore = new AsyncSemaphore(1);
    let releaseGate!: () => void;
    const gateBlock = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const gateHolder = routerOperationSemaphore.use(() => gateBlock);
    await Promise.resolve();

    let renewalCallback: (() => void | Promise<void>) | undefined;
    let renewalDelayMs = 0;
    let renewals = 0;
    const test = harness({}, false, {}, {
      routerOperationSemaphore,
      renewLease: async () => {
        renewals += 1;
      },
      clock: {
        now: () => new Date("2026-07-28T00:00:00.000Z"),
        setInterval: (callback, milliseconds) => {
          renewalCallback = callback;
          renewalDelayMs = milliseconds;
          return 1;
        },
        clearInterval: () => undefined,
        sleep: async () => undefined,
      },
    });

    const processing = test.processor.processClaim(claim(), connection);
    await Promise.resolve();
    expect(renewalDelayMs).toBe(30_000);
    expect(test.calls).not.toContain("backup");

    await renewalCallback?.();
    expect(renewals).toBe(1);
    expect(test.calls).not.toContain("backup");

    releaseGate();
    await Promise.all([gateHolder, processing]);
  });

  it("serializes a queued renewal with the execution-entry renewal", async () => {
    const routerOperationSemaphore = new AsyncSemaphore(1);
    let releaseGate!: () => void;
    const gateBlock = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const gateHolder = routerOperationSemaphore.use(() => gateBlock);
    await Promise.resolve();

    let renewalCallback: (() => void | Promise<void>) | undefined;
    const renewalReleases: Array<() => void> = [];
    let releaseFutureRenewals = false;
    let activeRenewals = 0;
    let maximumActiveRenewals = 0;
    const test = harness({}, false, {}, {
      routerOperationSemaphore,
      renewLease: async () => {
        activeRenewals += 1;
        maximumActiveRenewals = Math.max(maximumActiveRenewals, activeRenewals);
        if (!releaseFutureRenewals) {
          await new Promise<void>((resolve) => renewalReleases.push(resolve));
        }
        activeRenewals -= 1;
      },
      clock: {
        now: () => new Date("2026-07-28T00:00:00.000Z"),
        setInterval: (callback) => {
          renewalCallback = callback;
          return 1;
        },
        clearInterval: () => undefined,
        sleep: async () => undefined,
      },
    });

    const processing = test.processor.processClaim(claim(), connection);
    const queuedRenewal = renewalCallback?.();
    await Promise.resolve();
    expect(activeRenewals).toBe(1);

    releaseGate();
    try {
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
      expect(maximumActiveRenewals).toBe(1);
    } finally {
      releaseFutureRenewals = true;
      for (const release of renewalReleases) release();
      await Promise.all([gateHolder, queuedRenewal, processing]);
    }
  });

  it("waits for a slow queued renewal before settling a paused claim", async () => {
    let renewalCallback: (() => void | Promise<void>) | undefined;
    let releaseRenewal!: () => void;
    const renewalBlock = new Promise<void>((resolve) => {
      releaseRenewal = resolve;
    });
    let renewalStarted = false;
    const test = harness({}, false, {}, {
      renewLease: async () => {
        renewalStarted = true;
        await renewalBlock;
      },
      clock: {
        now: () => new Date("2026-07-28T00:00:00.000Z"),
        setInterval: (callback) => {
          renewalCallback = callback;
          return 1;
        },
        clearInterval: () => undefined,
        sleep: async () => undefined,
      },
    });

    const processing = test.processor.processClaim(claim(), {
      ...connection,
      changesPaused: true,
    });
    const queuedRenewal = renewalCallback?.();
    await Promise.resolve();
    expect(renewalStarted).toBe(true);

    try {
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
      expect(test.completions).toHaveLength(0);
    } finally {
      releaseRenewal();
      await Promise.all([queuedRenewal, processing]);
    }
    expect(test.completions).toHaveLength(1);
  });

  it("waits for a rebooting router to answer instead of post-checking a dead one", async () => {
    // Measured on the reference hEX 7.20.8: SSH answers again 54-70 s after
    // /system/reboot. The first probes therefore hit a router that is still down,
    // exactly as they did in production.
    let observeCalls = 0;
    let current = Date.parse("2026-07-28T00:00:00.000Z");
    const slept: number[] = [];
    const test = harness({
      observeAction: async () => {
        observeCalls += 1;
        if (observeCalls === 1) {
          return {
            observedAt: new Date(current).toISOString(),
            reachable: true,
            boot: { bootId: "routeros-boot:1784815213", uptimeSeconds: 936_727 },
          };
        }
        if (observeCalls <= 3) {
          throw new RouterOperationError("SSH_CONNECT_TIMEOUT", {
            retryable: true,
            mayHaveExecuted: false,
          });
        }
        return {
          observedAt: new Date(current).toISOString(),
          reachable: true,
          boot: { bootId: "routeros-boot:1784901600", uptimeSeconds: 60 },
        };
      },
    }, false, {}, {
      clock: {
        now: () => new Date(current),
        setInterval: () => 1,
        clearInterval: () => undefined,
        sleep: async (milliseconds: number) => {
          slept.push(milliseconds);
          current += milliseconds;
        },
      },
    });

    await test.processor.processClaim(claim("REBOOT_ROUTER"), connection);

    // ONE reboot, and the post-check waited for the router rather than failing it.
    expect(test.calls.filter((value) => value === "reboot")).toHaveLength(1);
    expect(slept).toEqual([connection.connectTimeoutMs, connection.connectTimeoutMs]);
    expect(test.completions).toHaveLength(1);
    expect(test.completions[0]).toMatchObject({
      outcome: "EVALUATE_POSTCONDITION",
      result: { actionType: "REBOOT_ROUTER" },
    });
    expect(test.observations.map((entry) => entry.observationKind))
      .toEqual(["PRE_ACTION", "POST_ACTION"]);
    expect(test.observations[1]).toMatchObject({
      evidence: { boot: { bootId: "routeros-boot:1784901600", uptimeSeconds: 60 } },
    });
    expect(test.stages.find((entry) => entry.eventKind === "POST_CHECK_COMPLETED")?.payload)
      .toMatchObject({ decision: { outcome: "SUCCEEDED" } });
  });

  it("reports a reboot whose router never answers as UNCERTAIN, never retryable", async () => {
    let observeCalls = 0;
    let current = Date.parse("2026-07-28T00:00:00.000Z");
    const slept: number[] = [];
    const test = harness({
      observeAction: async () => {
        observeCalls += 1;
        if (observeCalls === 1) {
          return {
            observedAt: new Date(current).toISOString(),
            reachable: true,
            boot: { bootId: "routeros-boot:1784815213", uptimeSeconds: 936_727 },
          };
        }
        throw new RouterOperationError("SSH_CONNECT_TIMEOUT", {
          retryable: true,
          mayHaveExecuted: false,
        });
      },
    }, false, {}, {
      clock: {
        now: () => new Date(current),
        setInterval: () => 1,
        clearInterval: () => undefined,
        sleep: async (milliseconds: number) => {
          slept.push(milliseconds);
          current += milliseconds;
        },
      },
    });

    await test.processor.processClaim(claim("REBOOT_ROUTER"), connection);

    // RETRYABLE_FAILURE is what re-queued the command in production, and because
    // pre_observation is frozen the retry went straight back to connector.reboot().
    expect(test.completions[0]).not.toMatchObject({ outcome: "RETRYABLE_FAILURE" });
    expect(test.completions[0]).toMatchObject({
      outcome: "UNCERTAIN",
      result: { code: "SSH_CONNECT_TIMEOUT" },
    });
    expect(test.calls.filter((value) => value === "reboot")).toHaveLength(1);
    expect(slept.length).toBeGreaterThan(1);
  });

  it("sizes the reboot settle window from the command's own deadline", async () => {
    const windowFor = async (observationDeadline: string) => {
      let observeCalls = 0;
      let current = Date.parse("2026-07-28T00:00:00.000Z");
      const slept: number[] = [];
      const test = harness({
        observeAction: async () => {
          observeCalls += 1;
          if (observeCalls === 1) {
            return {
              observedAt: new Date(current).toISOString(),
              reachable: true,
              boot: { bootId: "boot-1", uptimeSeconds: 936_727 },
            };
          }
          throw new RouterOperationError("SSH_CONNECT_TIMEOUT", {
            retryable: true,
            mayHaveExecuted: false,
          });
        },
      }, false, {}, {
        clock: {
          now: () => new Date(current),
          setInterval: () => 1,
          clearInterval: () => undefined,
          sleep: async (milliseconds: number) => {
            slept.push(milliseconds);
            current += milliseconds;
          },
        },
      });
      await test.processor.processClaim(
        { ...claim("REBOOT_ROUTER"), observationDeadline },
        connection,
      );
      return {
        waited: slept.reduce((total, value) => total + value, 0),
        stoppedAt: current,
        outcome: test.completions[0]?.outcome,
      };
    };

    // Same code, two deadlines, two windows: the window is derived, not a constant.
    const short = await windowFor("2026-07-28T00:02:00.000Z");
    const long = await windowFor("2026-07-28T00:05:00.000Z");

    const shortCeiling = REBOOT_SETTLE_BUDGET_SHARE * 120_000;
    const longCeiling = REBOOT_SETTLE_BUDGET_SHARE * 300_000;
    expect(short.waited).toBeGreaterThan(shortCeiling - 2 * connection.connectTimeoutMs);
    expect(short.waited).toBeLessThanOrEqual(shortCeiling);
    expect(long.waited).toBeGreaterThan(longCeiling - 2 * connection.connectTimeoutMs);
    expect(long.waited).toBeLessThanOrEqual(longCeiling);
    expect(long.waited).toBeGreaterThan(short.waited);
    // Half the budget is deliberately left for the observation, its reports and
    // the reconciliation attempts, which share the SAME deadline.
    expect(short.stoppedAt).toBeLessThan(Date.parse("2026-07-28T00:02:00.000Z"));
    expect(long.stoppedAt).toBeLessThan(Date.parse("2026-07-28T00:05:00.000Z"));
    expect(short.outcome).toBe("UNCERTAIN");
    expect(long.outcome).toBe("UNCERTAIN");
  });

  it("keeps a router's own refusal of a reboot terminal instead of wedging the device", async () => {
    const test = harness({
      reboot: async () => {
        throw new RouterOperationError("ROUTEROS_COMMAND_REJECTED", {
          retryable: false,
          mayHaveExecuted: false,
        });
      },
    });

    await test.processor.processClaim(claim("REBOOT_ROUTER"), connection);

    // The router answered on a completed channel that it refused: it provably did
    // not reboot, so nothing is uncertain and the device must not be locked out.
    expect(test.completions[0]).toMatchObject({
      outcome: "FAILED",
      result: { code: "ROUTEROS_COMMAND_REJECTED" },
    });
  });

  it("keeps a pre-dispatch validation failure on a disruptive action terminal", async () => {
    const test = harness();
    test.interfaceRegistry.update(connection.deviceId, [{
      managedResourceId: "50000000-0000-4000-8000-000000000001",
      id: "70000000-0000-4000-8000-000000000001",
      interfaceKey: "ether4",
      currentName: "room-401",
      immutableKey: "ether4",
      enrolledRole: "ACCESS",
      protected: false,
      enrollmentState: "ENROLLED",
    }]);

    await test.processor.processClaim({
      ...claim("CYCLE_ACCESS_PORT"),
      interfaceId: "70000000-0000-4000-8000-000000000001",
      parameters: { durationSeconds: 4_000 },
    }, connection);

    expect(test.calls).not.toContain("cycle-port");
    expect(test.completions[0]).toMatchObject({
      outcome: "FAILED",
      result: { code: "INVALID_CYCLE_DURATION" },
    });
  });

  it("keeps a port cycle uncertain when its post-check cannot reach the router", async () => {
    let observeCalls = 0;
    const test = harness({
      observeAction: async () => {
        observeCalls += 1;
        if (observeCalls === 1) {
          return {
            observedAt: "2026-07-28T00:00:00.000Z",
            reachable: true,
            accessInterface: {
              managedResourceId: "50000000-0000-4000-8000-000000000001",
              immutableKey: "ether4",
              enabled: true,
              disabledObserved: false,
              enabledObserved: true,
            },
          };
        }
        throw new RouterOperationError("SSH_CONNECT_TIMEOUT", {
          retryable: true,
          mayHaveExecuted: false,
        });
      },
    });
    test.interfaceRegistry.update(connection.deviceId, [{
      managedResourceId: "50000000-0000-4000-8000-000000000001",
      id: "70000000-0000-4000-8000-000000000001",
      interfaceKey: "ether4",
      currentName: "room-401",
      immutableKey: "ether4",
      enrolledRole: "ACCESS",
      protected: false,
      enrollmentState: "ENROLLED",
    }]);

    await test.processor.processClaim({
      ...claim("CYCLE_ACCESS_PORT"),
      interfaceId: "70000000-0000-4000-8000-000000000001",
      parameters: { durationSeconds: 5 },
      managedTarget: {
        managedResourceId: "50000000-0000-4000-8000-000000000001",
        immutableKey: "ether4",
      },
    }, connection);

    // The cycle is disruptive and non-idempotent too: a retry replays it, because
    // pre_observation is frozen and the retry skips straight to the action.
    expect(test.calls.filter((value) => value === "cycle-port")).toHaveLength(1);
    expect(test.completions[0]).not.toMatchObject({ outcome: "RETRYABLE_FAILURE" });
    expect(test.completions[0]).toMatchObject({
      outcome: "UNCERTAIN",
      result: { code: "SSH_CONNECT_TIMEOUT" },
    });
  });

  it("treats a padded action type as the disruptive action it names", async () => {
    let observeCalls = 0;
    const test = harness({
      observeAction: async () => {
        observeCalls += 1;
        if (observeCalls === 1) {
          return {
            observedAt: "2026-07-28T00:00:00.000Z",
            reachable: true,
            boot: { bootId: "boot-1", uptimeSeconds: 936_727 },
          };
        }
        throw new RouterOperationError("SSH_CONNECT_FAILED", {
          retryable: true,
          mayHaveExecuted: false,
        });
      },
    });

    await test.processor.processClaim(claim(" REBOOT_ROUTER "), connection);

    expect(test.calls.filter((value) => value === "reboot")).toHaveLength(1);
    expect(test.completions[0]).toMatchObject({ outcome: "UNCERTAIN" });
  });

  it("settles the production-shaped reboot on ONE reboot, in about a minute", async () => {
    // Every number here is the one production actually used on 2026-08-03:
    // a 10-minute observation deadline stamped by the server for REBOOT_ROUTER,
    // connect_timeout_ms 8000 on the demo hEX's connection, and a router that
    // answers SSH again 62 s after the command (measured: 54-70 s).
    const productionConnection = { ...connection, connectTimeoutMs: 8_000, pollIntervalSeconds: 60 };
    const startMs = Date.parse("2026-08-03T10:12:23.000Z");
    const routerBackAtMs = startMs + 62_000;
    let current = startMs;
    let observeCalls = 0;
    const slept: number[] = [];
    const test = harness({
      observeAction: async () => {
        observeCalls += 1;
        if (observeCalls === 1) {
          return {
            observedAt: new Date(current).toISOString(),
            reachable: true,
            boot: { bootId: "routeros-boot:1784815213", uptimeSeconds: 936_727 },
          };
        }
        if (current < routerBackAtMs) {
          // A dead router burns the whole connect timeout before it gives up.
          current += productionConnection.connectTimeoutMs;
          throw new RouterOperationError("SSH_CONNECT_TIMEOUT", {
            retryable: true,
            mayHaveExecuted: false,
          });
        }
        return {
          observedAt: new Date(current).toISOString(),
          reachable: true,
          boot: {
            bootId: `routeros-boot:${Math.floor(routerBackAtMs / 1_000) - 8}`,
            uptimeSeconds: Math.floor((current - routerBackAtMs) / 1_000) + 8,
          },
        };
      },
    }, false, {}, {
      clock: {
        now: () => new Date(current),
        setInterval: () => 1,
        clearInterval: () => undefined,
        sleep: async (milliseconds: number) => {
          slept.push(milliseconds);
          current += milliseconds;
        },
      },
    });

    await test.processor.processClaim({
      ...claim("REBOOT_ROUTER"),
      observationDeadline: new Date(startMs + 600_000).toISOString(),
    }, productionConnection);

    const waited = current - startMs;
    // ONE reboot. This is the whole point: the old code issued a second one.
    expect(test.calls.filter((value) => value === "reboot")).toHaveLength(1);
    expect(test.completions).toHaveLength(1);
    expect(test.completions[0]).toMatchObject({ outcome: "EVALUATE_POSTCONDITION" });
    expect(test.stages.find((entry) => entry.eventKind === "POST_CHECK_COMPLETED")?.payload)
      .toMatchObject({ decision: { outcome: "SUCCEEDED" } });
    // The normal case costs about the router's real return, NOT the ceiling: the
    // ceiling is ~4 min 45 s here and must not be spent when the router is back.
    expect(waited).toBeGreaterThanOrEqual(62_000);
    expect(waited).toBeLessThan(90_000);
    expect(rebootSettleCeilingMs(600_000)).toBe(300_000);
    expect(waited).toBeLessThan(rebootSettleCeilingMs(600_000) / 3);
  });
});
