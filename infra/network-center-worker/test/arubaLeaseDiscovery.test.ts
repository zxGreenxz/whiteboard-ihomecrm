import { describe, expect, it } from "vitest";

import {
  MEASURED_ARUBA_OUIS,
  discoverArubaFromLeases,
  isArubaLease,
} from "../src/aruba/leaseDiscovery.js";
import { discoverAruba } from "../src/routeros/sshConnector.js";

/**
 * Shaped on what the 1392QT hEX returned on 10/11/2026: twelve Aruba IAPs, six
 * announced over LLDP and six only visible as DHCP leases behind a switch.
 * Only one of the hidden six carried `class-id=ArubaInstantAP`. MAC suffixes
 * are invented; the OUIs and the operator-style names are the real pattern.
 */
function lease(over: Record<string, string>): Record<string, string> {
  return { status: "bound", server: "dhcp1", ...over };
}

function host(mac: string, port = "ether3"): Record<string, string> {
  return { "mac-address": mac, "on-interface": port, bridge: "LAN" };
}

describe("discoverArubaFromLeases", () => {
  it("finds APs by measured OUI or Aruba class-id and names them from host-name", () => {
    const result = discoverArubaFromLeases({
      leases: [
        lease({ "mac-address": "24:DE:C6:00:00:01", address: "192.168.1.244", "host-name": "L4" }),
        lease({
          "mac-address": "24:DE:C6:00:00:02",
          address: "192.168.1.249",
          "host-name": "L4_1",
          "class-id": "ArubaInstantAP",
        }),
        lease({ "mac-address": "9C:1C:12:00:00:03", address: "192.168.1.250", "host-name": "L_2" }),
        lease({ "mac-address": "EC:61:A6:00:00:04", address: "192.168.1.151", "host-name": "LAPTOP-X", "class-id": "MSFT 5.0" }),
        lease({ "mac-address": "28:77:77:00:00:05", address: "192.168.1.15", "host-name": "atadevice28:77:77:00:00:05" }),
      ],
      arp: [],
      bridgeHosts: [
        host("24:DE:C6:00:00:01", "ether2"),
        host("24:DE:C6:00:00:02", "ether2"),
        host("9C:1C:12:00:00:03"),
        host("EC:61:A6:00:00:04"),
      ],
      announcedMacs: new Set(),
    });

    expect(result.map((item) => item.displayName)).toEqual(["L4", "L4_1", "L_2"]);
    expect(result[0]).toEqual({
      stableIdentity: "24:de:c6:00:00:01",
      identitySource: "HARDWARE_MAC",
      externalKey: "mac:24:de:c6:00:00:01",
      aliases: ["L4"],
      displayName: "L4",
      displayOnly: true,
      reachable: true,
      model: null,
      managementIp: "192.168.1.244",
      metadata: { discovery: "routeros-dhcp-lease" },
    });
  });

  it("accepts an unknown OUI only when the lease says ArubaInstantAP", () => {
    expect(isArubaLease({ "class-id": "ArubaInstantAP" }, "00:11:22:33:44:55")).toBe(true);
    expect(isArubaLease({}, "00:11:22:33:44:55")).toBe(false);
    expect(isArubaLease({ "class-id": "MSFT 5.0" }, "24:de:c6:33:44:55")).toBe(true);
    expect([...MEASURED_ARUBA_OUIS].every((oui) => /^[0-9a-f]{2}(:[0-9a-f]{2}){2}$/.test(oui))).toBe(true);
  });

  it("never reports an AP the neighbour path already announced", () => {
    const result = discoverArubaFromLeases({
      leases: [
        lease({ "mac-address": "6C:F3:7F:00:00:10", "host-name": "L1" }),
        lease({ "mac-address": "6C:F3:7F:00:00:11", "host-name": "L2" }),
      ],
      arp: [],
      bridgeHosts: [host("6C:F3:7F:00:00:10"), host("6C:F3:7F:00:00:11")],
      announcedMacs: new Set(["6c:f3:7f:00:00:10"]),
    });
    expect(result.map((item) => item.externalKey)).toEqual(["mac:6c:f3:7f:00:00:11"]);
  });

  it("proves life from frames or a reachable ARP entry, never from the lease alone", () => {
    const leases = [
      lease({ "mac-address": "24:DE:C6:00:00:21", "host-name": "frames" }),
      lease({ "mac-address": "24:DE:C6:00:00:22", "host-name": "arp" }),
      lease({ "mac-address": "24:DE:C6:00:00:23", "host-name": "silent" }),
    ];
    const arp = [
      { "mac-address": "24:DE:C6:00:00:22", status: "reachable" },
      { "mac-address": "24:DE:C6:00:00:23", status: "stale" },
    ];
    const read = discoverArubaFromLeases({
      leases,
      arp,
      bridgeHosts: [host("24:DE:C6:00:00:21")],
      announcedMacs: new Set(),
    });
    expect(read.map((item) => [item.displayName, item.reachable])).toEqual([
      ["frames", true],
      ["arp", true],
      ["silent", false],
    ]);

    // A rejected bridge host read is not evidence of an outage.
    const unreadable = discoverArubaFromLeases({
      leases: [...leases, lease({ "mac-address": "24:DE:C6:00:00:24", "host-name": "waiting", status: "waiting" })],
      arp: null,
      bridgeHosts: null,
      announcedMacs: new Set(),
    });
    expect(unreadable.map((item) => [item.displayName, item.reachable])).toEqual([
      ["frames", true],
      ["arp", true],
      ["silent", true],
      ["waiting", false],
    ]);
  });

  it("keeps one row per MAC, prefers the bound lease, and refuses unsafe identity", () => {
    const result = discoverArubaFromLeases({
      leases: [
        lease({ "mac-address": "24:DE:C6:00:00:31", address: "192.168.1.31", "host-name": "G1", status: "offered" }),
        lease({ "mac-address": "24:de:c6:00:00:31", address: "192.168.1.32", "host-name": "G1" }),
        // Locally administered (randomized) MAC with an Aruba class-id: never keyed.
        lease({ "mac-address": "26:DE:C6:00:00:32", "class-id": "ArubaInstantAP", "host-name": "fake" }),
        lease({ "mac-address": "24:DE:C6:00:00:33", "host-name": "bad\u0007name", address: "not-an-ip" }),
      ],
      arp: [],
      bridgeHosts: [],
      announcedMacs: new Set(),
    });
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ externalKey: "mac:24:de:c6:00:00:31", managementIp: "192.168.1.32" });
    expect(result[1]).toMatchObject({
      displayName: "Aruba 24:de:c6:00:00:33",
      aliases: [],
      managementIp: null,
    });
  });
});

