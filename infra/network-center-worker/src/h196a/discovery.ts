import { createHash } from "node:crypto";

import type { H196aObservation, H196aQuarantineObservation, H196aHealthStatus } from "../domain.js";

/**
 * Downstream discovery for routers that publish no LLDP.
 *
 * This is the H196A counterpart of `parseArubaNeighbors` in
 * `../routeros/sshConnector.ts`, and it deliberately keeps that function's
 * shape — filter, derive a stable key, collapse to one row per key, quarantine
 * anything whose identity cannot be trusted. What differs is the evidence,
 * because the two device families give the router completely different things.
 *
 * An Aruba IAP announces itself: at 102LVT the neighbour table carries
 * `platform="ArubaOS"`, `MODEL: 315`, and the name the operator typed into the
 * AP. The five ZTE H196A units at 950NK announce nothing at all — the neighbour
 * table there stayed empty through seven minutes with the physical ports added
 * to the discovery list. So there is no serial, no model and no firmware to be
 * had from any MikroTik read, and this module must never pretend otherwise:
 * identity is the MAC, and that is the whole of it.
 *
 * The compensation is that liveness here is BETTER than Aruba's. `ArubaObservation`
 * hard-codes `reachable: true`, which only ever meant "present in this scan".
 * A lease, by contrast, survives the device that owns it, so lease presence
 * alone would report a dead access point as healthy for up to a day. The bridge
 * host table is what actually answers the question, and it answered it while
 * this was being written: `3C:A7:AE:9F:24:54` ("Berlin") held a valid lease and
 * was absent from the host table.
 */

