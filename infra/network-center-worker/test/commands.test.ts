import { describe, expect, it } from "vitest";

import { CommandCoordinator, CommandProcessor, sanitizeRouterExport } from "../src/commands.js";
import type { BackupStore } from "../src/backupStore.js";
import { InterfaceRegistry, RouterOperationError } from "../src/domain.js";
import type { RouterConnector } from "../src/routeros/connector.js";

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
) {
  const calls: string[] = [];
  const completions: Array<Record<string, unknown>> = [];
  const observations: Array<Record<string, unknown>> = [];
  const snapshots: Array<Record<string, unknown>> = [];
  const interfaceRegistry = new InterfaceRegistry();
  let dnsAck = false;
  let dhcpRenewed = false;
  let portCycled = false;
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
            disabledObserved: portCycled,
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
    cycleAccessPort: async () => { calls.push("cycle-port"); portCycled = true; },
    reboot: async () => { calls.push("reboot"); rebooted = true; },
    close: async () => { calls.push("close"); },
    ...overrides,
  };
  const processor = new CommandProcessor({
    api: {
      renewLease: async () => { calls.push("renew-lease"); },
      stage: async (input: { eventKind: string }) => { calls.push(input.eventKind); },
      observe: async (input: Record<string, unknown>) => {
        calls.push(`observe-${String(input.observationKind)}`);
        observations.push(input);
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
    clock: {
      now: () => new Date("2026-07-28T00:00:00.000Z"),
      setInterval: (callback) => { renewCallback = callback; return 1; },
      clearInterval: () => undefined,
      sleep: async () => undefined,
    },
    leaseSeconds: 90,
    logger: { info() {}, warn() {}, error() {} },
  });
  return {
    calls,
    completions,
    observations,
    snapshots,
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
});
