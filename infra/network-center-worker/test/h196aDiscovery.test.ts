import { describe, expect, it } from "vitest";

import {
  bridgeAgeingSeconds,
  discoverH196aCandidates,
  normalizedStableMac,
  safeH196aName,
} from "../src/h196a/discovery.js";
import { parseDurationSeconds } from "../src/routeros/sshConnector.js";

/**
 * Every fixture here is a transcription of what the 950NK hEX actually
 * returned on 28/08/2026, not an invented shape. The five units, their ports
 * and their ARP states are the real ones, and "Berlin" really was holding a
 * valid lease while absent from the bridge host table.
 */
const OBSERVED_AT = "2026-08-28T02:00:00.000Z";

function lease(over: Record<string, string>): Record<string, string> {
  return {
    "class-id": "MULTIAP_MASTER",
    status: "bound",
    server: "dhcp-hotspot",
    ...over,
  };
}

const NHA_XE = lease({
  address: "192.168.95.234",
  "mac-address": "3C:A7:AE:9D:2B:60",
  "host-name": "atadevice3c:a7:ae:9d:2b:60",
  comment: "Nha xe",
});
const BERLIN = lease({
  address: "192.168.95.244",
  "mac-address": "3C:A7:AE:9F:24:54",
  "host-name": "atadevice3c:a7:ae:9f:24:54",
  comment: "Berlin",
});
const CHUA_DAT_TEN = lease({
  address: "192.168.95.233",
  "mac-address": "50:42:89:4F:81:C8",
  "host-name": "atadevice50:42:89:4f:81:c8",
});

const HOST_TABLE = [
  { "mac-address": "3C:A7:AE:9D:2B:60", "on-interface": "ether2", bridge: "bridge-hotspot" },
  { "mac-address": "50:42:89:4F:81:C8", "on-interface": "ether3", bridge: "bridge-hotspot" },
];
const ARP_TABLE = [
  { address: "192.168.95.234", "mac-address": "3C:A7:AE:9D:2B:60", status: "reachable" },
  { address: "192.168.95.244", "mac-address": "3C:A7:AE:9F:24:54", status: "stale" },
  { address: "192.168.95.233", "mac-address": "50:42:89:4F:81:C8", status: "reachable" },
];
const BRIDGES = [
  { name: "bridge-hotspot", "ageing-time": "5m" },
  { name: "bridge-camera", "ageing-time": "5m" },
];

function chay(over: Partial<Parameters<typeof discoverH196aCandidates>[0]> = {}) {
  return discoverH196aCandidates({
    observedAt: OBSERVED_AT,
    leases: [NHA_XE, BERLIN, CHUA_DAT_TEN],
    arp: ARP_TABLE,
    bridgeHosts: HOST_TABLE,
    bridgeAgeingSeconds: 300,
    ...over,
  });
}

