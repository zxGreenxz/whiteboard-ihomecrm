import { describe, expect, it } from "vitest";

import { ROUTER_OS_COMMANDS, ROUTER_OS_READ_COMMANDS } from "../src/routeros/sshConnector.js";
import { createFakeRouterSession, createTestConnector } from "./support/fakeRouterClient.js";
import { FakeRouterOs } from "./support/fakeRouterOs.js";

const OWNERSHIP_MARKER = "ihomecrm-network-center:v1:demo-router-20260730";
const GUARD_NAME = "ihomecrm-network-center-v1-port-cycle";

const target = {
  managedResourceId: "managed-resource-uuid",
  interfaceId: "interface-uuid",
  interfaceKey: "ether4",
  currentName: "room-401",
  immutableKey: "ether4",
  enrolledRole: "ACCESS" as const,
  protected: false,
  enrollmentState: "ENROLLED" as const,
};

function makeRouter(overrides: Partial<ConstructorParameters<typeof FakeRouterOs>[0]> = {}) {
  return new FakeRouterOs({
    interfaces: [
      { id: "*1", name: "ether1", defaultName: "ether1", type: "ether", disabled: false },
      { id: "*2", name: "ether2", defaultName: "ether2", type: "ether", disabled: false },
      { id: "*B", name: "room-401", defaultName: "ether4", type: "ether", disabled: false },
    ],
    firewall: [{
      chain: "input",
      action: "accept",
      "in-interface": "ether2",
      comment: `${OWNERSHIP_MARKER}:lan-recovery`,
    }],
    ...overrides,
  });
}

