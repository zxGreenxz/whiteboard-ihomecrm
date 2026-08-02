import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve, sep } from "node:path";

import { Client, type ClientChannel, type SFTPWrapper } from "ssh2";

import {
  RouterOperationError,
  type ArubaObservation,
  type JsonObject,
  type ManagedInterfaceTarget,
  type NetworkConnection,
  type RouterClientObservation,
  type RouterCredential,
  type RouterInterfaceObservation,
  type RouterObservation,
} from "../domain.js";
import { AsyncSemaphore } from "../concurrency.js";
import type { ActionObservation, CommandIntent } from "../reconciliation.js";
import type { RouterBackup, RouterConnector, RouterHealth } from "./connector.js";
import {
  ROUTER_BACKUP_MAX_BYTES,
  ROUTER_BACKUP_TIMEOUT_MS,
  ROUTER_EXPORT_MAX_BYTES,
  ROUTER_EXPORT_TIMEOUT_MS,
  readSftpRemoteFileBounded,
  stageSftpRemoteFileBounded,
} from "./boundedSftpRead.js";
import {
  ACCESS_PORT_CYCLE_TIMEOUT_MARGIN_MS,
  MAX_ACCESS_PORT_CYCLE_SECONDS,
  MIN_ACCESS_PORT_CYCLE_SECONDS,
  accessPortCycleGuardComment,
  buildAccessPortCycleArmCommand,
  buildAccessPortCycleCommand,
  buildAccessPortCycleGuardProbeCommand,
  parseAccessPortCycleGuardProbe,
  quoteRouterOsValue,
} from "./portCycle.js";

export { quoteRouterOsValue } from "./portCycle.js";

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
  firewallFilters: "/ip/firewall/filter/print detail terse without-paging",
  dns: ":put [/ip/dns/print as-value]",
});

const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_SSH_CLOSE_WAIT_MS = 5_000;