describe("H196A downstream discovery", () => {
  it("finds every H196A lease and nothing else", () => {
    const khac = [
      // A guest phone: randomized MAC, no MULTIAP marker.
      { address: "192.168.95.249", "mac-address": "CE:19:94:BC:57:1B", status: "bound" },
      // An Aruba IAP. It has its own discovery path and must not be captured here.
      {
        address: "192.168.88.3",
        "mac-address": "C8:B5:AD:CB:89:C8",
        "class-id": "ArubaInstantAP",
        status: "bound",
      },
      // A Windows PC. It even publishes LLDP, which is exactly why the class-id
      // and not the neighbour table decides.
      {
        address: "192.168.88.16",
        "mac-address": "10:FF:E0:2D:E7:E6",
        "host-name": "DESKTOP-CESMAPL",
        "class-id": "MSFT",
        status: "bound",
      },
    ];
    const kq = chay({ leases: [NHA_XE, ...khac, BERLIN, CHUA_DAT_TEN] });

    expect(kq.valid).toHaveLength(3);
    expect(kq.valid.map((x) => x.macAddress).sort()).toEqual([
      "3c:a7:ae:9d:2b:60",
      "3c:a7:ae:9f:24:54",
      "50:42:89:4f:81:c8",
    ]);
    expect(kq.quarantined).toHaveLength(0);
  });

  it("reports a unit absent from the bridge host table as STALE, not ONLINE", () => {
    // The whole reason this module exists. Berlin holds a bound lease that will
    // not expire for hours, and lease presence alone would call it healthy.
    const berlin = chay().valid.find((x) => x.displayName === "Berlin");

    expect(berlin?.healthStatus).toBe("STALE");
    expect(berlin?.healthReason).toBe("LEASE_BOUND_BUT_NO_FRAME");
    expect(berlin?.bridgePort).toBeNull();
  });

  it("treats an idle ARP entry as alive when a frame was still seen", () => {
    // RouterOS marks idle neighbours `stale` routinely - three of the five real
    // units were `stale` while plainly working. Reading that as death would
    // have reported a healthy building as mostly dead.
    const kq = chay({
      arp: [{ address: "192.168.95.234", "mac-address": "3C:A7:AE:9D:2B:60", status: "stale" }],
    });
    const nhaXe = kq.valid.find((x) => x.displayName === "Nha xe");

    expect(nhaXe?.arpStatus).toBe("stale");
    expect(nhaXe?.healthStatus).toBe("ONLINE");
    expect(nhaXe?.bridgePort).toBe("ether2");
  });

  it("says UNKNOWN, never OFFLINE, when the bridge host table could not be read", () => {
    const kq = chay({ bridgeHosts: null });

    expect(kq.valid).toHaveLength(3);
    for (const item of kq.valid) {
      expect(item.healthStatus).toBe("UNKNOWN");
      expect(item.healthReason).toBe("BRIDGE_HOST_TABLE_UNREADABLE");
    }
  });

  it("distinguishes an unreadable ARP table from an empty one", () => {
    // `[]` is an answer; `null` is a missing answer. Collapsing them would let
    // one rejected command fabricate an outage.
    expect(chay({ arp: [] }).valid[0]?.evidenceSources).not.toContain("MIKROTIK_ARP");
    expect(chay({ arp: null }).valid[0]?.healthStatus).toBe("ONLINE");
  });

  it("collapses two leases for one MAC into a single observation", () => {
    // The 21000 that took every building blind for 20 hours on 26-27/08 came
    // from exactly this: one MAC, two rows, one ON CONFLICT DO UPDATE.
    const kq = chay({
      leases: [
        NHA_XE,
        lease({ address: "192.168.1.49", "mac-address": "3C:A7:AE:9D:2B:60", server: "dhcp-camera" }),
      ],
    });

    expect(kq.valid).toHaveLength(1);
    const keys = kq.valid.map((x) => x.stableKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("quarantines a randomized MAC instead of enrolling a new device each poll", () => {
    const kq = chay({
      leases: [lease({ address: "192.168.95.250", "mac-address": "5E:D9:35:6E:CB:8A" })],
    });

    expect(kq.valid).toHaveLength(0);
    expect(kq.quarantined).toHaveLength(1);
    expect(kq.quarantined[0]?.code).toBe("H196A_STABLE_IDENTITY_INVALID");
    expect(kq.quarantined[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("names a unit from its lease comment, and falls back when there is none", () => {
    const kq = chay();

    expect(kq.valid.find((x) => x.macAddress === "3c:a7:ae:9d:2b:60")?.displayName).toBe("Nha xe");
    expect(kq.valid.find((x) => x.macAddress === "3c:a7:ae:9f:24:54")?.displayName).toBe("Berlin");
    // Three of the five units are still waiting for their real name.
    expect(kq.valid.find((x) => x.macAddress === "50:42:89:4f:81:c8")?.displayName)
      .toBe("H196A 4f:81:c8");
  });

  it("re-reads the name every poll so renaming needs no deploy", () => {
    const doiTen = chay({ leases: [{ ...NHA_XE, comment: "Nha xe - tang tret" }] });

    expect(doiTen.valid[0]?.displayName).toBe("Nha xe - tang tret");
    // Clearing the comment returns the default rather than pinning the old name.
    expect(chay({ leases: [{ ...NHA_XE, comment: "" }] }).valid[0]?.displayName)
      .toBe("H196A 9d:2b:60");
  });

  it("keeps a name containing spaces", () => {
    // An earlier draft wrote the control-character class as `[ -]`, which
    // matches a SPACE - it would have rejected both real names and silently
    // renamed every unit to its MAC tail.
    expect(safeH196aName("Nha xe")).toBe("Nha xe");
    expect(safeH196aName("Tang 2 truoc")).toBe("Tang 2 truoc");
    expect(safeH196aName("xau\u0000hong")).toBeNull();
    expect(safeH196aName("   ")).toBeNull();
    expect(safeH196aName("x".repeat(161))).toBeNull();
  });

  it("never claims a model, serial or firmware it cannot see", () => {
    // No MikroTik read yields any of these for an H196A. A field here would be
    // an invitation to render one.
    const item = chay().valid[0] as unknown as Record<string, unknown>;
    for (const cam of ["model", "serialNumber", "firmwareVersion"]) {
      expect(item).not.toHaveProperty(cam);
    }
    expect(chay().valid[0]?.identitySource).toBe("HARDWARE_MAC");
  });

  it("records the bridge ageing interval rather than assuming five minutes", () => {
    expect(bridgeAgeingSeconds(BRIDGES, parseDurationSeconds)).toBe(300);
    expect(bridgeAgeingSeconds([{ name: "b", "ageing-time": "30s" }], parseDurationSeconds)).toBe(30);
    // Shortest wins: it bounds how fast absence becomes visible anywhere.
    expect(bridgeAgeingSeconds(
      [{ name: "a", "ageing-time": "5m" }, { name: "b", "ageing-time": "1m" }],
      parseDurationSeconds,
    )).toBe(60);
    expect(bridgeAgeingSeconds(null, parseDurationSeconds)).toBeNull();
    expect(bridgeAgeingSeconds([{ name: "b" }], parseDurationSeconds)).toBeNull();
  });

  it("rejects broadcast and all-zero MACs outright", () => {
    expect(normalizedStableMac("00:00:00:00:00:00")).toBeNull();
    expect(normalizedStableMac("ff:ff:ff:ff:ff:ff")).toBeNull();
    expect(normalizedStableMac("3C:A7:AE:9D:2B:60")).toBe("3c:a7:ae:9d:2b:60");
    expect(normalizedStableMac(undefined)).toBeNull();
  });
});

describe("ARP la bang chung song doc lap", () => {
  it("treats a reachable ARP entry as alive even without a host-table entry", () => {
    // The host table ages a MAC out after one ageing interval, so a unit that
    // is forwarding client traffic under its clients' MACs can vanish from it
    // while plainly alive. Measured on 950NK: the two units absent from the
    // host table were `stale` in ARP too, and the ones present were not - the
    // two tables agree, so the gap ARP covers is real and narrow.
    const kq = discoverH196aCandidates({
      observedAt: OBSERVED_AT,
      leases: [NHA_XE],
      arp: [{ address: "192.168.95.234", "mac-address": "3C:A7:AE:9D:2B:60", status: "reachable" }],
      bridgeHosts: [],
      bridgeAgeingSeconds: 300,
    });

    expect(kq.valid[0]?.bridgePort).toBeNull();
    expect(kq.valid[0]?.healthStatus).toBe("ONLINE");
    expect(kq.valid[0]?.healthReason).toBe("ARP_REACHABLE");
  });

  it("still calls a unit quiet when neither table shows it", () => {
    const kq = discoverH196aCandidates({
      observedAt: OBSERVED_AT,
      leases: [CHUA_DAT_TEN],
      arp: [{ address: "192.168.95.233", "mac-address": "50:42:89:4F:81:C8", status: "stale" }],
      bridgeHosts: [],
      bridgeAgeingSeconds: 300,
    });

    expect(kq.valid[0]?.healthStatus).toBe("STALE");
  });
});