/** Only leases already fingerprinted as H196A are considered. */
const MULTIAP_CLASS_ID = /^MULTIAP_/i;
/** ZTE default hostname: the literal `atadevice` followed by its own MAC. */
const ATADEVICE_HOSTNAME = /^atadevice[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i;

/**
 * `network_devices_name_check` accepts 1..160 characters after trimming, and
 * the same ceiling `safeArubaAlias` applies. A comment longer than this is an
 * operator typo, not a name, so it is dropped rather than truncated into
 * something they never wrote.
 */
const MAX_DISPLAY_NAME = 160;

/** Absent, blank or whitespace-only all mean "the router reported nothing". */
function blankToNull(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * A MAC that is not globally administered unicast cannot identify hardware:
 * randomized phone MACs change per network and would enrol a new "device" every
 * time. The second nibble must be one of `[048c]`, which is exactly the rule
 * `network_devices_aruba_stable_identity_check` already enforces in the
 * database — kept identical here so the worker never sends a row the schema
 * will reject. All five field MACs pass (`3c` -> `c`, `50` -> `0`).
 */
const GLOBAL_UNICAST_MAC = /^[0-9a-f][048c](:[0-9a-f]{2}){5}$/;

export function normalizedStableMac(value: string | undefined): string | null {
  const lowered = blankToNull(value)?.toLowerCase() ?? null;
  if (lowered === null) return null;
  if (!GLOBAL_UNICAST_MAC.test(lowered)) return null;
  if (lowered === "00:00:00:00:00:00" || lowered === "ff:ff:ff:ff:ff:ff") return null;
  return lowered;
}

function isH196aLease(record: Record<string, string>): boolean {
  const classId = blankToNull(record["class-id"]);
  const hostname = blankToNull(record["host-name"]);
  return (classId !== null && MULTIAP_CLASS_ID.test(classId))
    || (hostname !== null && ATADEVICE_HOSTNAME.test(hostname));
}

/**
 * The operator's name for the unit, read from the static lease comment.
 *
 * Aruba gets this free from LLDP `identity`; H196A has no such field, so the
 * lease comment on the router is the naming surface. It is read ONLY from a
 * record that already matched the H196A fingerprint — the same containment
 * `safeArubaAlias` has by only running on records that passed `isAruba` — so a
 * comment somebody leaves on a guest lease cannot rename or create a device.
 */
export function safeH196aName(value: string | undefined): string | null {
  const trimmed = blankToNull(value);
  if (trimmed === null) return null;
  if (trimmed.length > MAX_DISPLAY_NAME) return null;
  // Control characters would travel all the way to the browser as a device
  // name. The range is C0 plus DEL ONLY: a space is legal and load-bearing
  // here, because the names the operator actually gave are "Nha xe" and
  // "Berlin". An earlier draft of this line wrote the class as [ -] and
  // would have rejected every name containing a space.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

export interface H196aDiscoveryInput {
  observedAt: string;
  leases: Array<Record<string, string>>;
  /** `null` means the ARP read did not complete — NOT that the table is empty. */
  arp: Array<Record<string, string>> | null;
  /** `null` means the bridge host read did not complete. This forces UNKNOWN. */
  bridgeHosts: Array<Record<string, string>> | null;
  bridgeAgeingSeconds: number | null;
}

export interface H196aDiscoveryResult {
  valid: H196aObservation[];
  quarantined: H196aQuarantineObservation[];
}

/**
 * Health, and the reasoning behind each verdict.
 *
 * ONLINE requires the bridge host table, because that is the only source here
 * that proves a frame arrived. STALE is deliberately NOT offline: a lease with
 * no recent frame is a device that has gone quiet, and one poll of quiet is not
 * death — the database applies the three-poll hysteresis before anything is
 * called OFFLINE, exactly as the 12/08 plan separates worker observation from
 * incident authority.
 *
 * ARP is a supporting signal only, never a deciding one. RouterOS marks an idle
 * neighbour `stale` as a matter of course, and three of the five field units
 * were `stale` while plainly alive. Reading `stale` as "down" would have
 * reported a healthy building as three-fifths dead.
 */
function assessHealth(input: {
  inBridgeHostTable: boolean;
  bridgeHostsRead: boolean;
  arpStatus: string | null;
  leaseBound: boolean;
}): { healthStatus: H196aHealthStatus; healthReason: string } {
  if (!input.bridgeHostsRead) {
    return {
      healthStatus: "UNKNOWN",
      healthReason: "BRIDGE_HOST_TABLE_UNREADABLE",
    };
  }
  if (input.inBridgeHostTable) {
    return { healthStatus: "ONLINE", healthReason: "FRAME_SEEN_WITHIN_AGEING_INTERVAL" };
  }
  // A `reachable` ARP entry is independent proof of recent traffic, and it is
  // promoted to a deciding signal on the strength of measurement rather than
  // theory. Sampling the 950NK bridge host table six times over four minutes
  // showed the two tables AGREE: the units present in the host table were
  // `reachable` or freshly `stale`, and the two units absent from it were
  // `stale` in ARP as well. Requiring the host table alone would call a unit
  // quiet during the window between its MAC ageing out and its next frame,
  // which is a gap the ARP entry covers.
  if (input.arpStatus === "reachable") {
    return { healthStatus: "ONLINE", healthReason: "ARP_REACHABLE" };
  }
  if (input.arpStatus === "failed") {
    return { healthStatus: "STALE", healthReason: "NO_FRAME_AND_ARP_FAILED" };
  }
  if (!input.leaseBound) {
    return { healthStatus: "STALE", healthReason: "NO_FRAME_AND_LEASE_NOT_BOUND" };
  }
  return { healthStatus: "STALE", healthReason: "LEASE_BOUND_BUT_NO_FRAME" };
}

export function discoverH196aCandidates(input: H196aDiscoveryInput): H196aDiscoveryResult {
  const bridgeHostsRead = input.bridgeHosts !== null;

  // Index the supporting evidence by MAC once, so the per-lease pass stays O(n).
  const portByMac = new Map<string, string>();
  for (const host of input.bridgeHosts ?? []) {
    const mac = normalizedStableMac(host["mac-address"]);
    if (mac === null) continue;
    const port = blankToNull(host["on-interface"]) ?? blankToNull(host.interface);
    if (port !== null) portByMac.set(mac, port);
    else if (!portByMac.has(mac)) portByMac.set(mac, "");
  }
  const arpByMac = new Map<string, { status: string | null; address: string | null }>();
  for (const entry of input.arp ?? []) {
    const mac = normalizedStableMac(entry["mac-address"]);
    if (mac === null) continue;
    // A MAC can hold several ARP rows (a stale address plus a live one). The
    // reachable row is the one worth keeping; otherwise first wins.
    const status = blankToNull(entry.status)?.toLowerCase() ?? null;
    const seen = arpByMac.get(mac);
    if (seen === undefined || (seen.status !== "reachable" && status === "reachable")) {
      arpByMac.set(mac, { status, address: blankToNull(entry.address) });
    }
  }

  const valid = new Map<string, H196aObservation>();
  const quarantined: H196aQuarantineObservation[] = [];

  for (const lease of input.leases) {
    if (!isH196aLease(lease)) continue;

    const mac = normalizedStableMac(lease["mac-address"]);
    if (mac === null) {
      // Looks like an H196A but carries no identity a device row can be keyed
      // on. Recorded as a fingerprint for operator review rather than enrolled:
      // a randomized or malformed MAC would create a new device every poll.
      quarantined.push({
        code: "H196A_STABLE_IDENTITY_INVALID",
        fingerprint: createHash("sha256").update(JSON.stringify([
          lease["mac-address"] ?? "",
          lease["host-name"] ?? "",
          lease["class-id"] ?? "",
        ])).digest("hex"),
      });
      continue;
    }

    const stableKey = `mac:${mac}`;
    const arp = arpByMac.get(mac) ?? null;
    const bridgePort = portByMac.get(mac) ?? null;
    const health = assessHealth({
      inBridgeHostTable: bridgePort !== null,
      bridgeHostsRead,
      arpStatus: arp?.status ?? null,
      leaseBound: (blankToNull(lease.status)?.toLowerCase() ?? null) === "bound",
    });

    const evidenceSources: H196aObservation["evidenceSources"] = ["MIKROTIK_DHCP_LEASE"];
    if (bridgePort !== null) evidenceSources.push("MIKROTIK_BRIDGE_HOST");
    if (arp !== null) evidenceSources.push("MIKROTIK_ARP");

    const observation: H196aObservation = {
      stableIdentity: mac,
      identitySource: "HARDWARE_MAC",
      externalKey: stableKey,
      stableKey,
      // Re-read from the lease comment on EVERY poll, never written once at
      // enrolment: three of the five units are still waiting for their real
      // name, and renaming must not require a migration or a deploy.
      displayName: safeH196aName(lease.comment) ?? `H196A ${mac.slice(9)}`,
      displayOnly: true,
      macAddress: mac,
      observedIp: blankToNull(lease.address) ?? arp?.address ?? null,
      hostname: blankToNull(lease["host-name"]),
      bridgePort: bridgePort !== null && bridgePort !== "" ? bridgePort : null,
      arpStatus: arp?.status ?? null,
      bridgeAgeingSeconds: input.bridgeAgeingSeconds,
      healthStatus: health.healthStatus,
      healthReason: health.healthReason,
      evidenceSources,
      observedAt: input.observedAt,
    };

    // One MAC, one row — the same invariant `collapseDuplicateLeaseClients`
    // enforces for clients, and for the same reason: the ingest upsert is keyed
    // on the stable key, and reaching one row twice in a single ON CONFLICT DO
    // UPDATE is a 21000 that discards the whole batch for every building the
    // worker polls. A duplicate here is not a cosmetic flaw; it is an outage.
    // Measured 26-27/08/2026: one duplicated MAC, 240 failed polls, 20 hours
    // blind. Between two rows for one MAC, a bound lease wins over an unbound
    // one so a half-finished handshake cannot erase the live address.
    const previous = valid.get(stableKey);
    if (previous === undefined || (previous.healthStatus !== "ONLINE" && health.healthStatus === "ONLINE")) {
      valid.set(stableKey, observation);
    }
  }

  return { valid: [...valid.values()], quarantined };
}

/**
 * `ageing-time` off `/interface/bridge/print`, in seconds.
 *
 * Returns null when no bridge reports one, so the caller records "not observed"
 * instead of assuming the 5m default that happens to be true at 950NK today.
 */
export function bridgeAgeingSeconds(
  bridges: Array<Record<string, string>> | null,
  parseDuration: (value: string | undefined) => number | null,
): number | null {
  if (bridges === null) return null;
  const values = bridges
    .map((bridge) => parseDuration(bridge["ageing-time"]))
    .filter((seconds): seconds is number => seconds !== null && seconds > 0);
  if (values.length === 0) return null;
  // The shortest ageing interval bounds how quickly absence becomes visible on
  // any bridge, so it is the honest sensitivity to report.
  return Math.min(...values);
}