describe("access port cycle dead-man's switch", () => {
  it("lets the router re-enable the access port when the cycle session dies in the delay", async () => {
    const router = makeRouter();
    const session = createFakeRouterSession(router, {
      interrupt: (command) => command.includes(":delay ") ? { kind: "no-exit-status" } : null,
    });
    const connector = createTestConnector(session.clientFactory);

    await expect(connector.cycleAccessPort(target, 5)).rejects.toMatchObject({
      name: "RouterOperationError",
      retryable: true,
      mayHaveExecuted: true,
    });

    // The session died mid-delay, so the worker never ran `/interface/enable`.
    expect(router.trace).toContain("disable:ether4");
    expect(router.trace).not.toContain("enable:ether4");
    expect(router.interfaceByDefaultName("ether4").disabled).toBe(true);

    // The router alone must restore the tenant's port and clean up after itself.
    router.advanceSeconds(30);
    expect(router.interfaceByDefaultName("ether4").disabled).toBe(false);
    expect(router.trace).toContain(`scheduler-fire:${GUARD_NAME}`);
    expect(router.scheduler).toHaveLength(0);
  });

  it("arms the router-side guard before the port is ever disabled", async () => {
    const router = makeRouter();
    const session = createFakeRouterSession(router, {
      interrupt: (command) => command.includes(":delay ") ? { kind: "no-exit-status" } : null,
    });
    const connector = createTestConnector(session.clientFactory);

    await expect(connector.cycleAccessPort(target, 5)).rejects.toBeTruthy();

    const armed = router.trace.findIndex((entry) => entry.startsWith("scheduler-add:"));
    const disabled = router.trace.indexOf("disable:ether4");
    expect(armed).toBeGreaterThanOrEqual(0);
    expect(disabled).toBeGreaterThan(armed);
  });

  it("completes a healthy cycle and leaves no scheduler residue behind", async () => {
    const router = makeRouter();
    const session = createFakeRouterSession(router);
    const connector = createTestConnector(session.clientFactory);

    await connector.cycleAccessPort(target, 5);

    expect(router.interfaceByDefaultName("ether4").disabled).toBe(false);
    expect(router.scheduler).toHaveLength(0);
    expect(router.trace).toEqual(expect.arrayContaining([
      `scheduler-add:${GUARD_NAME}:20s`,
      "disable:ether4",
      "delay:5",
      "enable:ether4",
      `scheduler-remove:${GUARD_NAME}`,
    ]));
    expect(router.trace).not.toContain(`scheduler-fire:${GUARD_NAME}`);

    const observation = await connector.observeAction({
      actionType: "CYCLE_ACCESS_PORT",
      deviceId: "device-id",
      managedTarget: target,
      expectedPostcondition: { kind: "IMMUTABLE_ACCESS_INTERFACE_CYCLE" },
      observationDeadline: "2026-07-30T00:05:00.000Z",
    });
    expect(observation.accessInterface).toMatchObject({
      managedResourceId: target.managedResourceId,
      immutableKey: target.immutableKey,
      disabledObserved: true,
      enabledObserved: true,
      enabled: true,
    });
  });

  it("binds the guard to the immutable default name and the managed ownership marker", async () => {
    const router = makeRouter();
    const session = createFakeRouterSession(router, {
      interrupt: (command) => command.includes(":delay ") ? { kind: "no-exit-status" } : null,
    });
    const connector = createTestConnector(session.clientFactory);
    await expect(connector.cycleAccessPort(target, 5)).rejects.toBeTruthy();

    const guard = router.scheduler[0];
    expect(guard?.name).toBe(GUARD_NAME);
    expect(guard?.comment).toBe(`${OWNERSHIP_MARKER}:port-cycle`);
    expect(guard?.onEvent).toContain("default-name=ether4");
    expect(guard?.onEvent).toContain(".id=*B");
    expect(guard?.policy.split(",").sort()).toEqual(["read", "write"]);
  });

  it("replaces a stale owned guard instead of reusing it", async () => {
    const router = makeRouter({
      scheduler: [{
        name: GUARD_NAME,
        comment: `${OWNERSHIP_MARKER}:port-cycle`,
        intervalSeconds: 3_600,
        policy: "read,write",
        onEvent: "/interface/enable [/interface/find where .id=*9 and default-name=ether9]",
        armedAtSeconds: 0,
      }],
    });
    const session = createFakeRouterSession(router);
    const connector = createTestConnector(session.clientFactory);

    await connector.cycleAccessPort(target, 5);

    expect(router.trace).toContain(`scheduler-remove:${GUARD_NAME}`);
    expect(router.trace.filter((entry) => entry.startsWith("scheduler-add:"))).toHaveLength(1);
    expect(router.scheduler).toHaveLength(0);
    expect(router.interfaceByDefaultName("ether4").disabled).toBe(false);
  });

  it("never clobbers a scheduler entry the worker does not own", async () => {
    const router = makeRouter({
      scheduler: [{
        name: GUARD_NAME,
        comment: "operator nightly maintenance",
        intervalSeconds: 86_400,
        policy: "read,write",
        onEvent: "/interface/enable [/interface/find where .id=*1 and default-name=ether1]",
        armedAtSeconds: 0,
      }],
    });
    const session = createFakeRouterSession(router);
    const connector = createTestConnector(session.clientFactory);

    await expect(connector.cycleAccessPort(target, 5)).rejects.toMatchObject({
      name: "RouterOperationError",
      retryable: false,
      mayHaveExecuted: false,
    });

    expect(router.scheduler).toHaveLength(1);
    expect(router.scheduler[0]?.comment).toBe("operator nightly maintenance");
    expect(router.trace).not.toContain("disable:ether4");
    expect(router.interfaceByDefaultName("ether4").disabled).toBe(false);
  });

  it("refuses to cycle a router that carries no owned ownership marker", async () => {
    const router = makeRouter({ firewall: [] });
    const session = createFakeRouterSession(router);
    const connector = createTestConnector(session.clientFactory);

    await expect(connector.cycleAccessPort(target, 5)).rejects.toMatchObject({
      name: "RouterOperationError",
      retryable: false,
      mayHaveExecuted: false,
    });
    expect(router.trace).not.toContain("disable:ether4");
    expect(router.scheduler).toHaveLength(0);
  });

  it("refuses to start a cycle the SSH command timeout cannot outlive", async () => {
    const router = makeRouter();
    const session = createFakeRouterSession(router);
    const connector = createTestConnector(session.clientFactory, { commandTimeoutMs: 20_000 });

    await expect(connector.cycleAccessPort(target, 30)).rejects.toMatchObject({
      name: "RouterOperationError",
      retryable: false,
      mayHaveExecuted: false,
    });
    expect(session.commands).toEqual([]);
    expect(router.trace).toEqual([]);
  });
});

