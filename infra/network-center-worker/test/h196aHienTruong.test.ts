import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { bridgeAgeingSeconds, discoverH196aCandidates } from "../src/h196a/discovery.js";
import { parseDurationSeconds, parseRouterOsRecords } from "../src/routeros/sshConnector.js";

/**
 * The unit tests above build their own records. This one runs the parser over
 * output the 950NK hEX actually produced on 28/08/2026, so a change to the
 * RouterOS terse format - or to an assumption about it - fails here rather than
 * in production.
 *
 * The fixture is REDACTED to the five H196A units and the router's own bridges.
 * Every guest lease, MAC and machine name was stripped before it was committed:
 * a regression fixture is not a reason to put tenants' devices in a git repo.
 */
describe("H196A discovery over real 950NK output", () => {
  const raw = JSON.parse(
    readFileSync(new URL("./thuc-te-950nk.json", import.meta.url), "utf8"),
  ) as { leases: string; arp: string; bridgeHosts: string; bridges: string };

  const bridges = parseRouterOsRecords(raw.bridges);
  const ket_qua = discoverH196aCandidates({
    observedAt: "2026-08-28T02:00:00.000Z",
    leases: parseRouterOsRecords(raw.leases),
    arp: parseRouterOsRecords(raw.arp),
    bridgeHosts: parseRouterOsRecords(raw.bridgeHosts),
    bridgeAgeingSeconds: bridgeAgeingSeconds(bridges, parseDurationSeconds),
  });

  it("finds all five units, once each, with nothing quarantined", () => {
    expect(ket_qua.valid).toHaveLength(5);
    expect(new Set(ket_qua.valid.map((x) => x.stableKey)).size).toBe(5);
    expect(ket_qua.quarantined).toEqual([]);
  });

  it("carries the operator's names through from the lease comments", () => {
    const ten = Object.fromEntries(ket_qua.valid.map((x) => [x.macAddress, x.displayName]));
    expect(ten["3c:a7:ae:9d:2b:60"]).toBe("Nha xe");
    expect(ten["3c:a7:ae:9f:24:54"]).toBe("Berlin");
    // The remaining three have no name yet and fall back rather than blank out.
    expect(ten["50:42:89:4f:81:c8"]).toBe("H196A 4f:81:c8");
  });

  it("reads the ageing interval off the router instead of assuming it", () => {
    expect(bridgeAgeingSeconds(bridges, parseDurationSeconds)).toBe(300);
    for (const item of ket_qua.valid) expect(item.bridgeAgeingSeconds).toBe(300);
  });

  it("separates the units that were forwarding from the ones that were quiet", () => {
    // This is the verdict the Aruba model cannot produce: `ArubaObservation`
    // hard-codes reachable=true, so every unit holding a lease would read as
    // healthy. In this capture two units were in the bridge host table and
    // three were not - and the three were `stale` in ARP as well, so the two
    // independent tables agreed.
    const trang_thai = Object.fromEntries(ket_qua.valid.map((x) => [x.macAddress, x.healthStatus]));
    expect(trang_thai["3c:a7:ae:9d:2b:60"]).toBe("ONLINE");
    expect(trang_thai["3c:a7:ae:9f:24:54"]).toBe("ONLINE");
    expect(trang_thai["50:42:89:4f:81:c8"]).toBe("STALE");
    // Quiet is never reported as OFFLINE from one poll: that verdict needs the
    // three-poll hysteresis the control plane applies, not a single sample.
    expect(ket_qua.valid.every((x) => x.healthStatus !== "UNKNOWN")).toBe(true);
  });

  it("never invents a model, serial or firmware, because none is observable", () => {
    for (const item of ket_qua.valid) {
      expect(item.identitySource).toBe("HARDWARE_MAC");
      expect(item.evidenceSources).toContain("MIKROTIK_DHCP_LEASE");
      expect(item.evidenceSources).not.toContain("MIKROTIK_NEIGHBOR" as never);
    }
  });
});
