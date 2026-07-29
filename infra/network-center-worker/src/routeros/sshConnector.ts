import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve, sep } from "node:path";

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
import {
  ROUTER_BACKUP_MAX_BYTES,
  ROUTER_BACKUP_TIMEOUT_MS,
  ROUTER_EXPORT_MAX_BYTES,
  ROUTER_EXPORT_TIMEOUT_MS,
  readSftpRemoteFileBounded,
  stageSftpRemoteFileBounded,
} from "./boundedSftpRead.js";

export const ROUTER_OS_COMMANDS = Object.freeze({
  flushDnsCache: "/ip/dns/cache/flush",
  renewDhcpLease: "/ip/dhcp-client/renew [find where status=\"bound\"]",
  reboot: "/system/reboot",
});

export const ROUTER_OS_READ_COMMANDS = Object.freeze({
  identity: ":put [/system/identity/print as-value]",
  resource: ":put [/system/resource/print as-value]",
  interfaces: "/interface/print detail terse without-paging",
  dhcpClients: "/ip/dhcp-client/print detail terse without-paging",
  leases: "/ip/dhcp-server/lease/print detail terse without-paging",
  neighbors: "/ip/neighbor/print detail terse without-paging",
  dns: ":put [/ip/dns/print as-value]",
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

    const semicolonFields = splitEscaped(trimmed, ";");
    if (semicolonFields.length > 1) {
      for (const field of semicolonFields) {
        const separator = field.indexOf("=");
        if (separator <= 0) continue;
        record[field.slice(0, separator).trim()] = field.slice(separator + 1).trim();
      }
    } else {
      const fields: Array<{ start: number; key: string; valueStart: number }> = [];
      let escaped = false;
      let quoted = false;
      for (let index = 0; index < trimmed.length; index += 1) {
        const character = trimmed[index] ?? "";
        if (escaped) {
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
        if (quoted || (index > 0 && !/\s/.test(trimmed[index - 1] ?? ""))) continue;
        let keyEnd = index;
        while (keyEnd < trimmed.length && /[A-Za-z0-9._-]/.test(trimmed[keyEnd] ?? "")) {
          keyEnd += 1;
        }
        if (keyEnd === index || trimmed[keyEnd] !== "=") continue;
        fields.push({ start: index, key: trimmed.slice(index, keyEnd), valueStart: keyEnd + 1 });
        index = keyEnd;
      }

      if (fields.length > 0) {
        const prefix = trimmed.slice(0, fields[0]?.start ?? 0).trim().split(/\s+/).filter(Boolean);
        if (/^\d+$/.test(prefix[0] ?? "")) prefix.shift();
        if (prefix.length > 0) record[".flags"] = prefix.join("");
      }
      for (let index = 0; index < fields.length; index += 1) {
        const field = fields[index];
        if (!field) continue;
        const next = fields[index + 1];
        let value = trimmed.slice(field.valueStart, next?.start ?? trimmed.length).trim();
        if (value.startsWith("\"") && value.endsWith("\"") && value.length >= 2) {
          value = value.slice(1, -1);
        }
        record[field.key] = value.replace(/\\(.)/g, "$1");
      }
    }
    if (Object.keys(record).length > 0) records.push(record);
  }
  return records;
}

export function routerOsCommandFailed(output: string): boolean {
  return /^(?:expected end of command|syntax error|bad command name|failure:|script error:)/i
    .test(output.trimStart());
}

interface SshConnectorOptions {
  connection: NetworkConnection;
  credential: RouterCredential;
  commandTimeoutMs: number;
  backupStagingDirectory: string;
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

function hasFlag(record: Record<string, string>, flag: string): boolean {
  return record[".flags"]?.includes(flag) ?? false;
}

export function routerOsInterfaceState(
  record: Record<string, string>,
): { enabled: boolean; running: boolean } {
  const enabled = record.disabled !== "true" && !hasFlag(record, "X");
  return {
    enabled,
    running: enabled && (boolean(record.running) || hasFlag(record, "R")),
  };
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

// `serial:` plus the normalized value must fit the 160-byte external-key boundary.
const ARUBA_SERIAL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,152}$/;
const HARDWARE_MAC = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;

function normalizedArubaSerial(record: Record<string, string>): string | null {
  const value = (
    record["serial-number"]
    ?? record.serial
    ?? record["serial-no"]
    ?? ""
  ).trim();
  return ARUBA_SERIAL.test(value) ? value.toUpperCase() : null;
}

function normalizedHardwareMac(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (!HARDWARE_MAC.test(normalized)) return null;
  const firstOctet = Number.parseInt(normalized.slice(0, 2), 16);
  if ((firstOctet & 1) !== 0) return null;
  if (normalized === "00:00:00:00:00:00" || normalized === "ff:ff:ff:ff:ff:ff") {
    return null;
  }
  return normalized;
}

function safeArubaAlias(value: string | undefined): string | null {
  const alias = value?.trim() ?? "";
  if (!alias || alias.length > 160 || /[\u0000-\u001f\u007f]/.test(alias)) return null;
  return alias;
}

export function parseArubaNeighbors(records: Record<string, string>[]): {
  valid: ArubaObservation[];
  quarantined: Array<{
    code: "ARUBA_STABLE_IDENTITY_INVALID";
    fingerprint: string;
  }>;
} {
  const candidates = records.filter(isAruba).map((record) => ({
    record,
    serial: normalizedArubaSerial(record),
    mac: normalizedHardwareMac(record["mac-address"]),
  }));
  const serialByMac = new Map<string, string>();
  for (const candidate of candidates) {
    if (candidate.serial && candidate.mac) serialByMac.set(candidate.mac, candidate.serial);
  }

  const valid = new Map<string, ArubaObservation>();
  const quarantined: Array<{
    code: "ARUBA_STABLE_IDENTITY_INVALID";
    fingerprint: string;
  }> = [];
  for (const candidate of candidates) {
    const serial = candidate.serial
      ?? (candidate.mac ? serialByMac.get(candidate.mac) ?? null : null);
    const identitySource = serial ? "SERIAL" as const : "HARDWARE_MAC" as const;
    const stableIdentity = serial ?? candidate.mac;
    if (!stableIdentity) {
      quarantined.push({
        code: "ARUBA_STABLE_IDENTITY_INVALID",
        fingerprint: createHash("sha256").update(JSON.stringify([
          candidate.record.identity ?? "",
          candidate.record["serial-number"] ?? candidate.record.serial ?? "",
          candidate.record["mac-address"] ?? "",
        ])).digest("hex"),
      });
      continue;
    }

    const externalKey = identitySource === "SERIAL"
      ? `serial:${stableIdentity}`
      : `mac:${stableIdentity}`;
    const alias = safeArubaAlias(candidate.record.identity);
    const previous = valid.get(externalKey);
    const aliases = new Set(previous?.aliases ?? []);
    if (alias) aliases.add(alias);
    const displayName = alias
      ?? previous?.displayName
      ?? (identitySource === "SERIAL" ? stableIdentity : `Aruba ${stableIdentity}`);
    valid.set(externalKey, {
      stableIdentity,
      identitySource,
      externalKey,
      aliases: [...aliases],
      displayName,
      displayOnly: true,
      reachable: true,
      model: candidate.record.board ?? candidate.record.platform ?? previous?.model ?? null,
      managementIp: candidate.record.address ?? previous?.managementIp ?? null,
      metadata: { discovery: "routeros-neighbor" },
    });
  }

  return { valid: [...valid.values()], quarantined };
}

export class SshRouterConnector implements RouterConnector {
  readonly #connection: NetworkConnection;
  readonly #credential: RouterCredential;
  readonly #commandTimeoutMs: number;
  readonly #now: () => Date;
  readonly #clientFactory: () => Client;
  readonly #backupStagingDirectory: string;
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
    this.#backupStagingDirectory = resolve(options.backupStagingDirectory);
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
          const output = Buffer.concat(stdout).toString("utf8");
          if (routerOsCommandFailed(output)) {
            reject(new RouterOperationError("ROUTEROS_COMMAND_REJECTED", {
              retryable: false,
              mayHaveExecuted,
            }));
            return;
          }
          resolve(output);
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

  async poll(): Promise<RouterObservation> {
    const [identityOutput, resourceOutput, interfaceOutput, dhcpOutput, leaseOutput, neighborOutput] =
      await Promise.all([
        this.#execute(ROUTER_OS_READ_COMMANDS.identity),
        this.#execute(ROUTER_OS_READ_COMMANDS.resource),
        this.#execute(ROUTER_OS_READ_COMMANDS.interfaces),
        this.#execute(ROUTER_OS_READ_COMMANDS.dhcpClients),
        this.#execute(ROUTER_OS_READ_COMMANDS.leases),
        this.#execute(ROUTER_OS_READ_COMMANDS.neighbors),
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
      const state = routerOsInterfaceState(record);
      const speed = parseBytes(record.rate ?? record["link-downs"]);
      const metadata: JsonObject = { interfaceKind: interfaceKind(type), sortOrder: index };
      if (record["mac-address"]) metadata.macAddress = record["mac-address"];
      if (speed) metadata.nominalSpeedBps = speed;
      return {
        externalKey: name,
        displayName: name,
        role,
        protected: role === "WAN" || role === "MANAGEMENT" || role === "UPLINK",
        enabled: state.enabled,
        sample: {
          linkState: state.running ? "UP" : "DOWN",
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

    const arubaInventory = parseArubaNeighbors(parseRouterOsRecords(neighborOutput));
    const aruba = arubaInventory.valid;

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
    return {
      observedAt: now,
      device,
      interfaces,
      clients,
      aruba,
      arubaQuarantine: arubaInventory.quarantined,
    };
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
      const exportSftp = await this.#sftp();
      const redacted = await readSftpRemoteFileBounded(exportSftp, exportFile, {
        kind: "export",
        maxBytes: ROUTER_EXPORT_MAX_BYTES,
        timeoutMs: ROUTER_EXPORT_TIMEOUT_MS,
      });
      await mkdir(this.#backupStagingDirectory, { recursive: true, mode: 0o700 });
      const localPath = resolve(this.#backupStagingDirectory, `${backupName}.backup.part`);
      if (!localPath.startsWith(`${this.#backupStagingDirectory}${sep}`)) {
        throw new RouterOperationError("SFTP_STAGING_PATH_INVALID", {
          retryable: false,
          mayHaveExecuted: false,
        });
      }
      const backupSftp = await this.#sftp();
      const artifact = await stageSftpRemoteFileBounded(backupSftp, backupFile, {
        kind: "backup",
        destinationPath: localPath,
        maxBytes: ROUTER_BACKUP_MAX_BYTES,
        timeoutMs: ROUTER_BACKUP_TIMEOUT_MS,
      });
      return { artifact, redactedExport: redacted.toString("utf8") };
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
      this.#execute(ROUTER_OS_READ_COMMANDS.identity),
      this.#execute(ROUTER_OS_READ_COMMANDS.interfaces),
      this.#execute(ROUTER_OS_READ_COMMANDS.dhcpClients),
      this.#execute(ROUTER_OS_READ_COMMANDS.dns),
    ]);
    const interfaceRecords = parseRouterOsRecords(interfaces);
    const wanUp = interfaceRecords.some((record) => {
      const name = record.name ?? "";
      return interfaceRole(name, record.type ?? "") === "WAN"
        && routerOsInterfaceState(record).running;
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
    const clients = parseRouterOsRecords(await this.#execute(ROUTER_OS_READ_COMMANDS.dhcpClients));
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
