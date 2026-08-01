import { BlockList, isIP } from "node:net";

/**
 * Connect-time IP policy for inbound media fetches.
 *
 * Everything the cell fetches must leave through the egress broker, and no fetch
 * may ever reach loopback, private space, link-local, metadata, multicast, or
 * the 9Router/CLI host. DNS is re-resolved and the resolved address is pinned,
 * so a DNS rebind between check and connect cannot slip through.
 */

export type IpDenialReason =
  | "INVALID_ADDRESS"
  | "LOOPBACK"
  | "PRIVATE"
  | "LINK_LOCAL"
  | "METADATA"
  | "MULTICAST"
  | "UNIQUE_LOCAL"
  | "UNSPECIFIED"
  | "RESERVED"
  | "FORBIDDEN_HOST";

export interface IpVerdict {
  allowed: boolean;
  reason?: IpDenialReason;
}

/** Addresses that belong to the 9Router / cli-proxy-api host and must never be reached. */
const IPV6_LINK_LOCAL = new BlockList();
IPV6_LINK_LOCAL.addSubnet("fe80::", 10, "ipv6");
const IPV6_UNIQUE_LOCAL = new BlockList();
IPV6_UNIQUE_LOCAL.addSubnet("fc00::", 7, "ipv6");
const IPV6_MULTICAST = new BlockList();
IPV6_MULTICAST.addSubnet("ff00::", 8, "ipv6");
const IPV6_RESERVED = new BlockList();
for (const [network, prefix] of [
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2002::", 16],
  ["3fff::", 20],
] as const) IPV6_RESERVED.addSubnet(network, prefix, "ipv6");

function ipv4Octets(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  return octets.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
    ? octets
    : null;
}

function evaluateIpv4(address: string): IpVerdict {
  const octets = ipv4Octets(address);
  if (!octets) return { allowed: false, reason: "INVALID_ADDRESS" };
  const [a = 0, b = 0, c = 0, d = 0] = octets;

  if (a === 0) return { allowed: false, reason: "UNSPECIFIED" };
  if (a === 127) return { allowed: false, reason: "LOOPBACK" };
  if (a === 10) return { allowed: false, reason: "PRIVATE" };
  if (a === 172 && b >= 16 && b <= 31) return { allowed: false, reason: "PRIVATE" };
  if (a === 192 && b === 168) return { allowed: false, reason: "PRIVATE" };
  if (a === 169 && b === 254) {
    // 169.254.169.254 is the cloud metadata endpoint.
    return { allowed: false, reason: c === 169 && d === 254 ? "METADATA" : "LINK_LOCAL" };
  }
  if (a === 100 && b >= 64 && b <= 127) return { allowed: false, reason: "RESERVED" };
  if (a >= 224 && a <= 239) return { allowed: false, reason: "MULTICAST" };
  if (a >= 240) return { allowed: false, reason: "RESERVED" };
  if (a === 192 && b === 0 && c === 0) return { allowed: false, reason: "RESERVED" };
  // Documentation ranges TEST-NET-1/2/3 are never legitimate media hosts.
  if (a === 192 && b === 0 && c === 2) return { allowed: false, reason: "RESERVED" };
  if (a === 198 && b === 51 && c === 100) return { allowed: false, reason: "RESERVED" };
  if (a === 203 && b === 0 && c === 113) return { allowed: false, reason: "RESERVED" };
  if (a === 198 && (b === 18 || b === 19)) return { allowed: false, reason: "RESERVED" };
  return { allowed: true };
}

function evaluateIpv6(address: string): IpVerdict {
  const normalized = address.toLowerCase();
  if (normalized === "::" ) return { allowed: false, reason: "UNSPECIFIED" };
  if (normalized === "::1") return { allowed: false, reason: "LOOPBACK" };
  if (normalized.startsWith("::ffff:")) {
    // IPv4-mapped addresses must be judged by the IPv4 rules.
    const embedded = normalized.slice("::ffff:".length);
    if (embedded.includes(".")) return evaluateIpv4(embedded);
  }
  if (IPV6_LINK_LOCAL.check(address, "ipv6")) return { allowed: false, reason: "LINK_LOCAL" };
  if (IPV6_UNIQUE_LOCAL.check(address, "ipv6")) return { allowed: false, reason: "UNIQUE_LOCAL" };
  if (IPV6_MULTICAST.check(address, "ipv6")) return { allowed: false, reason: "MULTICAST" };
  if (IPV6_RESERVED.check(address, "ipv6")) return { allowed: false, reason: "RESERVED" };
  return { allowed: true };
}

export function evaluateResolvedAddress(
  address: string,
  forbiddenHostAddresses: readonly string[] = [],
): IpVerdict {
  if (forbiddenHostAddresses.includes(address)) {
    return { allowed: false, reason: "FORBIDDEN_HOST" };
  }
  const family = isIP(address);
  if (family === 4) return evaluateIpv4(address);
  if (family === 6) return evaluateIpv6(address);
  return { allowed: false, reason: "INVALID_ADDRESS" };
}

export function allResolvedAddressesAllowed(
  addresses: readonly string[],
  forbiddenHostAddresses: readonly string[] = [],
): IpVerdict {
  if (addresses.length === 0) return { allowed: false, reason: "INVALID_ADDRESS" };
  for (const address of addresses) {
    const verdict = evaluateResolvedAddress(address, forbiddenHostAddresses);
    if (!verdict.allowed) return verdict;
  }
  return { allowed: true };
}
