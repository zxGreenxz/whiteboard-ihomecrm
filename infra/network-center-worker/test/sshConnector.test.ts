import { describe, expect, it } from "vitest";

import {
  ROUTER_OS_COMMANDS,
  ROUTER_OS_READ_COMMANDS,
  leaseExpiryIso,
  normalizeHostFingerprint,
  parseRouterOsRecords,
  quoteRouterOsValue,
  routerOsCommandFailed,
  routerOsInterfaceState,
} from "../src/routeros/sshConnector.js";

describe("RouterOS SSH boundary", () => {
  it("parses singleton and terse output without exposing a raw command API", async () => {
    expect(parseRouterOsRecords("name=ether1;running=true\nname=ether2;running=false\n"))
      .toEqual([
        { name: "ether1", running: "true" },
        { name: "ether2", running: "false" },
      ]);
    expect(parseRouterOsRecords(
      '0 R name=ether1 default-name=ether1 type=ether comment="WAN uplink"\n' +
      '1  S name=ether2 address= disabled=false\n',
    )).toEqual([
      { ".flags": "R", name: "ether1", "default-name": "ether1", type: "ether", comment: "WAN uplink" },
      { ".flags": "S", name: "ether2", address: "", disabled: "false" },
    ]);
    expect(parseRouterOsRecords(
      "0 R name=ether1 last-link-up-time=jul/28/2026 21:25:44 comment=WAN uplink link-downs=1\n" +
      "1 D address=192.0.2.10 class-id=dhcpcd 5.0\n",
    )).toEqual([
      {
        ".flags": "R",
        name: "ether1",
        "last-link-up-time": "jul/28/2026 21:25:44",
        comment: "WAN uplink",
        "link-downs": "1",
      },
      { ".flags": "D", address: "192.0.2.10", "class-id": "dhcpcd 5.0" },
    ]);

    const module = await import("../src/routeros/sshConnector.js");
    expect(Object.keys(module)).not.toContain("execRouterOs");
    expect(Object.keys(ROUTER_OS_COMMANDS).sort()).toEqual([
      "flushDnsCache",
      "reboot",
      "renewDhcpLease",
    ]);
    expect(ROUTER_OS_READ_COMMANDS.identity).toBe(":put [/system/identity/print as-value]");
    expect(ROUTER_OS_READ_COMMANDS.resource).toBe(":put [/system/resource/print as-value]");
    expect(ROUTER_OS_READ_COMMANDS.dns).toBe(":put [/ip/dns/print as-value]");
    for (const command of [
      ROUTER_OS_READ_COMMANDS.interfaces,
      ROUTER_OS_READ_COMMANDS.dhcpClients,
      ROUTER_OS_READ_COMMANDS.leases,
      ROUTER_OS_READ_COMMANDS.neighbors,
    ]) {
      expect(command).toContain("detail terse without-paging");
    }
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

  it("recognizes RouterOS command errors returned on stdout with exit code zero", () => {
    expect(routerOsCommandFailed("expected end of command (line 1 column 24)\n")).toBe(true);
    expect(routerOsCommandFailed("failure: no such item\n")).toBe(true);
    expect(routerOsCommandFailed("0 R name=ether1 comment=failure: drill\n")).toBe(false);
  });

  it("derives interface state from terse flags when boolean fields are absent", () => {
    expect(routerOsInterfaceState({ ".flags": "R" })).toEqual({ enabled: true, running: true });
    expect(routerOsInterfaceState({ ".flags": "X" })).toEqual({ enabled: false, running: false });
    expect(routerOsInterfaceState({ running: "false", disabled: "false" }))
      .toEqual({ enabled: true, running: false });
  });
});
