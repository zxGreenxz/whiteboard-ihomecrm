import { describe, expect, it } from "vitest";

import {
  ROUTER_OS_COMMANDS,
  leaseExpiryIso,
  normalizeHostFingerprint,
  parseRouterOsRecords,
  quoteRouterOsValue,
} from "../src/routeros/sshConnector.js";

describe("RouterOS SSH boundary", () => {
  it("parses as-value output without exposing a raw command API", async () => {
    expect(parseRouterOsRecords("name=ether1;running=true\nname=ether2;running=false\n"))
      .toEqual([
        { name: "ether1", running: "true" },
        { name: "ether2", running: "false" },
      ]);

    const module = await import("../src/routeros/sshConnector.js");
    expect(Object.keys(module)).not.toContain("execRouterOs");
    expect(Object.keys(ROUTER_OS_COMMANDS).sort()).toEqual([
      "flushDnsCache",
      "reboot",
      "renewDhcpLease",
    ]);
  });

  it("quotes dynamic values and normalizes pinned SHA256 fingerprints", () => {
    expect(quoteRouterOsValue("ether 4\"; /system/reboot")).toBe(
      "\"ether 4\\\"\\; /system/reboot\"",
    );
    expect(normalizeHostFingerprint("SHA256:YWJjZGVmZ2hpamtsbW5vcHFyc3Q=")).toBe(
      "YWJjZGVmZ2hpamtsbW5vcHFyc3Q",
    );
    expect(() => normalizeHostFingerprint("MD5:aa:bb")).toThrow(/SHA256/i);
  });

  it("gives dynamic and static leases a bounded current-state expiry", () => {
    const observedAt = "2026-07-28T00:00:00.000Z";
    expect(leaseExpiryIso(observedAt, "2m30s", 180)).toBe("2026-07-28T00:02:30.000Z");
    expect(leaseExpiryIso(observedAt, undefined, 180)).toBe("2026-07-28T00:03:00.000Z");
  });
});
