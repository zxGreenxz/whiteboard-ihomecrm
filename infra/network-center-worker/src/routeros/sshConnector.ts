import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { Client, type ClientChannel, type SFTPWrapper } from "ssh2";

import {
  RouterOperationError,
  type ArubaObservation,
  type JsonObject,
  type NetworkConnection,
  type RouterClientObservation,
  type RouterCredential,
  type RouterInterfaceObservation,
  type RouterObservation,
} from "../domain.js";
import type { RouterBackup, RouterConnector, RouterHealth } from "./connector.js";

export const ROUTER_OS_COMMANDS = Object.freeze({
  flushDnsCache: "/ip/dns/cache/flush",
  renewDhcpLease: "/ip/dhcp-client/renew [find where status=\"bound\"]",
  reboot: "/system/reboot",
});

const READ_COMMANDS = Object.freeze({
  identity: "/system/identity/print as-value without-paging",
  resource: "/system/resource/print as-value without-paging",
  interfaces: "/interface/print detail as-value without-paging",
  dhcpClients: "/ip/dhcp-client/print detail as-value without-paging",
  leases: "/ip/dhcp-server/lease/print detail as-value without-paging",
  neighbors: "/ip/neighbor/print detail as-value without-paging",
  dns: "/ip/dns/print as-value without-paging",
});

const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;

export function normalizeHostFingerprint(value: string): string {
  const match = /^SHA256:([A-Za-z0-9+/]{20,}={0,2})$/.exec(value.trim());
  if (!match?.[1]) throw new TypeError("A pinned SHA256 host-key fingerprint is required");
  return match[1].replace(/=+$/, "");
}

export function quoteRouterOsValue(value: string): string {
  const containsControlCharacter = [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (value.length < 1 || value.length > 512 || containsControlCharacter) {
    throw new TypeError("RouterOS value contains unsafe characters");
  }
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")
    .replace(/;/g, "\\;")
    .replace(/\$/g, "\\$")}"`;
}

function splitEscaped(value: string, delimiter: string): string[] {
  const output: string[] = [];
  let current = "";
  let escaped = false;
  let quoted = false;
  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "\"") {
      quoted = !quoted;
      continue;
    }
    if (character === delimiter && !quoted) {
      output.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (escaped) current += "\\";
  output.push(current);
  return output;
}

export function parseRouterOsRecords(output: string): Array<Record<string, string>> {
  const records: Array<Record<string, string>> = [];
  for (const line of output.replace(/\r/g, "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("Flags:")) continue;
    const record: Record<string, string> = {};
    for (const field of splitEscaped(trimmed, ";")) {
      const separator = field.indexOf("=");
      if (separator <= 0) continue;
      record[field.slice(0, separator).trim()] = field.slice(separator + 1).trim();
    }
    if (Object.keys(record).length > 0) records.push(record);
  }
  return records;
}

interface SshConnectorOptions {
  connection: NetworkConnection;
  credential: RouterCredential;
  commandTimeoutMs: number;
  now?: () => Date;
  clientFactory?: () => Client;
}

function integer(value: string | undefined): number | null {
  if (!value || !/^-?\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function boolean(value: string | undefined): boolean {
  return value === "true" || value === "yes";
}

function parseBytes(value: string | undefined): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value);
  const match = /^(\d+(?:\.\d+)?)\s*(KiB|MiB|GiB|TiB)$/i.exec(value);
  if (!match?.[1] || !match[2]) return null;
  const powers: Record<string, number> = { kib: 1, mib: 2, gib: 3, tib: 4 };
  return Math.round(Number(match[1]) * 1024 ** (powers[match[2].toLowerCase()] ?? 0));
}

function parseDurationSeconds(value: string | undefined): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value);
  const weeks = Number(/(\d+)w/.exec(value)?.[1] ?? 0);
  const days = Number(/(\d+)d/.exec(value)?.[1] ?? 0);
  const hours = Number(/(\d+)h/.exec(value)?.[1] ?? 0);
  const minutes = Number(/(\d+)m/.exec(value)?.[1] ?? 0);
  const seconds = Number(/(\d+)s/.exec(value)?.[1] ?? 0);
  return (((weeks * 7 + days) * 24 + hours) * 60 + minutes) * 60 + seconds;
}