describe("discoverAruba", () => {
  it("returns LLDP APs first, then lease-only APs, with no MAC twice", () => {
    const result = discoverAruba({
      neighbors: [
        {
          interface: "ether3,LAN",
          address: "192.168.1.245",
          "mac-address": "6C:F3:7F:00:00:40",
          identity: "L1",
          platform: "ArubaOS",
          "system-description": "ArubaOS (MODEL: 135), Version Aruba IAP",
          "discovered-by": "lldp",
        },
        { interface: "ether5", "mac-address": "B4:36:E3:00:00:41", identity: "MikroTik", platform: "MikroTik" },
      ],
      leases: [
        lease({ "mac-address": "6C:F3:7F:00:00:40", address: "192.168.1.245", "host-name": "L1" }),
        lease({ "mac-address": "6C:F3:7F:00:00:42", address: "192.168.1.2", "host-name": "L2" }),
      ],
      arp: [],
      bridgeHosts: [host("6C:F3:7F:00:00:40"), host("6C:F3:7F:00:00:42")],
    });

    expect(result.quarantined).toEqual([]);
    expect(result.valid.map((item) => [item.externalKey, item.displayName, item.metadata])).toEqual([
      ["mac:6c:f3:7f:00:00:40", "L1", { discovery: "routeros-neighbor" }],
      ["mac:6c:f3:7f:00:00:42", "L2", { discovery: "routeros-dhcp-lease" }],
    ]);
  });
});
