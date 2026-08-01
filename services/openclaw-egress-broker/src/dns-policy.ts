import { isIP } from "node:net";

/**
 * DNS policy for the egress broker.
 *
 * The broker resolves a destination, checks every returned address, and then
 * connects to a pinned address. Re-resolving between the check and the connect
 * is what a DNS rebinding attack needs, so the pinned address is the only one
 * the connection is allowed to use.
 */

export type AddressDenial =
  | "NO_ADDRESSES"
  | "LOOPBACK"
  | "PRIVATE"
  | "LINK_LOCAL"
  | "CGNAT"
  | "METADATA"
  | "MULTICAST"
  | "UNSPECIFIED"
  | "DOCUMENTATION"
  | "UNIQUE_LOCAL"
  | "RESERVED"
  | "HOST_GATEWAY"
  | "LATERAL_CONTAINER"
  | "INVALID";

export interface AddressVerdict {
  allowed: boolean;
  denial?: AddressDenial;
}

/**
 * The container application network and the host gateway. Reaching either would
 * let a container talk to a sibling container or back to the host, defeating the
 * point of the broker.
 */
export interface LocalTopology {
  hostGatewayAddresses: readonly string[];
  containerNetworkCidrs: readonly string[];
}

function octets(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const values = parts.map(Number);
  return values.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
    ? values
    : null;
}

function addressBytes(address: string): Uint8Array | null {
  const family = isIP(address);
  if (family === 4) {
    const values = octets(address);
    return values ? Uint8Array.from(values) : null;
  }
  if (family !== 6) return null;

  let input = address.toLowerCase();
  if (input.includes(".")) {
    const separator = input.lastIndexOf(":");
    const embedded = octets(input.slice(separator + 1));
    if (separator < 0 || !embedded) return null;
    input = `${input.slice(0, separator)}:${((embedded[0] ?? 0) << 8 | (embedded[1] ?? 0)).toString(16)}:${((embedded[2] ?? 0) << 8 | (embedded[3] ?? 0)).toString(16)}`;
  }

  const halves = input.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
  ];
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index] ?? "";
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    const value = Number.parseInt(group, 16);
    bytes[index * 2] = value >>> 8;
    bytes[index * 2 + 1] = value & 0xff;
  }
  return bytes;
}

function inCidr(address: string, cidr: string): boolean {
  const separator = cidr.lastIndexOf("/");
  if (separator < 1) return false;
  const network = cidr.slice(0, separator);
  const prefix = Number(cidr.slice(separator + 1));
  const addressFamily = isIP(address);
  if (addressFamily === 0 || addressFamily !== isIP(network)) return false;
  const addressValue = addressBytes(address);
  const networkValue = addressBytes(network);
  const bitLength = addressFamily === 4 ? 32 : 128;
  if (!addressValue || !networkValue || !Number.isInteger(prefix) || prefix < 0 || prefix > bitLength) {
    return false;
  }

  const fullBytes = Math.floor(prefix / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    if (addressValue[index] !== networkValue[index]) return false;
  }
  const remainingBits = prefix % 8;
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return ((addressValue[fullBytes] ?? 0) & mask) === ((networkValue[fullBytes] ?? 0) & mask);
}

function sameAddress(left: string, right: string): boolean {
  if (isIP(left) !== isIP(right)) return false;
  const leftBytes = addressBytes(left);
  const rightBytes = addressBytes(right);
  if (!leftBytes || !rightBytes || leftBytes.length !== rightBytes.length) return false;
  return leftBytes.every((value, index) => value === rightBytes[index]);
}

function evaluateIpv4(address: string): AddressVerdict {
  const values = octets(address);
  if (!values) return { allowed: false, denial: "INVALID" };
  const [a = 0, b = 0, c = 0, d = 0] = values;

  if (a === 0) return { allowed: false, denial: "UNSPECIFIED" };
  if (a === 127) return { allowed: false, denial: "LOOPBACK" };
  if (a === 10) return { allowed: false, denial: "PRIVATE" };
  if (a === 172 && b >= 16 && b <= 31) return { allowed: false, denial: "PRIVATE" };
  if (a === 192 && b === 168) return { allowed: false, denial: "PRIVATE" };
  if (a === 169 && b === 254) {
    return { allowed: false, denial: c === 169 && d === 254 ? "METADATA" : "LINK_LOCAL" };
  }
  if (a === 100 && b >= 64 && b <= 127) return { allowed: false, denial: "CGNAT" };
  if (a >= 224 && a <= 239) return { allowed: false, denial: "MULTICAST" };
  if (a >= 240) return { allowed: false, denial: "RESERVED" };
  if (a === 192 && b === 0 && c === 2) return { allowed: false, denial: "DOCUMENTATION" };
  if (a === 198 && b === 51 && c === 100) return { allowed: false, denial: "DOCUMENTATION" };
  if (a === 203 && b === 0 && c === 113) return { allowed: false, denial: "DOCUMENTATION" };
  if (a === 198 && (b === 18 || b === 19)) return { allowed: false, denial: "RESERVED" };
  if (a === 192 && b === 0 && c === 0) return { allowed: false, denial: "RESERVED" };
  if (a === 192 && b === 88 && c === 99) return { allowed: false, denial: "RESERVED" };
  return { allowed: true };
}

