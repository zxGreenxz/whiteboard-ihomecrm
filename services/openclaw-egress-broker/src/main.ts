import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { posix } from "node:path";
import { pathToFileURL } from "node:url";

import { parseDocument } from "yaml";

import {
  parseAllowlistDocument,
  type AllowlistEntry,
} from "./allowlist.js";
import {
  createConnectProxy,
  type BrokerLogEvent,
} from "./connect-proxy.js";
import type { LocalTopology } from "./dns-policy.js";

export interface BrokerRuntimeConfiguration {
  host: string;
  port: number;
  allowlistPath: string;
  topology: LocalTopology;
}

type Environment = Readonly<Record<string, string | undefined>>;

export function parseBrokerEnvironment(environment: Environment): BrokerRuntimeConfiguration {
  const host = environment.OPENCLAW_EGRESS_HOST ?? "0.0.0.0";
  if (isIP(host) === 0) throw new Error("OPENCLAW_EGRESS_HOST must be an IP address");

  const portText = environment.OPENCLAW_EGRESS_PORT ?? "3128";
  if (!/^[1-9]\d{0,4}$/.test(portText)) {
    throw new Error("OPENCLAW_EGRESS_PORT must be an integer");
  }
  const port = Number(portText);
  if (port > 65_535) throw new Error("OPENCLAW_EGRESS_PORT is out of range");

  const allowlistPath = environment.OPENCLAW_EGRESS_ALLOWLIST_PATH ??
    "/etc/openclaw-egress/allowlist.yaml";
  if (!posix.isAbsolute(allowlistPath) || allowlistPath.includes("\\") || allowlistPath.includes("\0")) {
    throw new Error("OPENCLAW_EGRESS_ALLOWLIST_PATH must be an absolute Linux path");
  }

  const hostGatewayAddresses = parseList(
    environment.OPENCLAW_EGRESS_HOST_GATEWAY_ADDRESSES,
    "OPENCLAW_EGRESS_HOST_GATEWAY_ADDRESSES",
  );
  for (const address of hostGatewayAddresses) {
    if (isIP(address) === 0) throw new Error("host gateway address must be an IP literal");
  }
  const containerNetworkCidrs = parseList(
    environment.OPENCLAW_EGRESS_CONTAINER_NETWORK_CIDRS,
    "OPENCLAW_EGRESS_CONTAINER_NETWORK_CIDRS",
  );
  for (const cidr of containerNetworkCidrs) {
    if (!isValidCidr(cidr)) throw new Error("container network CIDR is invalid");
  }

  return {
    host,
    port,
    allowlistPath,
    topology: { hostGatewayAddresses, containerNetworkCidrs },
  };
}

export async function loadAllowlistFile(path: string): Promise<AllowlistEntry[]> {
  const text = await readFile(path, "utf8");
  if (text.length === 0 || text.length > 64 * 1024 || text.includes("\0")) {
    throw new Error("allowlist file has an invalid size or encoding");
  }
  const document = parseDocument(text, {
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) throw new Error("allowlist YAML is invalid");
  const allowlist = parseAllowlistDocument(document.toJS({ maxAliasCount: 0 }));
  if (allowlist.length === 0) throw new Error("allowlist must contain at least one destination");
  return allowlist;
}

export async function startBroker(environment: Environment = process.env): Promise<void> {
  const configuration = parseBrokerEnvironment(environment);
  const allowlist = await loadAllowlistFile(configuration.allowlistPath);
  const server = createConnectProxy({
    allowlist,
    topology: configuration.topology,
    log: writeLog,
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(configuration.port, configuration.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  writeLog({ level: "info", event: "broker_listening", port: configuration.port });

  const shutdown = () => {
    server.close((error) => {
      if (error) process.exitCode = 1;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function parseList(value: string | undefined, name: string): string[] {
  if (value === undefined || value === "") return [];
  const values = value.split(",").map((entry) => entry.trim());
  if (values.some((entry) => entry.length === 0)) throw new Error(`${name} contains an empty item`);
  return values;
}

function isValidCidr(cidr: string): boolean {
  const separator = cidr.lastIndexOf("/");
  if (separator < 1) return false;
  const address = cidr.slice(0, separator);
  const family = isIP(address);
  const prefixText = cidr.slice(separator + 1);
  if (family === 0 || !/^(?:0|[1-9]\d{0,2})$/.test(prefixText)) return false;
  const prefix = Number(prefixText);
  return prefix <= (family === 4 ? 32 : 128);
}

function writeLog(event: BrokerLogEvent): void {
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`);
}

const invokedPath = process.argv[1];
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  startBroker().catch(() => {
    writeLog({ level: "error", event: "broker_start_failed", reason: "STARTUP_ERROR" });
    process.exitCode = 1;
  });
}