export function leaseExpiryIso(
  observedAt: string,
  expiresAfter: string | undefined,
  fallbackSeconds: number,
): string {
  const parsed = parseDurationSeconds(expiresAfter);
  const seconds = parsed && parsed > 0 ? parsed : fallbackSeconds;
  const boundedSeconds = Math.max(30, Math.min(seconds, 31 * 24 * 60 * 60));
  return new Date(new Date(observedAt).getTime() + boundedSeconds * 1_000).toISOString();
}

function interfaceRole(name: string, type: string): RouterInterfaceObservation["role"] {
  const normalized = name.toLowerCase();
  if (normalized === "ether1" || normalized.startsWith("wan") || normalized.startsWith("pppoe")) return "WAN";
  if (type === "wireguard" || normalized.startsWith("wg")) return "MANAGEMENT";
  if (type === "bridge") return "LAN";
  if (normalized.startsWith("sfp")) return "UPLINK";
  return "ACCESS";
}

function interfaceKind(type: string): string {
  const normalized = type.toLowerCase();
  if (normalized.includes("wireguard")) return "WIREGUARD";
  if (normalized.includes("bridge")) return "BRIDGE";
  if (normalized.includes("vlan")) return "VLAN";
  if (normalized.includes("wlan") || normalized.includes("wifi")) return "WIRELESS";
  if (normalized.includes("ether")) return "ETHERNET";
  return "OTHER";
}

function isAruba(record: Record<string, string>): boolean {
  return /\b(aruba|instant|hpe)\b/i.test([
    record.identity,
    record.platform,
    record.board,
    record["system-description"],
  ].filter(Boolean).join(" "));
}

export class SshRouterConnector implements RouterConnector {
  readonly #connection: NetworkConnection;
  readonly #credential: RouterCredential;
  readonly #commandTimeoutMs: number;
  readonly #now: () => Date;
  readonly #clientFactory: () => Client;
  #client: Client | null = null;
  #connecting: Promise<Client> | null = null;

  constructor(options: SshConnectorOptions) {
    if (options.connection.transport !== "ROUTEROS_SSH") {
      throw new TypeError("Only ROUTEROS_SSH connections are supported");
    }
    if (!options.connection.hostKeyFingerprint) {
      throw new TypeError("Pinned SSH host-key fingerprint is required");
    }
    this.#connection = options.connection;
    this.#credential = options.credential;
    this.#commandTimeoutMs = options.commandTimeoutMs;
    this.#now = options.now ?? (() => new Date());
    this.#clientFactory = options.clientFactory ?? (() => new Client());
  }

