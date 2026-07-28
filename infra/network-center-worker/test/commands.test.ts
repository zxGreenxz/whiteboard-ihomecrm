import { describe, expect, it } from "vitest";

import { CommandCoordinator, CommandProcessor, sanitizeRouterExport } from "../src/commands.js";
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
  };
}

function harness(
  overrides: Partial<RouterConnector> = {},
  emergencyStop: boolean | (() => boolean) = false,
) {
  const calls: string[] = [];
  const completions: Array<Record<string, unknown>> = [];
  let renewCallback: (() => void | Promise<void>) | undefined;
  const connector: RouterConnector = {
    poll: async () => ({ observedAt: new Date().toISOString(), device: {}, interfaces: [], clients: [], aruba: [] }),
    captureBackup: async () => {
      calls.push("backup");
      return {
        binary: new Uint8Array([1, 2, 3]),
        redactedExport: "/system identity set name=demo",
      };
    },
    healthCheck: async () => {
      calls.push("post-check");
      return { reachable: true, wanUp: true, dnsOk: true };
    },
    flushDnsCache: async () => { calls.push("flush"); },
    renewDhcpLease: async () => { calls.push("renew-dhcp"); return true; },
    cycleAccessPort: async () => { calls.push("cycle-port"); },
    reboot: async () => { calls.push("reboot"); },
    close: async () => { calls.push("close"); },
    ...overrides,
  };
  const processor = new CommandProcessor({
    api: {
      renewLease: async () => { calls.push("renew-lease"); },
      stage: async (input: { eventKind: string }) => { calls.push(input.eventKind); },
      complete: async (input: Record<string, unknown>) => { completions.push(input); },
      snapshot: async () => { calls.push("snapshot"); },
    },
    connectorFactory: async () => connector,
    backupStore: { save: async () => ({ path: "/backups/safe.backup", sha256: "a".repeat(64), bytes: 3 }) },
    interfaceRegistry: new InterfaceRegistry(),
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
  return { calls, completions, processor, triggerRenew: async () => renewCallback?.() };
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
      "BACKUP_STARTED",
      "backup",
      "snapshot",
      "BACKUP_COMPLETED",
      "EXECUTION_STARTED",
      "flush",
      "EXECUTION_COMPLETED",
      "POST_CHECK_STARTED",
      "post-check",
      "POST_CHECK_COMPLETED",
      "close",
      "renew-lease",
    ]));
    expect(test.completions).toHaveLength(1);
    expect(test.completions[0]).toMatchObject({ outcome: "SUCCEEDED" });
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
        return { binary: new Uint8Array([1]), redactedExport: "/system identity print" };
      },
    }, () => stopped);

    await test.processor.processClaim(claim(), connection);
    expect(test.calls).not.toContain("flush");
    expect(test.completions[0]).toMatchObject({ outcome: "CANCELLED_BY_KILL_SWITCH" });
  });

  it("does not replay actions during reconciliation", async () => {
    const test = harness();
    await test.processor.processClaim({ ...claim("REBOOT_ROUTER"), reconciliation: true }, connection);
    expect(test.calls).not.toContain("backup");
    expect(test.calls).not.toContain("reboot");
    expect(test.calls).toEqual(expect.arrayContaining([
      "RECONCILIATION_STARTED",
      "post-check",
      "RECONCILIATION_COMPLETED",
    ]));
    expect(test.completions[0]).toMatchObject({ outcome: "SUCCEEDED" });
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
    const test = harness({ renewDhcpLease: async () => false });
    await test.processor.processClaim(claim("RENEW_DHCP_LEASE"), connection);
    expect(test.completions[0]).toMatchObject({
      outcome: "SUCCEEDED",
      result: { actionResult: { applied: false, reason: "NO_BOUND_DHCP_CLIENT" } },
    });
  });

  it("deduplicates the same command attempt in one worker process", async () => {
    const test = harness();
    await test.processor.processClaim(claim(), connection);
    await test.processor.processClaim(claim(), connection);
    expect(test.calls.filter((value) => value === "flush")).toHaveLength(1);
    expect(test.completions).toHaveLength(1);
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
