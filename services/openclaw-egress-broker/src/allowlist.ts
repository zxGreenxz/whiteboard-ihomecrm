/**
 * Egress allowlist.
 *
 * The cell, bridge, and maintenance containers have no direct Internet route.
 * Every outbound connection crosses this broker, and the broker only knows the
 * exact FQDN/port pairs written in `allowlist.yaml`. Runtime discovery and
 * wildcards are forbidden by construction: there is no syntax to express them.
 */

export interface AllowlistEntry {
  host: string;
  port: number;
  purpose: string;
}

export type AllowlistDenial =
  | "HOST_NOT_ALLOWED"
  | "PORT_NOT_ALLOWED"
  | "WILDCARD_FORBIDDEN"
  | "IP_LITERAL_FORBIDDEN"
  | "MALFORMED_HOST";

export interface AllowlistVerdict {
  allowed: boolean;
  denial?: AllowlistDenial;
  entry?: AllowlistEntry;
}

const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function isCanonicalFqdn(host: string): boolean {
  if (host.length < 3 || host.length > 253 || !host.includes(".")) return false;
  return host.split(".").every((label) => label.length <= 63 && LABEL.test(label));
}

export function parseAllowlist(entries: readonly unknown[]): AllowlistEntry[] {
  const parsed: AllowlistEntry[] = [];
  const seen = new Set<string>();
  for (const raw of entries) {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("allowlist entry must be an object");
    }
    const entry = raw as Record<string, unknown>;
    const keys = Object.keys(entry).sort();
    if (keys.length !== 3 || keys[0] !== "host" || keys[1] !== "port" || keys[2] !== "purpose") {
      throw new Error("allowlist entry has unknown fields");
    }
    if (typeof entry.host !== "string") throw new Error("allowlist host must be a string");
    if (typeof entry.port !== "number") throw new Error("allowlist port must be a number");
    if (typeof entry.purpose !== "string") throw new Error("allowlist purpose must be a string");
    const host = entry.host.toLowerCase();
    const port = entry.port;
    const purpose = entry.purpose;

    if (host.includes("*")) throw new Error(`wildcard host is forbidden: ${host}`);
    if (!isCanonicalFqdn(host)) throw new Error(`invalid allowlist host: ${host}`);
    if (IPV4_LITERAL.test(host) || host.includes(":")) {
      throw new Error(`IP literal is forbidden in the allowlist: ${host}`);
    }
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`invalid allowlist port: ${entry.port}`);
    }
    if (purpose.trim().length === 0) throw new Error(`allowlist entry needs a purpose: ${host}`);
    const key = `${host}:${port}`;
    if (seen.has(key)) throw new Error(`duplicate allowlist entry: ${key}`);
    seen.add(key);
    parsed.push({ host, port, purpose });
  }
  return parsed;
}

/** Parse the closed, versioned YAML shape used by the reviewed host config. */
export function parseAllowlistDocument(value: unknown): AllowlistEntry[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("allowlist document must be an object");
  }
  const document = value as Record<string, unknown>;
  const keys = Object.keys(document).sort();
  if (keys.length !== 2 || keys[0] !== "destinations" || keys[1] !== "version") {
    throw new Error("allowlist document has unknown fields");
  }
  if (document.version !== 1) throw new Error("unsupported allowlist version");
  if (!Array.isArray(document.destinations)) {
    throw new Error("allowlist destinations must be an array");
  }
  return parseAllowlist(document.destinations);
}

export function evaluateDestination(
  host: string,
  port: number,
  allowlist: readonly AllowlistEntry[],
): AllowlistVerdict {
  const normalized = host.trim().toLowerCase();
  if (normalized.length === 0) return { allowed: false, denial: "MALFORMED_HOST" };
  if (normalized.includes("*")) return { allowed: false, denial: "WILDCARD_FORBIDDEN" };
  // An IP literal bypasses DNS policy entirely, so it is never acceptable.
  if (IPV4_LITERAL.test(normalized) || normalized.includes(":") || normalized.startsWith("[")) {
    return { allowed: false, denial: "IP_LITERAL_FORBIDDEN" };
  }
  if (!isCanonicalFqdn(normalized)) return { allowed: false, denial: "MALFORMED_HOST" };

  // Exact match only. A subdomain of an allowlisted host is not implied.
  const hostMatches = allowlist.filter((entry) => entry.host === normalized);
  if (hostMatches.length === 0) return { allowed: false, denial: "HOST_NOT_ALLOWED" };

  const entry = hostMatches.find((candidate) => candidate.port === port);
  if (!entry) return { allowed: false, denial: "PORT_NOT_ALLOWED" };
  return { allowed: true, entry };
}
