import type { ArubaObservation } from "../domain.js";
import { normalizedStableMac } from "../h196a/discovery.js";

/**
 * Aruba access points the router cannot see in `/ip/neighbor`.
 *
 * `parseArubaNeighbors` only knows an AP that announced itself over LLDP, and an
 * 802.1D bridge is required NOT to forward LLDP. Measured 10/11/2026 on the
 * 1392QT hEX (12 Aruba IAPs): four neighbour reads 20 s apart held the same six
 * APs every time; the other six hang off switches and never appeared. All
 * twelve held a bound DHCP lease whose `host-name` is the name the operator
 * gave the AP, and all twelve were present in the bridge host table.
 *
 * Fingerprint, either of:
 *  - a DHCP option 60 class-id starting `Aruba` (`ArubaInstantAP`). Only 2 of
 *    the 12 leases carried it, so it cannot be the only signal;
 *  - the MAC's OUI being one MEASURED on an Aruba AP in this fleet (below).
 *
 * Liveness follows the H196A rule in `../h196a/discovery.ts`: a lease outlives
 * the device holding it, so only the bridge host table or a `reachable` ARP
 * entry proves life. When the bridge host table could not be read at all, a
 * bound lease is kept as alive rather than fabricating an outage from a
 * rejected read.
 */
const ARUBA_CLASS_ID = /^aruba/i;

/**
 * OUIs seen on access points that announced `platform=ArubaOS` over LLDP at
 * 102LVT, 111PVC, 15KV, 331PHI, 512TT and 1392QT, plus `9c:1c:12`, whose 1392QT
 * unit answered port 80 with the same redirect to :4343 as an LLDP-confirmed
 * IAP on the same switch. Extend only from a measured device, never from a
 * vendor registry: a wrong entry turns somebody's phone into an access point.
 */
export const MEASURED_ARUBA_OUIS: ReadonlySet<string> = new Set([
  "18:64:72",
  "24:de:c6",
  "24:f2:7f",
  "34:fc:b9",
  "6c:f3:7f",
  "9c:1c:12",
  "b0:b8:67",
  "b4:5d:50",
  "c8:b5:ad",
  "d8:c7:c8",
  "f0:5c:19",
  "f4:2e:7f",
]);

/** Same ceiling `network_devices_name_check` and `safeArubaAlias` apply. */
const MAX_NAME = 160;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

function blankToNull(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function safeName(value: string | undefined): string | null {
  const trimmed = blankToNull(value);
  if (trimmed === null || trimmed.length > MAX_NAME) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

export function isArubaLease(lease: Record<string, string>, mac: string): boolean {
  const classId = blankToNull(lease["class-id"]);
  return (classId !== null && ARUBA_CLASS_ID.test(classId))
    || MEASURED_ARUBA_OUIS.has(mac.slice(0, 8));
}

export interface ArubaLeaseDiscoveryInput {
  leases: Array<Record<string, string>>;
  /** `null` means the ARP read did not complete, NOT that the table is empty. */
  arp: Array<Record<string, string>> | null;
  /** `null` means the bridge host read did not complete. */
  bridgeHosts: Array<Record<string, string>> | null;
  /** Hardware MACs the neighbour path already reports; never reported twice. */
  announcedMacs: ReadonlySet<string>;
}

export function discoverArubaFromLeases(input: ArubaLeaseDiscoveryInput): ArubaObservation[] {
  const bridgeHostsRead = input.bridgeHosts !== null;
  const framesSeen = new Set<string>();
  for (const host of input.bridgeHosts ?? []) {
    const mac = normalizedStableMac(host["mac-address"]);
    if (mac !== null) framesSeen.add(mac);
  }
  const arpReachable = new Set<string>();
  for (const entry of input.arp ?? []) {
    const mac = normalizedStableMac(entry["mac-address"]);
    if (mac !== null && blankToNull(entry.status)?.toLowerCase() === "reachable") {
      arpReachable.add(mac);
    }
  }

  const found = new Map<string, { observation: ArubaObservation; bound: boolean }>();
  for (const lease of input.leases) {
    // `normalizedStableMac` refuses locally administered (randomized) MACs, so
    // a phone can never be keyed as an access point, whatever it calls itself.
    const mac = normalizedStableMac(lease["mac-address"]);
    if (mac === null || input.announcedMacs.has(mac) || !isArubaLease(lease, mac)) continue;

    const bound = blankToNull(lease.status)?.toLowerCase() === "bound";
    const hostname = safeName(lease["host-name"]);
    const comment = safeName(lease.comment);
    const address = blankToNull(lease["active-address"]) ?? blankToNull(lease.address);
    const observation: ArubaObservation = {
      stableIdentity: mac,
      identitySource: "HARDWARE_MAC",
      externalKey: `mac:${mac}`,
      aliases: [...new Set([hostname, comment].filter((name): name is string => name !== null))],
      displayName: hostname ?? comment ?? `Aruba ${mac}`,
      displayOnly: true,
      reachable: framesSeen.has(mac) || arpReachable.has(mac) || (!bridgeHostsRead && bound),
      model: null,
      managementIp: address !== null && IPV4.test(address) ? address : null,
      metadata: { discovery: "routeros-dhcp-lease" },
    };

    // One MAC, one row: the ingest is keyed on the stable key, and a duplicate
    // in one batch is quarantined instead of upserted. A bound lease wins.
    const previous = found.get(mac);
    if (previous === undefined || (!previous.bound && bound)) {
      found.set(mac, { observation, bound });
    }
  }
  return [...found.values()].map((entry) => entry.observation);
}