function evaluateIpv6(address: string): AddressVerdict {
  const bytes = addressBytes(address);
  if (!bytes) return { allowed: false, denial: "INVALID" };
  const isAllZero = bytes.every((value) => value === 0);
  if (isAllZero) return { allowed: false, denial: "UNSPECIFIED" };
  if (bytes.slice(0, 15).every((value) => value === 0) && bytes[15] === 1) {
    return { allowed: false, denial: "LOOPBACK" };
  }

  const isMappedIpv4 = bytes.slice(0, 10).every((value) => value === 0) &&
    bytes[10] === 0xff && bytes[11] === 0xff;
  if (isMappedIpv4) {
    return evaluateIpv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  }
  if (bytes.slice(0, 12).every((value) => value === 0)) {
    return { allowed: false, denial: "RESERVED" };
  }
  if (bytes[0] === 0xfe && ((bytes[1] ?? 0) & 0xc0) === 0x80) {
    return { allowed: false, denial: "LINK_LOCAL" };
  }
  if (((bytes[0] ?? 0) & 0xfe) === 0xfc) return { allowed: false, denial: "UNIQUE_LOCAL" };
  if (bytes[0] === 0xff) return { allowed: false, denial: "MULTICAST" };
  if (inCidr(address, "2001:db8::/32") || inCidr(address, "3fff::/20")) {
    return { allowed: false, denial: "DOCUMENTATION" };
  }
  if (
    inCidr(address, "100::/64") ||
    inCidr(address, "64:ff9b::/96") ||
    inCidr(address, "64:ff9b:1::/48") ||
    inCidr(address, "2001::/32") ||
    inCidr(address, "2001:2::/48") ||
    inCidr(address, "2001:10::/28") ||
    inCidr(address, "2001:20::/28") ||
    inCidr(address, "2002::/16")
  ) {
    return { allowed: false, denial: "RESERVED" };
  }
  return { allowed: true };
}

export function evaluateAddress(
  address: string,
  topology: LocalTopology = { hostGatewayAddresses: [], containerNetworkCidrs: [] },
): AddressVerdict {
  const family = isIP(address);
  if (family === 0) return { allowed: false, denial: "INVALID" };

  if (topology.hostGatewayAddresses.some((candidate) => sameAddress(candidate, address))) {
    return { allowed: false, denial: "HOST_GATEWAY" };
  }
  if (topology.containerNetworkCidrs.some((cidr) => inCidr(address, cidr))) {
    return { allowed: false, denial: "LATERAL_CONTAINER" };
  }

  return family === 4 ? evaluateIpv4(address) : evaluateIpv6(address);
}

export interface PinnedResolution {
  host: string;
  pinnedAddress: string;
  allAddresses: readonly string[];
}

/**
 * Resolves and pins. Every returned address must pass, not just the one we
 * intend to use: a resolver that returns one public and one private address is
 * exactly the rebinding pattern this rejects.
 */
export function resolveAndPin(
  host: string,
  addresses: readonly string[],
  topology?: LocalTopology,
): { ok: boolean; denial?: AddressDenial; resolution?: PinnedResolution } {
  if (addresses.length === 0) return { ok: false, denial: "NO_ADDRESSES" };
  for (const address of addresses) {
    const verdict = evaluateAddress(address, topology);
    if (!verdict.allowed) return { ok: false, denial: verdict.denial };
  }
  return {
    ok: true,
    resolution: {
      host,
      pinnedAddress: addresses[0] as string,
      allAddresses: [...addresses],
    },
  };
}

/**
 * A retry or redirect must re-resolve and re-validate; it may never reuse a
 * previous decision for a different host.
 */
export function pinnedAddressIsStillValid(
  resolution: PinnedResolution,
  host: string,
  freshAddresses: readonly string[],
): boolean {
  if (resolution.host !== host || !freshAddresses.some((address) => sameAddress(
    address,
    resolution.pinnedAddress,
  ))) {
    return false;
  }
  return freshAddresses.every((address) => evaluateAddress(address).allowed);
}