export function normalizeHostFingerprint(value: string): string {
  const match = /^SHA256:([A-Za-z0-9+/]{20,}={0,2})$/.exec(value.trim());
  if (!match?.[1]) throw new TypeError("A pinned SHA256 host-key fingerprint is required");
  return match[1].replace(/=+$/, "");
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
  sftpSemaphore?: AsyncSemaphore;
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

function interfaceRole(
  name: string,
  type: string,
  immutableKey?: string | null,
): RouterInterfaceObservation["role"] {
  const currentName = name.toLowerCase();
  const normalized = (immutableKey ?? name).toLowerCase();
  if (
    normalized === "ether1"
    || normalized.startsWith("wan")
    || normalized.startsWith("pppoe")
    || currentName.startsWith("wan")
    || currentName.startsWith("pppoe")
  ) return "WAN";
  if (type === "wireguard" || normalized.startsWith("wg") || currentName.startsWith("wg")) return "MANAGEMENT";
  if (type === "bridge") return "LAN";
  if (
    normalized.startsWith("sfp")
    || normalized.startsWith("uplink")
    || currentName.startsWith("sfp")
    || currentName.startsWith("uplink")
  ) return "UPLINK";
  return "ACCESS";
}

const PHYSICAL_ACCESS_PORT = /^ether(?:[2-9]|[1-9][0-9])$/i;
const ROUTEROS_RESOURCE_ID = /^\*[0-9A-Fa-f]+$/;
const RECOVERY_RULE_MARKER =
  /^(ihomecrm-network-center:v1:[A-Za-z0-9][A-Za-z0-9._-]{7,63}):lan-recovery$/;

function ownedRecoveryRules(
  records: Record<string, string>[],
): Array<{ interfaceName: string; ownershipMarker: string }> {
  return records.flatMap((record) => {
    const interfaceName = record["in-interface"]?.trim();
    const ownershipMarker = RECOVERY_RULE_MARKER.exec(record.comment ?? "")?.[1];
    return record.chain === "input"
      && record.action === "accept"
      && interfaceName
      && ownershipMarker
      ? [{ interfaceName, ownershipMarker }]
      : [];
  });
}

export function routerOsRecoveryInterfaceNames(
  records: Record<string, string>[],
): Set<string> {
  return new Set(ownedRecoveryRules(records).map((rule) => rule.interfaceName));
}

/**
 * Reads the router's own deployment ownership marker back out of the bootstrap
 * recovery rule it carries. This is the only in-band source of the marker, and
 * requiring it also fails a disruptive port cycle closed when the firewall read did
 * not deliver the rules that back the recovery-interface guard.
 */
export function routerOsOwnershipMarker(records: Record<string, string>[]): string {
  const markers = new Set(ownedRecoveryRules(records).map((rule) => rule.ownershipMarker));
  const marker = [...markers][0];
  if (markers.size !== 1 || !marker) {
    throw new RouterOperationError("ROUTER_OWNERSHIP_MARKER_UNAVAILABLE", {
      retryable: false,
      mayHaveExecuted: false,
    });
  }
  return marker;
}

function routerOsMarkers(output: string): string[] {
  return output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

export function parseRouterOsResourceId(output: string): string | null {
  const values = output.trim().split(/\s+/).filter(Boolean);
  return values.length === 1 && ROUTEROS_RESOURCE_ID.test(values[0] ?? "")
    ? values[0]!
    : null;
}

export function resolveManagedAccessPort(
  target: ManagedInterfaceTarget,
  records: Record<string, string>[],
  recoveryInterfaceNames: ReadonlySet<string> = new Set(),
): { resourceId: string | null; currentName: string; immutableKey: string } {
  if (target.enrollmentState !== "ENROLLED") {
    throw new RouterOperationError("INTERFACE_NOT_ENROLLED", {
      retryable: false,
      mayHaveExecuted: false,
    });
  }
  if (target.enrolledRole !== "ACCESS") {
    throw new RouterOperationError("INTERFACE_NOT_ACCESS", {
      retryable: false,
      mayHaveExecuted: false,
    });
  }
  if (
    target.protected
    || recoveryInterfaceNames.has(target.currentName)
    || !target.immutableKey
    || !PHYSICAL_ACCESS_PORT.test(target.immutableKey)
  ) {
    throw new RouterOperationError("PROTECTED_INTERFACE", {
      retryable: false,
      mayHaveExecuted: false,
    });
  }
  if (target.interfaceKey !== target.immutableKey) {
    throw new RouterOperationError("INTERFACE_IDENTITY_MISMATCH", {
      retryable: false,
      mayHaveExecuted: false,
    });
  }
  const matches = records.filter((record) =>
    record["default-name"] === target.immutableKey
    && record.type?.toLowerCase().includes("ether")
  );
  const record = matches[0];
  if (
    matches.length !== 1
    || !record
    || record.name !== target.currentName
  ) {
    throw new RouterOperationError("INTERFACE_IDENTITY_MISMATCH", {
      retryable: true,
      mayHaveExecuted: false,
    });
  }
  if (interfaceRole(record.name, record.type ?? "", record["default-name"]) !== "ACCESS") {
    throw new RouterOperationError("PROTECTED_INTERFACE", {
      retryable: false,
      mayHaveExecuted: false,
    });
  }
  return {
    resourceId: record[".id"] && ROUTEROS_RESOURCE_ID.test(record[".id"])
      ? record[".id"]
      : null,
    currentName: record.name,
    immutableKey: record["default-name"]!,
  };
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
  readonly #sftpSemaphore: AsyncSemaphore;
  #client: Client | null = null;
  #connecting: Promise<Client> | null = null;
  #dnsCommandAck = false;
  #lastAccessCycle: {
    managedResourceId: string;
    immutableKey: string;
  } | null = null;

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
    this.#sftpSemaphore = options.sftpSemaphore ?? new AsyncSemaphore(1);
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
          if (this.#client === client) client.destroy();
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
        // ssh2 reports the remote exit status on `exit`, and repeats it as the first
        // `close` argument for session channels. When the session is torn down before
        // the remote sends `exit-status` (transport reset, SIGKILL, host reboot) that
        // argument is `undefined`; an `exit-signal` makes it `null`. Neither means the
        // command completed, and neither may be reported as success with whatever
        // output happened to arrive first.
        let exitStatus: unknown;
        let exitObserved = false;
        channel.once("exit", (code: number | null) => {
          exitStatus = code;
          exitObserved = true;
        });
        channel.on("data", collect(stdout));
        channel.stderr.on("data", collect(stderr));
        channel.once("close", (code?: number | null) => finish(() => {
          const status = exitObserved ? exitStatus : code;
          if (typeof status !== "number" || !Number.isFinite(status)) {
            reject(new RouterOperationError("SSH_EXEC_NO_EXIT_STATUS", {
              retryable: true,
              mayHaveExecuted,
            }));
            return;
          }
          if (status !== 0) {
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
    const [
      identityOutput,
      resourceOutput,
      interfaceOutput,
      dhcpOutput,
      leaseOutput,
      neighborOutput,
      firewallOutput,
    ] =
      await Promise.all([
        this.#execute(ROUTER_OS_READ_COMMANDS.identity),
        this.#execute(ROUTER_OS_READ_COMMANDS.resource),
        this.#execute(ROUTER_OS_READ_COMMANDS.interfaces),
        this.#execute(ROUTER_OS_READ_COMMANDS.dhcpClients),
        this.#execute(ROUTER_OS_READ_COMMANDS.leases),
        this.#execute(ROUTER_OS_READ_COMMANDS.neighbors),
        this.#execute(ROUTER_OS_READ_COMMANDS.firewallFilters),
      ]);
    const identity = parseRouterOsRecords(identityOutput)[0] ?? {};
    const resource = parseRouterOsRecords(resourceOutput)[0] ?? {};
    const interfaceRecords = parseRouterOsRecords(interfaceOutput);
    const dhcpClients = parseRouterOsRecords(dhcpOutput);
    const recoveryInterfaceNames = routerOsRecoveryInterfaceNames(
      parseRouterOsRecords(firewallOutput),
    );
    const now = this.#now().toISOString();

    const interfaces: RouterInterfaceObservation[] = interfaceRecords.map((record, index) => {
      const name = record.name ?? `interface-${index}`;
      const type = record.type ?? "unknown";
      const defaultName = record["default-name"]?.trim() || null;
      const immutableKey = type.toLowerCase().includes("ether")
        ? defaultName
        : null;
      const role = interfaceRole(name, type, immutableKey);
      const state = routerOsInterfaceState(record);
      const speed = parseBytes(record.rate ?? record["link-downs"]);
      const metadata: JsonObject = { interfaceKind: interfaceKind(type), sortOrder: index };
      if (record["mac-address"]) metadata.macAddress = record["mac-address"];
      if (speed) metadata.nominalSpeedBps = speed;
      return {
        externalKey: immutableKey ?? name,
        displayName: name,
        immutableKey,
        role,
        protected: recoveryInterfaceNames.has(name)
          || role === "WAN"
          || role === "MANAGEMENT"
          || role === "UPLINK",
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
      return await this.#sftpSemaphore.use(async () => {
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
      });
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
      return interfaceRole(name, record.type ?? "", record["default-name"] ?? null) === "WAN"
        && routerOsInterfaceState(record).running;
    }) || parseRouterOsRecords(dhcp).some((record) => record.status === "bound");
    const dnsRecord = parseRouterOsRecords(dns)[0] ?? {};
    return {
      reachable: parseRouterOsRecords(identity).length > 0,
      wanUp,
      dnsOk: Boolean(dnsRecord.servers || dnsRecord["dynamic-servers"] || dnsRecord["allow-remote-requests"]),
    };
  }

  async observeAction(intent: CommandIntent): Promise<ActionObservation> {
    const observedAt = this.#now().toISOString();
    if (intent.actionType === "FLUSH_DNS_CACHE") {
      const identity = parseRouterOsRecords(await this.#execute(ROUTER_OS_READ_COMMANDS.identity));
      return {
        observedAt,
        reachable: identity.length > 0,
        ...(this.#dnsCommandAck ? { dns: { commandAck: true } } : {}),
      };
    }
    if (intent.actionType === "RENEW_DHCP_LEASE") {
      const [identityOutput, dhcpOutput] = await Promise.all([
        this.#execute(ROUTER_OS_READ_COMMANDS.identity),
        this.#execute(ROUTER_OS_READ_COMMANDS.dhcpClients),
      ]);
      const clients = parseRouterOsRecords(dhcpOutput);
      const bound = clients.find((record) => record.status?.toLowerCase() === "bound");
      return {
        observedAt,
        reachable: parseRouterOsRecords(identityOutput).length > 0,
        dhcp: bound ? {
          leaseKey: bound[".id"] ?? bound.interface ?? "wan-dhcp",
          status: "bound",
          expiresInSeconds: parseDurationSeconds(bound["expires-after"]) ?? 0,
        } : { notApplicable: true },
      };
    }
    if (intent.actionType === "CYCLE_ACCESS_PORT") {
      const [identityOutput, interfaceOutput] = await Promise.all([
        this.#execute(ROUTER_OS_READ_COMMANDS.identity),
        this.#execute(ROUTER_OS_READ_COMMANDS.interfaces),
      ]);
      const immutableKey = String(intent.managedTarget.immutableKey ?? "").trim();
      const managedResourceId = String(intent.managedTarget.managedResourceId ?? "").trim();
      const record = parseRouterOsRecords(interfaceOutput).find(
        (candidate) => candidate["default-name"] === immutableKey,
      );
      const cycled = this.#lastAccessCycle;
      return {
        observedAt,
        reachable: parseRouterOsRecords(identityOutput).length > 0,
        accessInterface: {
          managedResourceId,
          immutableKey,
          enabled: Boolean(record) && record?.disabled !== "true",
          disabledObserved: cycled?.managedResourceId === managedResourceId
            && cycled.immutableKey === immutableKey,
          enabledObserved: Boolean(record) && record?.disabled !== "true",
        },
      };
    }
    if (intent.actionType === "REBOOT_ROUTER") {
      const [identityOutput, resourceOutput] = await Promise.all([
        this.#execute(ROUTER_OS_READ_COMMANDS.identity),
        this.#execute(ROUTER_OS_READ_COMMANDS.resource),
      ]);
      const resource = parseRouterOsRecords(resourceOutput)[0] ?? {};
      const uptimeSeconds = parseDurationSeconds(resource.uptime) ?? 0;
      const bootEpochSeconds = Math.floor(this.#now().getTime() / 1_000) - uptimeSeconds;
      return {
        observedAt,
        reachable: parseRouterOsRecords(identityOutput).length > 0,
        boot: {
          bootId: `routeros-boot:${bootEpochSeconds}`,
          uptimeSeconds,
        },
      };
    }
    const identity = parseRouterOsRecords(await this.#execute(ROUTER_OS_READ_COMMANDS.identity));
    return { observedAt, reachable: identity.length > 0 };
  }

  async flushDnsCache(): Promise<void> {
    await this.#execute(ROUTER_OS_COMMANDS.flushDnsCache);
    this.#dnsCommandAck = true;
  }

  async renewDhcpLease(): Promise<boolean> {
    const clients = parseRouterOsRecords(await this.#execute(ROUTER_OS_READ_COMMANDS.dhcpClients));
    if (!clients.some((record) => record.status === "bound")) return false;
    await this.#execute(ROUTER_OS_COMMANDS.renewDhcpLease);
    return true;
  }

  async cycleAccessPort(target: ManagedInterfaceTarget, durationSeconds: number): Promise<void> {
    if (
      !Number.isInteger(durationSeconds)
      || durationSeconds < MIN_ACCESS_PORT_CYCLE_SECONDS
      || durationSeconds > MAX_ACCESS_PORT_CYCLE_SECONDS
    ) {
      throw new RouterOperationError("INVALID_CYCLE_DURATION", { retryable: false, mayHaveExecuted: false });
    }
    // Fail before touching the router when the watchdog would fire inside the delay.
    if (
      this.#commandTimeoutMs
      < durationSeconds * 1_000 + ACCESS_PORT_CYCLE_TIMEOUT_MARGIN_MS
    ) {
      throw new RouterOperationError("COMMAND_TIMEOUT_TOO_SHORT_FOR_CYCLE", {
        retryable: false,
        mayHaveExecuted: false,
      });
    }
    const [interfaceOutput, firewallOutput] = await Promise.all([
      this.#execute(ROUTER_OS_READ_COMMANDS.interfaces),
      this.#execute(ROUTER_OS_READ_COMMANDS.firewallFilters),
    ]);
    const firewallRecords = parseRouterOsRecords(firewallOutput);
    const resolved = resolveManagedAccessPort(
      target,
      parseRouterOsRecords(interfaceOutput),
      routerOsRecoveryInterfaceNames(firewallRecords),
    );
    const ownershipMarker = routerOsOwnershipMarker(firewallRecords);
    const currentName = quoteRouterOsValue(resolved.currentName);
    const immutableKey = quoteRouterOsValue(resolved.immutableKey);
    const resourceId = parseRouterOsResourceId(await this.#execute(
      `:put [/interface/find where name=${currentName} and default-name=${immutableKey}]`,
    ));
    if (!resourceId || (resolved.resourceId && resolved.resourceId !== resourceId)) {
      throw new RouterOperationError("INTERFACE_IDENTITY_MISMATCH", {
        retryable: true,
        mayHaveExecuted: false,
      });
    }
    const cycleTarget = {
      resourceId,
      currentName: resolved.currentName,
      immutableKey: resolved.immutableKey,
      ownershipMarker,
    };

    // 1. Decide deterministically what to do with any entry already holding the
    //    managed name. A stale entry of ours is replaced, never reused; anything
    //    else is left untouched and the cycle is refused.
    const probe = parseAccessPortCycleGuardProbe(await this.#execute(
      buildAccessPortCycleGuardProbeCommand(accessPortCycleGuardComment(ownershipMarker)),
    ));
    if (!probe) {
      throw new RouterOperationError("PORT_CYCLE_GUARD_STATE_UNREADABLE", {
        retryable: true,
        mayHaveExecuted: false,
      });
    }
    if (probe.count > 1 || (probe.count === 1 && !probe.owned)) {
      throw new RouterOperationError("PORT_CYCLE_GUARD_NOT_OWNED", {
        retryable: false,
        mayHaveExecuted: false,
      });
    }

    // 2. Arm the router-side dead-man's switch. Nothing on the access port has been
    //    mutated yet, so any failure here stays a clean, non-disruptive failure.
    const armMarkers = routerOsMarkers(await this.#execute(
      buildAccessPortCycleArmCommand(cycleTarget, durationSeconds),
    ));
    if (!armMarkers.includes(`NC_CYCLE_ARMED:${resolved.immutableKey}`)) {
      throw new RouterOperationError("PORT_CYCLE_GUARD_NOT_ARMED", {
        retryable: true,
        mayHaveExecuted: false,
      });
    }

    // 3. Only now disable. Every statement from here on is expendable: if this exec
    //    dies the router still re-enables the port and removes the guard itself.
    this.#lastAccessCycle = null;
    const markers = routerOsMarkers(await this.#execute(
      buildAccessPortCycleCommand(cycleTarget, durationSeconds),
      true,
    ));
    // Success still turns on the ordered disable/enable readback only. A guard the
    // router has not finished cleaning up re-enables an already-enabled port and then
    // removes itself, so it must never turn a restored port into an UNCERTAIN command.
    const disabledIndex = markers.indexOf(`NC_CYCLE_DISABLED:${resolved.immutableKey}`);
    const enabledIndex = markers.indexOf(`NC_CYCLE_ENABLED:${resolved.immutableKey}`);
    if (disabledIndex < 0 || enabledIndex <= disabledIndex) {
      throw new RouterOperationError("PORT_CYCLE_EVIDENCE_MISSING", {
        retryable: true,
        mayHaveExecuted: true,
      });
    }
    this.#lastAccessCycle = {
      managedResourceId: target.managedResourceId,
      immutableKey: resolved.immutableKey,
    };
  }

  async reboot(): Promise<void> {
    try {
      await this.#execute(ROUTER_OS_COMMANDS.reboot, true);
    } catch (error) {
      // A reboot tears the console down before RouterOS can send an exit status, so
      // this is the one command for which a missing exit status is the normal case.
      // Whether it actually rebooted is decided by the postcondition (new boot id and
      // a lower uptime), never by the exec. Every other command stays strict.
      if (
        error instanceof RouterOperationError
        && error.code === "SSH_EXEC_NO_EXIT_STATUS"
      ) return;
      throw error;
    }
  }

  async close(): Promise<void> {
    const client = this.#client;
    if (!client) return;

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        client.removeListener("close", finish);
        resolve();
      };
      const forceDestroyAndFinish = () => {
        try {
          client.destroy();
        } finally {
          finish();
        }
      };
      const timeout = setTimeout(
        forceDestroyAndFinish,
        Math.min(Math.max(1, this.#commandTimeoutMs), MAX_SSH_CLOSE_WAIT_MS),
      );
      client.once("close", finish);
      try {
        client.end();
      } catch {
        forceDestroyAndFinish();
      }
    });
  }
}
