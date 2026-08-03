import { describe, expect, it } from "vitest";

import {
  ACCESS_PORT_CYCLE_GUARD_GRACE_SECONDS,
  buildAccessPortCycleCommand,
  buildAccessPortCycleGuardScript,
  MAX_ACCESS_PORT_CYCLE_SECONDS,
  MIN_ACCESS_PORT_CYCLE_SECONDS,
} from "../src/routeros/portCycle.js";
import { classifyWorkerError } from "../src/domain.js";
import {
  ROUTER_OS_COMMANDS,
  ROUTER_OS_READ_COMMANDS,
  routerOsCommandFailed,
  routerOsFailureLine,
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

/**
 * Burns router time immediately before the port is disabled, which is exactly what a
 * slow SSH round trip does to any recovery window that is *not* anchored on the
 * disable itself.
 */
function stallBeforeDisable(router: FakeRouterOs, seconds: number) {
  return (command: string) => {
    if (command.includes("/interface/disable")) router.advanceSeconds(seconds);
  };
}

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

    // Nothing the console does may sit between arming and disabling: every statement
    // in that gap is recovery window the guard has already started spending.
    const console = router.trace.filter((entry) => !entry.startsWith("job-"));
    const armed = router.trace.findIndex((entry) => entry.startsWith("job-start:"));
    expect(armed).toBeGreaterThanOrEqual(0);
    expect(router.trace.indexOf("disable:ether4")).toBeGreaterThan(armed);
    expect(console[0]).toBe("disable:ether4");
  });

  it("arms the guard from the same console job that disables the port", async () => {
    // The guard's `:delay` starts when the router creates the job. If arming is its
    // own SSH exec, the whole round trip to the *next* exec is subtracted from the
    // recovery window before the port is even disabled.
    const router = makeRouter();
    const session = createFakeRouterSession(router);
    const connector = createTestConnector(session.clientFactory);

    await connector.cycleAccessPort(target, 5);

    const disabling = session.commands.filter((command) =>
      command.includes("/interface/disable"));
    expect(disabling).toHaveLength(1);
    expect(disabling[0]).toContain(":execute");
    expect(disabling[0]?.indexOf(":execute"))
      .toBeLessThan(disabling[0]?.indexOf("/interface/disable") ?? -1);
    // And no earlier exec may start a job of its own.
    const armingCommands = session.commands.filter((command) => command.includes(":execute"));
    expect(armingCommands).toEqual(disabling);
  });

  it("keeps the full disable window inside the guard when the round trip is slow", async () => {
    // A round trip longer than the guard's grace used to let the router re-enable the
    // port *inside* the cycle: the tenant's link never really went down for the
    // requested window, yet the command still reported a healthy cycle.
    const router = makeRouter();
    const session = createFakeRouterSession(router, {
      beforeCommand: stallBeforeDisable(router, ACCESS_PORT_CYCLE_GUARD_GRACE_SECONDS + 1),
    });
    const connector = createTestConnector(session.clientFactory);

    await connector.cycleAccessPort(target, 5);

    // The guard stayed a fallback: the worker enabled the port itself and cancelled
    // a job that was still counting down.
    expect(router.trace.filter((entry) => entry === "enable:ether4")).toHaveLength(1);
    expect(router.trace.some((entry) => entry.startsWith("job-end:"))).toBe(false);
    expect(router.trace.some((entry) => entry.startsWith("job-remove:"))).toBe(true);
    expect(router.jobs).toHaveLength(0);
    expect(router.interfaceByDefaultName("ether4").disabled).toBe(false);
  });

  it("still has a live guard when the round trip outlasts the whole guard window", async () => {
    // The other end of the same race: with the window anchored on the arm, a round
    // trip longer than duration + grace left the guard already reaped, and the cycle
    // aborted as "guard is missing" — reported UNCERTAIN despite touching nothing.
    const router = makeRouter();
    const session = createFakeRouterSession(router, {
      beforeCommand: stallBeforeDisable(router, GUARD_DELAY_SECONDS + 1),
    });
    const connector = createTestConnector(session.clientFactory);

    await connector.cycleAccessPort(target, 5);

    expect(router.trace.filter((entry) => entry === "disable:ether4")).toHaveLength(1);
    expect(router.trace.filter((entry) => entry === "enable:ether4")).toHaveLength(1);
    expect(router.trace.some((entry) => entry.startsWith("job-end:"))).toBe(false);
    expect(router.interfaceByDefaultName("ether4").disabled).toBe(false);
    expect(router.jobs).toHaveLength(0);
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

  it("does not accept a dynamic firewall row as proof it still owns the router", async () => {
    // This selector's caller reads `< 1` as the failure, so a matched row
    // SATISFIES the check: it is fail-OPEN by construction, and everything it
    // can reach is something the cycle then proceeds on. A dynamic row is one
    // the bootstrap neither wrote nor can write.
    //
    // Both halves are driven from one fixture: `printFirewall` feeds the
    // worker's read, and `/ip/firewall/filter/find` answers the router-side
    // guard, so the same row has to be rejected twice for this to pass.
    const router = makeRouter({
      firewall: [{
        chain: "input",
        action: "accept",
        "in-interface": "ether2",
        dynamic: "true",
        comment: `${OWNERSHIP_MARKER}:lan-recovery`,
      }],
    });
    const session = createFakeRouterSession(router);
    const connector = createTestConnector(session.clientFactory);

    await expect(connector.cycleAccessPort(target, 5)).rejects.toMatchObject({
      name: "RouterOperationError",
      code: "ROUTER_OWNERSHIP_MARKER_UNAVAILABLE",
      mayHaveExecuted: false,
    });

    expect(router.trace).not.toContain("disable:ether4");
    expect(router.jobs).toHaveLength(0);
  });

  it("still refuses when the row only turns dynamic after the worker read it", async () => {
    // The worker's read is satisfied — a static owned rule was there when it
    // looked — so the only thing standing between the cycle and a port that
    // nothing owns is the `and !dynamic` term in the selector the ROUTER
    // evaluates. This is the same read-then-use gap the marker-disappears test
    // covers, with the rule replaced rather than removed.
    const router = makeRouter();
    const session = createFakeRouterSession(router, {
      beforeCommand: (command) => {
        if (command.includes(":execute")) Object.assign(router.firewall[0] ?? {}, {
          dynamic: "true",
        });
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
    expect(session.commands.some((command) => command.includes(
      "/ip/firewall/filter/find where chain=input and action=accept and comment="
      + `"${OWNERSHIP_MARKER}:lan-recovery" and !dynamic`,
    ))).toBe(true);
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

  it("recognises a PERMISSION refusal, which carries no `failure:` prefix", () => {
    // Measured on the demo hEX under the hardened worker group (2026-08-03).
    // Every one of these came back on stdout with exit status 0.
    expect(routerOsCommandFailed("not enough permissions (9)\n")).toBe(true);
    expect(routerOsCommandFailed("not enough permissions (9) (/user/add; line 1)\n")).toBe(true);
    expect(routerOsFailureLine("not enough permissions (9)\n")).toBe("not enough permissions (9)");
    // ...and it is still recognised after output the same command already printed.
    expect(routerOsCommandFailed("NC_CYCLE_OWNER:ether4\nnot enough permissions (9)\n")).toBe(true);
    // The reported line is the REFUSAL, not the marker that preceded it.
    expect(routerOsFailureLine("NC_CYCLE_OWNER:ether4\nnot enough permissions (9)\n"))
      .toBe("not enough permissions (9)");
    // Router data that merely mentions permissions is still not a failure.
    expect(routerOsCommandFailed("0 R name=ether1 comment=not enough permissions\n")).toBe(false);
    expect(routerOsFailureLine("NC_CYCLE_ARMED:*102:ether4\n")).toBeNull();
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

  it("fails a cycle closed when the firewall read channel dies", async () => {
    // Named for what it proves: the *read* is refused, so the empty recovery-rule set
    // a truncated channel would otherwise produce never reaches the protection check
    // at all. The protection itself is proved on a healthy read, below.
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
    }, 5)).rejects.toMatchObject({
      name: "RouterOperationError",
      code: "SSH_EXEC_NO_EXIT_STATUS",
      mayHaveExecuted: false,
    });

    expect(router.trace).not.toContain("disable:ether2");
    expect(router.interfaceByDefaultName("ether2").disabled).toBe(false);
    // Nothing was armed either: the refusal lands before any router-side state.
    expect(session.commands.filter((command) => command.includes(":execute"))).toEqual([]);
  });

  it("refuses to cycle the interface its own recovery rule protects", async () => {
    // The property the test above used to be named for, on a firewall read that
    // really delivered the owned `…:lan-recovery` rule for ether2.
    const router = makeRouter();
    const session = createFakeRouterSession(router);
    const connector = createTestConnector(session.clientFactory);

    await expect(connector.cycleAccessPort({
      ...target,
      interfaceKey: "ether2",
      currentName: "ether2",
      immutableKey: "ether2",
    }, 5)).rejects.toMatchObject({
      name: "RouterOperationError",
      code: "PROTECTED_INTERFACE",
      retryable: false,
      mayHaveExecuted: false,
    });

    expect(router.trace).not.toContain("disable:ether2");
    expect(router.interfaceByDefaultName("ether2").disabled).toBe(false);
    expect(router.jobs).toHaveLength(0);
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

  it("fails a reboot refused for permissions, terminally, in the router's own words", async () => {
    // `reboot` is the ONE policy in the worker's minimum set that has never been
    // measured — proving it means rebooting a live gateway — so "the group lacks
    // reboot" is a live possibility, and this is what it must look like when it
    // happens. RouterOS answers on stdout with exit status 0 and no `failure:`
    // prefix, so before this was recognised the worker reported the reboot as
    // ISSUED and failed later as an unexplained postcondition miss.
    const router = makeRouter();
    const session = createFakeRouterSession(router, {
      refuse: (command) =>
        command === ROUTER_OS_COMMANDS.reboot ? "not enough permissions (9)" : null,
    });
    const connector = createTestConnector(session.clientFactory);

    await expect(connector.reboot()).rejects.toMatchObject({
      name: "RouterOperationError",
      code: "ROUTEROS_COMMAND_REJECTED",
      retryable: false,
      // The router ANSWERED that it refused, on a completed channel, and
      // `/system/reboot` is a single statement — so it provably did not reboot.
      // UNCERTAIN here would lock the device out of every later command until a
      // human retired it, and pause the building, for a non-event.
      mayHaveExecuted: false,
      message: "not enough permissions (9)",
    });
  });

  it("settles a refused reboot as FAILED, not as UNCERTAIN", async () => {
    const router = makeRouter();
    const session = createFakeRouterSession(router, {
      refuse: (command) =>
        command === ROUTER_OS_COMMANDS.reboot ? "not enough permissions (9)" : null,
    });
    const connector = createTestConnector(session.clientFactory);

    const error = await connector.reboot().catch((thrown: unknown) => thrown);
    // REBOOT_ROUTER is disruptive, which is the branch that turns
    // `mayHaveExecuted` into a device-locking UNCERTAIN.
    expect(classifyWorkerError(error, true)).toMatchObject({
      outcome: "FAILED",
      result: { code: "ROUTEROS_COMMAND_REJECTED", message: "not enough permissions (9)" },
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

  it("reads the exit status from ssh2's exit event when close carries no arguments", async () => {
    // ssh2 repeats the exit arguments on `close` only for session channels; the
    // worker must not depend on that repetition to tell a completed command from a
    // channel that died, or the whole exit-status contract rests on one code path.
    const router = makeRouter();
    const session = createFakeRouterSession(router, {
      interrupt: () => ({ kind: "exit", code: 0, closeWithoutArguments: true }),
    });
    const connector = createTestConnector(session.clientFactory);

    await expect(connector.healthCheck()).resolves.toMatchObject({ reachable: true });
  });

  it("fails a non-zero exit status that only reached the worker on the exit event", async () => {
    const router = makeRouter();
    const session = createFakeRouterSession(router, {
      interrupt: (command) => command === ROUTER_OS_COMMANDS.flushDnsCache
        ? { kind: "exit", code: 1, closeWithoutArguments: true }
        : null,
    });
    const connector = createTestConnector(session.clientFactory);

    await expect(connector.flushDnsCache()).rejects.toMatchObject({
      name: "RouterOperationError",
      code: "ROUTEROS_COMMAND_FAILED",
      retryable: false,
    });
  });

  it("does not accept truncated output that ended with a clean zero exit status", async () => {
    // The complement of the transport-death cases: a *complete* channel whose output
    // was cut short is a router that really answered, so it must not be rejected by
    // the exit-status guard. Keeps the guard from passing for the wrong reason.
    const router = makeRouter();
    const session = createFakeRouterSession(router, {
      interrupt: (command) => command === ROUTER_OS_READ_COMMANDS.interfaces
        ? { kind: "exit", code: 0, truncateOutputTo: 60 }
        : null,
    });
    const connector = createTestConnector(session.clientFactory);

    const observation = await connector.poll();
    expect(observation.interfaces).toHaveLength(1);
  });
});

describe("access port cycle duration validation", () => {
  const cycleTarget = {
    resourceId: "*B",
    currentName: "room-401",
    immutableKey: "ether4",
    ownershipMarker: OWNERSHIP_MARKER,
  };

  // Observed on the demo hEX during hardware validation: the builder takes two
  // POSITIONAL arguments, so calling it with a single options object left
  // `durationSeconds` undefined. `undefined + 15` is NaN, NaN survives
  // assertRouterOsScriptBlock (its characters are ordinary printable ASCII), and
  // the router was handed a script containing `:delay NaNs`, which it parsed and
  // then rejected at runtime. The file already asserts `resourceId` and
  // `immutableKey`; the duration was the only scripted value left unguarded.
  const rejected: [string, unknown][] = [
    ["undefined (the observed hardware defect)", undefined],
    ["NaN", Number.NaN],
    ["null", null],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a numeric string", "10"],
    ["a fractional second count", 5.5],
    ["negative", -5],
    ["zero", 0],
    ["one below MIN_ACCESS_PORT_CYCLE_SECONDS", MIN_ACCESS_PORT_CYCLE_SECONDS - 1],
    ["one above MAX_ACCESS_PORT_CYCLE_SECONDS", MAX_ACCESS_PORT_CYCLE_SECONDS + 1],
  ];

  it.each(rejected)("refuses to script a cycle whose duration is %s", (_label, duration) => {
    expect(() => buildAccessPortCycleCommand(cycleTarget, duration as number)).toThrow(TypeError);
    expect(() => buildAccessPortCycleCommand(cycleTarget, duration as number))
      .toThrow(/cycle duration is invalid/i);
  });

  it.each(rejected)("refuses to script a guard whose duration is %s", (_label, duration) => {
    expect(() => buildAccessPortCycleGuardScript(cycleTarget, duration as number))
      .toThrow(/cycle duration is invalid/i);
  });

  it("never emits a delay the router cannot parse", () => {
    for (const [, duration] of rejected) {
      let script: string | null = null;
      try {
        script = buildAccessPortCycleCommand(cycleTarget, duration as number);
      } catch {
        script = null;
      }
      expect(script).toBeNull();
    }
  });

  it("still scripts every second in the documented window", () => {
    for (
      let duration = MIN_ACCESS_PORT_CYCLE_SECONDS;
      duration <= MAX_ACCESS_PORT_CYCLE_SECONDS;
      duration += 1
    ) {
      const script = buildAccessPortCycleCommand(cycleTarget, duration);
      expect(script).toContain(`:delay ${duration}s`);
      expect(script).toContain(
        `:delay ${duration + ACCESS_PORT_CYCLE_GUARD_GRACE_SECONDS}s;`,
      );
      expect(script).not.toContain("NaN");
      expect(script).not.toContain("undefined");
    }
  });
});
