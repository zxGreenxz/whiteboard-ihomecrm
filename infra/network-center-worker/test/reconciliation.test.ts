import { describe, expect, it } from "vitest";

import {
  reconcileAction,
  type ActionObservation,
  type CommandIntent,
} from "../src/reconciliation.js";

const observedAt = "2026-07-30T00:00:00.000Z";

function intent(
  actionType: CommandIntent["actionType"],
  overrides: Partial<CommandIntent> = {},
): CommandIntent {
  return {
    actionType,
    deviceId: "40000000-0000-4000-8000-000000000001",
    managedTarget: {},
    expectedPostcondition: {},
    observationDeadline: "2026-07-30T00:05:00.000Z",
    ...overrides,
  };
}

function observation(overrides: Partial<ActionObservation>): ActionObservation {
  return { observedAt, reachable: true, ...overrides };
}

describe("action-specific reconciliation", () => {
  it("accepts an exact DNS command ACK and keeps ambiguous transport uncertain", () => {
    expect(reconcileAction(
      intent("FLUSH_DNS_CACHE"),
      observation({}),
      observation({ dns: { commandAck: true } }),
    )).toMatchObject({ outcome: "SUCCEEDED" });

    expect(reconcileAction(
      intent("FLUSH_DNS_CACHE"),
      observation({}),
      observation({ reachable: true }),
    )).toMatchObject({ outcome: "UNCERTAIN" });
  });

  it("requires a bound DHCP lease with a newer expiry", () => {
    const before = observation({
      dhcp: { leaseKey: "wan-dhcp", status: "bound", expiresInSeconds: 120 },
    });
    expect(reconcileAction(
      intent("RENEW_DHCP_LEASE"),
      before,
      observation({
        dhcp: { leaseKey: "wan-dhcp", status: "bound", expiresInSeconds: 3_600 },
      }),
    )).toMatchObject({ outcome: "SUCCEEDED" });

    expect(reconcileAction(
      intent("RENEW_DHCP_LEASE"),
      before,
      observation({
        dhcp: { leaseKey: "wan-dhcp", status: "bound", expiresInSeconds: 60 },
      }),
    )).toMatchObject({ outcome: "UNCERTAIN" });
  });

  it("returns a typed terminal result when DHCP does not apply", () => {
    expect(reconcileAction(
      intent("RENEW_DHCP_LEASE"),
      observation({ dhcp: { notApplicable: true } }),
      observation({ dhcp: { notApplicable: true } }),
    )).toMatchObject({
      outcome: "FAILED",
      code: "DHCP_RENEW_NOT_APPLICABLE",
      evidence: { notApplicable: true },
    });
  });

  it("requires the exact immutable access interface to transition and finish enabled", () => {
    const managedTarget = {
      managedResourceId: "50000000-0000-4000-8000-000000000001",
      immutableKey: "ether4",
    };
    const before = observation({
      accessInterface: {
        ...managedTarget,
        enabled: true,
        disabledObserved: false,
        enabledObserved: true,
      },
    });
    const after = observation({
      accessInterface: {
        ...managedTarget,
        enabled: true,
        disabledObserved: true,
        enabledObserved: true,
      },
    });

    expect(reconcileAction(
      intent("CYCLE_ACCESS_PORT", { managedTarget }),
      before,
      after,
    )).toMatchObject({ outcome: "SUCCEEDED" });

    expect(reconcileAction(
      intent("CYCLE_ACCESS_PORT", { managedTarget }),
      before,
      observation({
        accessInterface: {
          ...managedTarget,
          immutableKey: "ether5",
          enabled: true,
          disabledObserved: true,
          enabledObserved: true,
        },
      }),
    )).toMatchObject({ outcome: "UNCERTAIN" });
  });

  it("requires a new reboot boot identity and reset uptime", () => {
    const before = observation({ boot: { bootId: "boot-1", uptimeSeconds: 86_400 } });
    expect(reconcileAction(
      intent("REBOOT_ROUTER"),
      before,
      observation({ boot: { bootId: "boot-2", uptimeSeconds: 15 } }),
    )).toMatchObject({ outcome: "SUCCEEDED" });

    expect(reconcileAction(
      intent("REBOOT_ROUTER"),
      before,
      observation({ boot: { bootId: "boot-1", uptimeSeconds: 86_450 } }),
    )).toMatchObject({ outcome: "UNCERTAIN" });
  });

  it("requires both redacted and encrypted snapshot hashes", () => {
    expect(reconcileAction(
      intent("CAPTURE_SNAPSHOT"),
      observation({}),
      observation({
        snapshot: {
          redactedContentHash: "a".repeat(64),
          encryptedArtifactHash: "b".repeat(64),
        },
      }),
    )).toMatchObject({ outcome: "SUCCEEDED" });

    expect(reconcileAction(
      intent("CAPTURE_SNAPSHOT"),
      observation({}),
      observation({ snapshot: { redactedContentHash: "a".repeat(64) } }),
    )).toMatchObject({ outcome: "UNCERTAIN" });
  });

  it("never maps generic reachable health to success or failure", () => {
    for (const actionType of [
      "FLUSH_DNS_CACHE",
      "RENEW_DHCP_LEASE",
      "CYCLE_ACCESS_PORT",
      "REBOOT_ROUTER",
      "CAPTURE_SNAPSHOT",
    ] as const) {
      expect(reconcileAction(
        intent(actionType),
        observation({}),
        observation({ reachable: true }),
      )).toMatchObject({ outcome: "UNCERTAIN" });
    }
  });
});
