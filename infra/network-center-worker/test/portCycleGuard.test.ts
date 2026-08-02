import { describe, expect, it } from "vitest";

import {
  ROUTER_OS_COMMANDS,
  ROUTER_OS_READ_COMMANDS,
  routerOsCommandFailed,
} from "../src/routeros/sshConnector.js";
import { createFakeRouterSession, createTestConnector } from "./support/fakeRouterClient.js";
import { FakeRouterOs } from "./support/fakeRouterOs.js";

const OWNERSHIP_MARKER = "ihomecrm-network-center:v1:demo-router-20260730";

/** duration + ACCESS_PORT_CYCLE_GUARD_GRACE_SECONDS for the 5s cycles below. */
const GUARD_DELAY_SECONDS = 20;

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

/** Kills the exec that disables the port — never the one that arms the guard. */
const dieInsideTheCycle = (command: string) =>
  command.includes("/interface/disable") ? { kind: "no-exit-status" as const } : null;

describe("access port cycle dead-man's switch", () => {
  it("cycles a port on a router whose device-mode forbids /system/scheduler", async () => {
    // The demo hEX runs device-mode `home`: `/system/scheduler/add` is answered
    // with `failure: not allowed by device-mode` on stdout, exit status 0. A guard
    // built on the scheduler is inert there, so the guard must not use it at all.
    const router = makeRouter();
    const session = createFakeRouterSession(router);
    const connector = createTestConnector(session.clientFactory);

    await connector.cycleAccessPort(target, 5);

    expect(router.interfaceByDefaultName("ether4").disabled).toBe(false);
    expect(session.commands.filter((command) => command.includes("/system/scheduler"))).toEqual([]);
    expect(router.trace).not.toContain("scheduler-denied");
    expect(router.scheduler).toHaveLength(0);
  });

  it("lets the router re-enable the access port when the cycle session dies in the delay", async () => {
    const router = makeRouter();
    const session = createFakeRouterSession(router, { interrupt: dieInsideTheCycle });
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
    expect(router.jobs).toHaveLength(1);

    // The guard must honour its own delay: nothing happens before it is due.
    router.advanceSeconds(GUARD_DELAY_SECONDS - 1);
    expect(router.interfaceByDefaultName("ether4").disabled).toBe(true);

    // The router alone must restore the tenant's port and reap the job.
    router.advanceSeconds(2);
    expect(router.interfaceByDefaultName("ether4").disabled).toBe(false);
    expect(router.trace).toContain("enable:ether4");
    expect(router.jobs).toHaveLength(0);
  });

  it("arms the router-side guard before the port is ever disabled", async () => {
    const router = makeRouter();
    const session = createFakeRouterSession(router, { interrupt: dieInsideTheCycle });
    const connector = createTestConnector(session.clientFactory);

    await expect(connector.cycleAccessPort(target, 5)).rejects.toBeTruthy();

    const armed = router.trace.findIndex((entry) => entry.startsWith("job-start:"));
    const disabled = router.trace.indexOf("disable:ether4");
    expect(armed).toBeGreaterThanOrEqual(0);
    expect(disabled).toBeGreaterThan(armed);

    // Arming is a separate exec, so the worker refuses to send the disabling one
    // until the router has told it the guard exists.
    const armCommand = session.commands.findIndex((command) => command.includes(":execute"));
    const cycleCommand = session.commands.findIndex((command) =>
      command.includes("/interface/disable"));
    expect(armCommand).toBeGreaterThanOrEqual(0);
    expect(cycleCommand).toBeGreaterThan(armCommand);
    expect(session.commands[cycleCommand]).not.toContain(":execute");
  });

  it("binds the guard to the resolved id, the immutable default name and the cycle window", async () => {
    const router = makeRouter();
    const session = createFakeRouterSession(router, { interrupt: dieInsideTheCycle });
    const connector = createTestConnector(session.clientFactory);
    await expect(connector.cycleAccessPort(target, 5)).rejects.toBeTruthy();

    const guard = router.jobs[0];
    expect(guard?.script).toContain(".id=*B");
    expect(guard?.script).toContain("default-name=ether4");
    expect(guard?.script).toContain(`:delay ${GUARD_DELAY_SECONDS}s`);
    // A guard may only ever re-enable. Nothing it can do leaves a port down.
    expect(guard?.script).toContain("/interface/enable");
    expect(guard?.script).not.toContain("/interface/disable");
  });

  it("refuses to touch the port when the router denies :execute", async () => {
    // A router that rejects the guard primitive prints `failure: ...` on stdout
    // *after* the arm command has already put a marker line, and still exits 0.
    const router = makeRouter({ deviceMode: { execute: false } });
    const session = createFakeRouterSession(router);
    const connector = createTestConnector(session.clientFactory);

    await expect(connector.cycleAccessPort(target, 5)).rejects.toMatchObject({
      name: "RouterOperationError",
      code: "ROUTEROS_COMMAND_REJECTED",
      retryable: false,
      mayHaveExecuted: false,
    });

    expect(router.trace).toContain("execute-denied");
    expect(router.trace).not.toContain("disable:ether4");
    expect(router.interfaceByDefaultName("ether4").disabled).toBe(false);
    expect(router.jobs).toHaveLength(0);
  });

  it("completes a healthy cycle and leaves no background job behind", async () => {
    const router = makeRouter();
    const session = createFakeRouterSession(router);
    const connector = createTestConnector(session.clientFactory);

    await connector.cycleAccessPort(target, 5);

    expect(router.interfaceByDefaultName("ether4").disabled).toBe(false);
    expect(router.jobs).toHaveLength(0);
    expect(router.trace).toEqual(expect.arrayContaining([
      "disable:ether4",
      "delay:5",
      "enable:ether4",
    ]));
    // The worker enabled the port itself; the guard was cancelled, never fired.
    expect(router.trace.filter((entry) => entry === "enable:ether4")).toHaveLength(1);
    expect(router.trace.some((entry) => entry.startsWith("job-remove:"))).toBe(true);
    expect(router.trace.some((entry) => entry.startsWith("job-end:"))).toBe(false);

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

  it("never cancels a background job it did not create", async () => {
    const router = makeRouter({
      // An operator's own long-running job, started before the worker connected.
      jobs: [{
        script: ":delay 3600s; /interface/disable [/interface/find where .id=*1 and default-name=ether1]",
      }],
    });
    const operatorJob = router.jobs[0]?.id;
    const session = createFakeRouterSession(router);
    const connector = createTestConnector(session.clientFactory);

    await connector.cycleAccessPort(target, 5);

    expect(router.jobs.map((job) => job.id)).toEqual([operatorJob]);
    expect(router.trace).not.toContain(`job-remove:${operatorJob}`);
    const disarm = session.commands.find((command) =>
      command.includes("/system/script/job/remove"));
    expect(disarm).toBeDefined();
    expect(disarm).not.toContain(`.id=${operatorJob}`);
  });

  it("refuses to arm a second guard while its own guard is still running", async () => {
    const router = makeRouter();
    const session = createFakeRouterSession(router, { interrupt: dieInsideTheCycle });
    const connector = createTestConnector(session.clientFactory);

    await expect(connector.cycleAccessPort(target, 5)).rejects.toBeTruthy();
    expect(router.jobs).toHaveLength(1);

    await expect(connector.cycleAccessPort(target, 5)).rejects.toMatchObject({
      name: "RouterOperationError",
      code: "PORT_CYCLE_GUARD_STILL_PENDING",
      retryable: true,
      mayHaveExecuted: false,
    });

    // Exactly one guard, exactly one disable: guards never stack.
    expect(router.jobs).toHaveLength(1);
    expect(router.trace.filter((entry) => entry === "disable:ether4")).toHaveLength(1);
    expect(router.trace.filter((entry) => entry.startsWith("job-start:"))).toHaveLength(1);
  });

  it("re-arms normally once the pending guard has fired", async () => {
    const router = makeRouter();
    const session = createFakeRouterSession(router, {
      interrupt: (command) =>
        router.trace.includes("enable:ether4") ? null : dieInsideTheCycle(command),
    });
    const connector = createTestConnector(session.clientFactory);

    await expect(connector.cycleAccessPort(target, 5)).rejects.toBeTruthy();
    router.advanceSeconds(GUARD_DELAY_SECONDS + 1);
    expect(router.jobs).toHaveLength(0);
    expect(router.interfaceByDefaultName("ether4").disabled).toBe(false);

    await connector.cycleAccessPort(target, 5);
    expect(router.interfaceByDefaultName("ether4").disabled).toBe(false);
    expect(router.jobs).toHaveLength(0);
    expect(router.trace.filter((entry) => entry === "disable:ether4")).toHaveLength(2);
  });

  it("refuses to arm when the ownership marker disappears between the read and the arm", async () => {
    const router = makeRouter();
    const session = createFakeRouterSession(router, {
      // The recovery rule is gone by the time the arm command reaches the router.
      beforeCommand: (command) => {
        if (command.includes(":execute")) router.firewall.splice(0, router.firewall.length);
      },
    });
    const connector = createTestConnector(session.clientFactory);

    await expect(connector.cycleAccessPort(target, 5)).rejects.toMatchObject({
      name: "RouterOperationError",
      mayHaveExecuted: false,
    });

    expect(router.trace).not.toContain("disable:ether4");
    expect(router.interfaceByDefaultName("ether4").disabled).toBe(false);
    expect(router.jobs).toHaveLength(0);
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
    expect(router.jobs).toHaveLength(0);
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

describe("RouterOS failure reporting", () => {
  it("treats a failure line as a failure wherever it appears in the output", () => {
    // RouterOS reports a refused command on stdout and still exits 0. Anchoring
    // the check at the start of the output misses every refusal that follows a
    // marker line the same script already printed.
    expect(routerOsCommandFailed(
      "NC_CYCLE_OWNER:ether4\n"
      + "failure: not allowed by device-mode (/system/scheduler/add; line 1)\n",
    )).toBe(true);
    expect(routerOsCommandFailed(
      "NC_CYCLE_GUARD_PENDING:0\nnot enough permissions\nfailure: no such item\n",
    )).toBe(true);
    expect(routerOsCommandFailed("failure: no such item\n")).toBe(true);
  });

  it("does not mistake router data that merely mentions a failure for one", () => {
    expect(routerOsCommandFailed(
      "0 R name=ether1 comment=failure: drill\n1 R name=ether2 comment=syntax error demo\n",
    )).toBe(false);
    expect(routerOsCommandFailed("NC_CYCLE_ARMED:*102:ether4\n")).toBe(false);
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