describe("SSH exec completion contract", () => {
  it("does not report a channel that closed without an exit status as success", async () => {
    const router = makeRouter();
    const session = createFakeRouterSession(router, {
      interrupt: (command) =>
        command === ROUTER_OS_READ_COMMANDS.interfaces ? { kind: "no-exit-status" } : null,
    });
    const connector = createTestConnector(session.clientFactory);

    await expect(connector.poll()).rejects.toMatchObject({
      name: "RouterOperationError",
      code: "SSH_EXEC_NO_EXIT_STATUS",
      retryable: true,
      mayHaveExecuted: false,
    });
  });

  it("does not surface silently truncated output as a complete inventory", async () => {
    const router = makeRouter();
    const session = createFakeRouterSession(router, {
      interrupt: (command) => command === ROUTER_OS_READ_COMMANDS.interfaces
        // Only the first interface line survives the transport failure.
        ? { kind: "no-exit-status", truncateOutputTo: 60 }
        : null,
    });
    const connector = createTestConnector(session.clientFactory);

    await expect(connector.poll()).rejects.toMatchObject({
      code: "SSH_EXEC_NO_EXIT_STATUS",
    });
  });

  it("keeps recovery-interface protection when the firewall read channel dies", async () => {
    const router = makeRouter();
    const session = createFakeRouterSession(router, {
      interrupt: (command) => command === ROUTER_OS_READ_COMMANDS.firewallFilters
        // Truncated to nothing: the owned lan-recovery rule never arrives.
        ? { kind: "no-exit-status", truncateOutputTo: 0 }
        : null,
    });
    const connector = createTestConnector(session.clientFactory);

    await expect(connector.cycleAccessPort({
      ...target,
      interfaceKey: "ether2",
      currentName: "ether2",
      immutableKey: "ether2",
    }, 5)).rejects.toMatchObject({ name: "RouterOperationError", mayHaveExecuted: false });

    expect(router.trace).not.toContain("disable:ether2");
    expect(router.interfaceByDefaultName("ether2").disabled).toBe(false);
  });

  it("does not report a channel killed by a remote signal as success", async () => {
    const router = makeRouter();
    const session = createFakeRouterSession(router, {
      interrupt: (command) =>
        command === ROUTER_OS_READ_COMMANDS.firewallFilters
          ? { kind: "signal", signal: "SIGKILL" }
          : null,
    });
    const connector = createTestConnector(session.clientFactory);

    await expect(connector.poll()).rejects.toMatchObject({
      name: "RouterOperationError",
      code: "SSH_EXEC_NO_EXIT_STATUS",
      retryable: true,
    });
  });

  it("still lets a reboot succeed when the console dies before sending an exit status", async () => {
    const router = makeRouter();
    const session = createFakeRouterSession(router, {
      // `/system/reboot` legitimately tears the console down mid-command.
      interrupt: (command) =>
        command === ROUTER_OS_COMMANDS.reboot ? { kind: "no-exit-status" } : null,
    });
    const connector = createTestConnector(session.clientFactory);

    await expect(connector.reboot()).resolves.toBeUndefined();
    expect(session.commands).toEqual([ROUTER_OS_COMMANDS.reboot]);
  });

  it("does not let a non-reboot mutation pass on a dead channel", async () => {
    const router = makeRouter();
    const session = createFakeRouterSession(router, {
      interrupt: (command) =>
        command === ROUTER_OS_COMMANDS.flushDnsCache ? { kind: "no-exit-status" } : null,
    });
    const connector = createTestConnector(session.clientFactory);

    await expect(connector.flushDnsCache()).rejects.toMatchObject({
      code: "SSH_EXEC_NO_EXIT_STATUS",
    });
  });

  it("still fails a reboot the router rejected outright", async () => {
    const router = makeRouter();
    const session = createFakeRouterSession(router, {
      interrupt: (command) =>
        command === ROUTER_OS_COMMANDS.reboot ? { kind: "exit", code: 1 } : null,
    });
    const connector = createTestConnector(session.clientFactory);

    await expect(connector.reboot()).rejects.toMatchObject({
      code: "ROUTEROS_COMMAND_FAILED",
    });
  });

  it("still accepts a normal zero exit status", async () => {
    const router = makeRouter();
    const session = createFakeRouterSession(router);
    const connector = createTestConnector(session.clientFactory);

    const health = await connector.healthCheck();
    expect(health.reachable).toBe(true);
  });
});