  async #connect(): Promise<Client> {
    if (this.#client) return this.#client;
    if (this.#connecting) return this.#connecting;
    const pinned = normalizeHostFingerprint(this.#connection.hostKeyFingerprint ?? "");
    this.#connecting = new Promise<Client>((resolve, reject) => {
      const client = this.#clientFactory();
      const timeout = setTimeout(() => {
        client.destroy();
        reject(new RouterOperationError("SSH_CONNECT_TIMEOUT", {
          retryable: true,
          mayHaveExecuted: false,
        }));
      }, this.#connection.connectTimeoutMs);
      const fail = () => {
        clearTimeout(timeout);
        client.destroy();
        reject(new RouterOperationError("SSH_CONNECT_FAILED", {
          retryable: true,
          mayHaveExecuted: false,
        }));
      };
      client.once("error", fail);
      client.once("ready", () => {
        clearTimeout(timeout);
        client.removeListener("error", fail);
        client.on("error", () => {
          if (this.#client === client) this.#client = null;
        });
        client.on("close", () => {
          if (this.#client === client) this.#client = null;
        });
        this.#client = client;
        resolve(client);
      });
      client.connect({
        host: this.#connection.managementIp,
        port: this.#connection.managementPort,
        username: this.#credential.username,
        privateKey: this.#credential.privateKey,
        ...(this.#credential.privateKeyPassphrase
          ? { passphrase: this.#credential.privateKeyPassphrase }
          : {}),
        readyTimeout: this.#connection.connectTimeoutMs,
        keepaliveInterval: 10_000,
        keepaliveCountMax: 3,
        hostVerifier: (key: Buffer) => {
          const actual = createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
          const left = Buffer.from(actual);
          const right = Buffer.from(pinned);
          return left.length === right.length && timingSafeEqual(left, right);
        },
      });
    }).finally(() => {
      this.#connecting = null;
    });
    return this.#connecting;
  }

  async #execute(command: string, mayHaveExecuted = false): Promise<string> {
    const client = await this.#connect();
    return new Promise<string>((resolve, reject) => {
      client.exec(command, (error: Error | undefined, channel: ClientChannel) => {
        if (error) {
          reject(new RouterOperationError("SSH_EXEC_START_FAILED", {
            retryable: true,
            mayHaveExecuted,
          }));
          return;
        }
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let bytes = 0;
        let settled = false;
        const finish = (callback: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          callback();
        };
        const collect = (target: Buffer[]) => (data: Buffer | string) => {
          const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
          bytes += buffer.byteLength;
          if (bytes > MAX_COMMAND_OUTPUT_BYTES) {
            channel.close();
            finish(() => reject(new RouterOperationError("SSH_OUTPUT_LIMIT", {
              retryable: false,
              mayHaveExecuted,
            })));
            return;
          }
          target.push(buffer);
        };
        const timer = setTimeout(() => {
          channel.close();
          finish(() => reject(new RouterOperationError("SSH_COMMAND_TIMEOUT", {
            retryable: true,
            mayHaveExecuted,
          })));
        }, this.#commandTimeoutMs);
        channel.on("data", collect(stdout));
        channel.stderr.on("data", collect(stderr));
        channel.once("close", (code: number | null) => finish(() => {
          if (code && code !== 0) {
            reject(new RouterOperationError("ROUTEROS_COMMAND_FAILED", {
              retryable: false,
              mayHaveExecuted,
            }));
            return;
          }
          if (stderr.length > 0 && Buffer.concat(stderr).toString("utf8").trim()) {
            reject(new RouterOperationError("ROUTEROS_COMMAND_REJECTED", {
              retryable: false,
              mayHaveExecuted,
            }));
            return;
          }
          resolve(Buffer.concat(stdout).toString("utf8"));
        }));
      });
    });
  }

  async #sftp(): Promise<SFTPWrapper> {
    const client = await this.#connect();
    return new Promise((resolve, reject) => {
      client.sftp((error, sftp) => {
        if (error) {
          reject(new RouterOperationError("SFTP_UNAVAILABLE", {
            retryable: true,
            mayHaveExecuted: false,
          }));
          return;
        }
        resolve(sftp);
      });
    });
  }

  async #readRemoteFile(path: string): Promise<Buffer> {
    const sftp = await this.#sftp();
    return new Promise((resolve, reject) => {
      sftp.readFile(path, (error, data) => {
        sftp.end();
        if (error) {
          reject(new RouterOperationError("SFTP_READ_FAILED", {
            retryable: true,
            mayHaveExecuted: false,
          }));
          return;
        }
        resolve(data);
      });
    });
  }

  async poll(): Promise<RouterObservation> {
    const [identityOutput, resourceOutput, interfaceOutput, dhcpOutput, leaseOutput, neighborOutput] =
      await Promise.all([
        this.#execute(READ_COMMANDS.identity),
        this.#execute(READ_COMMANDS.resource),
        this.#execute(READ_COMMANDS.interfaces),
        this.#execute(READ_COMMANDS.dhcpClients),
        this.#execute(READ_COMMANDS.leases),
        this.#execute(READ_COMMANDS.neighbors),
      ]);
    const identity = parseRouterOsRecords(identityOutput)[0] ?? {};
    const resource = parseRouterOsRecords(resourceOutput)[0] ?? {};
    const interfaceRecords = parseRouterOsRecords(interfaceOutput);
    const dhcpClients = parseRouterOsRecords(dhcpOutput);
    const now = this.#now().toISOString();

    const interfaces: RouterInterfaceObservation[] = interfaceRecords.map((record, index) => {
      const name = record.name ?? `interface-${index}`;
      const type = record.type ?? "unknown";
      const role = interfaceRole(name, type);
      const speed = parseBytes(record.rate ?? record["link-downs"]);
      const metadata: JsonObject = { interfaceKind: interfaceKind(type), sortOrder: index };
      if (record["mac-address"]) metadata.macAddress = record["mac-address"];
      if (speed) metadata.nominalSpeedBps = speed;
      return {
        externalKey: name,
        displayName: name,
        role,
        protected: role === "WAN" || role === "MANAGEMENT" || role === "UPLINK",
        enabled: record.disabled !== "true",
        sample: {
          linkState: boolean(record.running) ? "UP" : "DOWN",
          rxBytes: integer(record["rx-byte"]) ?? 0,
          txBytes: integer(record["tx-byte"]) ?? 0,
          errorCount: (integer(record["rx-error"]) ?? 0) + (integer(record["tx-error"]) ?? 0),
          ...metadata,
        },
      };
    });

    const clients: RouterClientObservation[] = parseRouterOsRecords(leaseOutput).map((record, index) => {
      const mac = record["mac-address"]?.toLowerCase() ?? null;
      const address = record.address ?? null;
      const key = mac ?? address ?? `lease-${index}`;
      return {
        externalKey: key,
        deviceId: this.#connection.deviceId,
        sessionKey: `dhcp:${key}`,
        clientFingerprint: createHash("sha256").update(key).digest("hex"),
        observedMac: mac,
        observedIp: address,
        hostname: record["host-name"] ?? null,
        connectionType: "DHCP",
        sessionType: "LEASE",
        firstSeenAt: now,
        lastSeenAt: now,
        expiresAt: leaseExpiryIso(
          now,
          record["expires-after"],
          this.#connection.pollIntervalSeconds * 3,
        ),
        randomizedMac: mac ? ["2", "6", "a", "e"].includes(mac[1] ?? "") : false,
      };
    });

    const aruba: ArubaObservation[] = parseRouterOsRecords(neighborOutput)
      .filter(isAruba)
      .map((record, index) => ({
        externalKey: record["mac-address"]?.toLowerCase() ?? record.identity ?? `aruba-${index}`,
        displayName: record.identity ?? record["mac-address"] ?? `Aruba ${index + 1}`,
        reachable: true,
        model: record.board ?? record.platform ?? null,
        managementIp: record.address ?? null,
        metadata: { discovery: "routeros-neighbor" },
      }));

    const totalMemory = parseBytes(resource["total-memory"]);
    const freeMemory = parseBytes(resource["free-memory"]);
    const totalDisk = parseBytes(resource["total-hdd-space"]);
    const freeDisk = parseBytes(resource["free-hdd-space"]);
    const device: JsonObject = {
      deviceId: this.#connection.deviceId,
      lastSeenAt: now,
      reachable: true,
      healthStatus: "HEALTHY",
      identity: identity.name ?? this.#connection.displayName,
      routerosVersion: resource.version ?? null,
      uptimeSeconds: parseDurationSeconds(resource.uptime),
      cpuPct: integer(resource["cpu-load"]),
      memoryUsedBytes: totalMemory !== null && freeMemory !== null ? totalMemory - freeMemory : null,
      memoryTotalBytes: totalMemory,
      diskUsedBytes: totalDisk !== null && freeDisk !== null ? totalDisk - freeDisk : null,
      diskTotalBytes: totalDisk,
      pppoeState: null,
      connectionCount: clients.length,
      dhcpBound: dhcpClients.some((record) => record.status === "bound"),
    };
    return { observedAt: now, device, interfaces, clients, aruba };
  }

  async captureBackup(): Promise<RouterBackup> {
    const suffix = randomBytes(12).toString("hex");
    const backupName = `nc-${suffix}`;
    const exportName = `nc-${suffix}-redacted`;
    const backupFile = `${backupName}.backup`;
    const exportFile = `${exportName}.rsc`;
    try {
      await this.#execute(
        `/system/backup/save name=${quoteRouterOsValue(backupName)} password=${quoteRouterOsValue(this.#credential.backupPassword)} encryption=aes-sha256`,
      );
      await this.#execute(
        `/export terse show-sensitive=no file=${quoteRouterOsValue(exportName)}`,
      );
      const [binary, redacted] = await Promise.all([
        this.#readRemoteFile(backupFile),
        this.#readRemoteFile(exportFile),
      ]);
      return { binary, redactedExport: redacted.toString("utf8") };
    } finally {
      try {
        await this.#execute(
          `/file/remove [find where name=${quoteRouterOsValue(backupFile)}]; /file/remove [find where name=${quoteRouterOsValue(exportFile)}]`,
        );
      } catch {
        // Cleanup failure is intentionally non-fatal; remote names are random and contain no secrets.
      }
    }
  }

  async healthCheck(): Promise<RouterHealth> {
    const [identity, interfaces, dhcp, dns] = await Promise.all([
      this.#execute(READ_COMMANDS.identity),
      this.#execute(READ_COMMANDS.interfaces),
      this.#execute(READ_COMMANDS.dhcpClients),
      this.#execute(READ_COMMANDS.dns),
    ]);
    const interfaceRecords = parseRouterOsRecords(interfaces);
    const wanUp = interfaceRecords.some((record) => {
      const name = record.name ?? "";
      return interfaceRole(name, record.type ?? "") === "WAN" && boolean(record.running);
    }) || parseRouterOsRecords(dhcp).some((record) => record.status === "bound");
    const dnsRecord = parseRouterOsRecords(dns)[0] ?? {};
    return {
      reachable: parseRouterOsRecords(identity).length > 0,
      wanUp,
      dnsOk: Boolean(dnsRecord.servers || dnsRecord["dynamic-servers"] || dnsRecord["allow-remote-requests"]),
    };
  }

  async flushDnsCache(): Promise<void> {
    await this.#execute(ROUTER_OS_COMMANDS.flushDnsCache);
  }

  async renewDhcpLease(): Promise<boolean> {
    const clients = parseRouterOsRecords(await this.#execute(READ_COMMANDS.dhcpClients));
    if (!clients.some((record) => record.status === "bound")) return false;
    await this.#execute(ROUTER_OS_COMMANDS.renewDhcpLease);
    return true;
  }

  async cycleAccessPort(interfaceExternalKey: string, durationSeconds: number): Promise<void> {
    if (!Number.isInteger(durationSeconds) || durationSeconds < 5 || durationSeconds > 30) {
      throw new RouterOperationError("INVALID_CYCLE_DURATION", { retryable: false, mayHaveExecuted: false });
    }
    if (/^(ether1|sfp|wg|wireguard|bridge)/i.test(interfaceExternalKey)) {
      throw new RouterOperationError("PROTECTED_INTERFACE", { retryable: false, mayHaveExecuted: false });
    }
    const name = quoteRouterOsValue(interfaceExternalKey);
    const command = `:local ncPort [/interface/find where name=${name}]; :if ([:len $ncPort] != 1) do={:error "access port not found"}; /interface/disable $ncPort; :delay ${durationSeconds}s; /interface/enable $ncPort`;
    await this.#execute(command, true);
  }

  async reboot(): Promise<void> {
    await this.#execute(ROUTER_OS_COMMANDS.reboot, true);
  }

  async close(): Promise<void> {
    this.#client?.end();
    this.#client = null;
  }
}
