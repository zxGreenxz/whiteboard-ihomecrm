import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve, sep } from "node:path";

import { Client, type ClientChannel } from "ssh2";

import {
  RouterOperationError,
  type ArubaObservation,
  type DeviceHealthStatus,
  type InterfaceKind,
  type InterfaceLinkState,
  type JsonObject,
  type ManagedInterfaceTarget,
  type NetworkConnection,
  type RouterClientObservation,
  type RouterCredential,
  type RouterInterfaceObservation,
  type RouterObservation,
} from "../domain.js";
import type { ActionObservation, CommandIntent } from "../reconciliation.js";
import type { RouterBackup, RouterConnector, RouterHealth } from "./connector.js";
import { stageExportTextBounded } from "./boundedSftpRead.js";
import {
  ACCESS_PORT_CYCLE_TIMEOUT_MARGIN_MS,
  MAX_ACCESS_PORT_CYCLE_SECONDS,
  MIN_ACCESS_PORT_CYCLE_SECONDS,
  buildAccessPortCycleCommand,
  buildAccessPortCycleDisarmCommand,
  buildAccessPortCycleGuardProbeCommand,
  parseAccessPortCycleArmedGuard,
  parseAccessPortCycleDisarmed,
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
  // `/interface/print detail` carries NO byte or error counters on RouterOS
  // 7.20.8 — verified against the demo hEX, where every interface parsed to
  // rx/tx/error 0. The counters live behind the `stats` print modifier.
  //
  // It must be read with `as-value`, NOT with `terse`. Measured on the demo hEX
  // (7.20.8, 2026-08-03): `/interface/print stats terse without-paging` returns
  // output BYTE-IDENTICAL to the same command without `terse` (870 B both ways)
  // — `stats` ignores `terse` and always renders a fixed-width column table:
  //
  //     Flags: R - RUNNING; S - SLAVE
  //     Columns: NAME, RX-BYTE, TX-BYTE, RX-PACKET, TX-PACKET
  //     0 R  ether1          79 740 110 494  119 752 269 836  105 512 018 …
  //     ;;; defconf
  //     5 R  bridge         123 021 591 925   79 688 209 862  123 917 871 …
  //
  // There is not one `name=` or `rx-byte=` token in it, the numbers carry SPACE
  // thousands separators, `;;;` comment lines are interleaved, and there are no
  // error or drop columns at all — so a key=value parser matches nothing and
  // every counter would read `null` FOREVER. That is a silent, total telemetry
  // outage wearing the costume of "not collected", which is why the command and
  // the parser are pinned together here and in `parseRouterOsValueRecords`.
  //
  // This read stays BEST EFFORT: if a build rejects it the sample records "not
  // collected" (null) instead of a fabricated zero, and the poll still succeeds.
  // See `#readInterfaceCounters`.
  interfaceStats: ":put [/interface/print as-value stats]",
  dhcpClients: "/ip/dhcp-client/print detail terse without-paging",
  leases: "/ip/dhcp-server/lease/print detail terse without-paging",
  neighbors: "/ip/neighbor/print detail terse without-paging",
  firewallFilters: "/ip/firewall/filter/print detail terse without-paging",
  dns: ":put [/ip/dns/print as-value]",
});

/**
 * The pre-action snapshot: a REDACTED TEXT config export, read straight off
 * stdout.
 *
 * `hide-sensitive` is a FLAG on RouterOS v7, not a `name=value` pair. The form
 * this worker used to send, `/export terse show-sensitive=no file=…`, is a
 * SYNTAX ERROR for every identity including `admin`/`full` — measured on the
 * demo hEX (7.20.8):
 *
 *     /export terse show-sensitive=no   -> expected end of command (line 1 column 29)
 *     /export hide-sensitive=yes        -> expected end of command (line 1 column 23)
 *     /export show-sensitive=yes        -> expected end of command (line 1 column 23)
 *     /export terse hide-sensitive      -> 8133 B, 79 lines, 0 `private-key=`
 *     /ip/address/export terse          -> 354 B  (positive control)
 *
 * Column 29 is exactly the `=` after `show-sensitive`, so the redacted export
 * has never once been captured on any router.
 *
 * `hide-sensitive` is written out even though it is the 7.20.8 DEFAULT
 * (`/export terse` and `/export hide-sensitive terse` were byte-identical,
 * sha256 682b14564b4801af both). Relying on that default is a one-word mistake
 * away from disaster: the sibling flag `/export terse show-sensitive` PARSES,
 * and it prints the WireGuard private key in full (8192 B, one `private-key=`
 * of length 44). Anyone "fixing" the broken form by deleting `=no` would have
 * turned a snapshot that captures nothing into one that exfiltrates the tunnel
 * key on every action. `routerOsExportCommandIsRedacted` pins that shut.
 *
 * `terse` is load-bearing for a second reason: it stops RouterOS wrapping long
 * commands across continuation lines, so every line of the body begins with `/`
 * or `#` and no line of *config* can be mistaken for a RouterOS failure line by
 * `routerOsCommandFailed`.
 */
export const ROUTER_OS_EXPORT_COMMAND = "/export terse hide-sensitive";

/**
 * True only for an export command that is redacted. Exported so the guarantee is
 * asserted from tests rather than trusted to a string literal nobody re-reads.
 */
export function routerOsExportCommandIsRedacted(command: string): boolean {
  return /(?:^|\s)hide-sensitive(?:\s|$)/.test(command)
    && !/(?:^|\s)show-sensitive(?:\s|$)/.test(command);
}

const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_SSH_CLOSE_WAIT_MS = 5_000;

interface RouterExecOutcome {
  /** Everything the router delivered on stdout before the channel settled. */
  output: string;
  /**
   * True only when the channel closed carrying a numeric exit status, i.e. the router
   * itself answered. Only then does the *absence* of a marker in `output` prove the
   * router never reached the statement that would have printed it — a dead channel
   * proves nothing about what did or did not run.
   */
  completed: boolean;
  /** Null when the command completed and the router reported no failure. */
  failure: RouterOperationError | null;
}

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

/**
 * Splits `:put [/… print as-value …]` output into one record per row.
 *
 * `parseRouterOsRecords` cannot do this. That parser is line-oriented, and
 * as-value output for EIGHT interfaces arrives as ONE line of 1305 bytes with
 * the records concatenated and nothing between them — so it would fold the whole
 * fleet of interfaces into a single record whose `name` is whatever the router
 * printed last. Captured verbatim from the demo hEX (7.20.8, 2026-08-03):
 *
 *     .id=*2;disabled=false;name=ether1;running=true;rx-byte=79740110494;
 *     rx-drop=0;rx-error=0;rx-packet=105512018;tx-byte=119752269836;tx-drop=0;
 *     tx-error=0;tx-packet=121576454;tx-queue-drop=2234046;.id=*3;…;name=ether2;…
 *
 * The only record boundary is that every record begins with `.id=`.
 *
 * ## Why the boundary needs a guard
 *
 * as-value does NOT quote or escape its values. Measured directly, by setting a
 * comment on a throwaway group and reading it back:
 *
 *     comment set to:  alpha;name=INJECTED;.id=*999;beta
 *     as-value gave:   .id=*E;comment=alpha;name=INJECTED;.id=*999;beta;
 *                      name=zzcbrw-g1-grp;policy=ssh;read;…
 *
 * So a `;` inside a comment is indistinguishable from a field separator, and a
 * bare `.id=` boundary would split one interface into two — silently halving a
 * counter series. This is not an attack, it is an operator typing an interface
 * comment like `uplink; do not touch`.
 *
 * Two further measured invariants make it survivable:
 *
 *   1. `.id` is always emitted FIRST in a record; and
 *   2. every other field follows in ALPHABETICAL order (`comment` < `disabled` <
 *      `dynamic` < `name` < `running` < `rx-byte` < … < `slave` < `tx-byte` < …,
 *      confirmed on two independent records).
 *
 * `comment` is the only free-text field, and it sorts before `name` and before
 * every counter — so tokens injected through it can only ever land BEFORE the
 * genuine field of the same key, never after. Hence both rules below:
 *
 *   - a `.id=` starts a new record only once the current record has a `name`,
 *     which no comment-borne `.id` can satisfy; and
 *   - a repeated key keeps the LAST value, so the genuine `name`/`rx-byte` wins
 *     over anything a comment smuggled in ahead of it.
 *
 * A `;` inside an interface NAME would still defeat this, and nothing here can
 * detect that; RouterOS does not accept such names and the bootstrap never
 * writes one.
 */
export function parseRouterOsValueRecords(output: string): Array<Record<string, string>> {
  const records: Array<Record<string, string>> = [];
  let current: Record<string, string> | null = null;
  // Newlines are not field separators in as-value output — the router emits at
  // most a trailing one — so they are stripped rather than split on.
  for (const field of output.replace(/[\r\n]/g, "").split(";")) {
    const separator = field.indexOf("=");
    if (separator <= 0) continue;
    const key = field.slice(0, separator).trim();
    const value = field.slice(separator + 1).trim();
    if (key === ".id" && (current === null || current.name !== undefined)) {
      current = {};
      records.push(current);
    }
    if (current === null) continue;
    current[key] = value;
  }
  return records;
}

const ROUTEROS_FAILURE_LINE =
  /^(?:expected end of command|syntax error|bad command name|failure:|script error:|not enough permissions)/i;

/**
 * RouterOS reports a refused command by printing it on **stdout** and still exiting 0
 * — `failure: not allowed by device-mode (/system/scheduler/add; line 1)` is the case
 * that motivated this check. The refusal is not necessarily the first thing on the
 * channel: a multi-statement command prints everything its earlier statements already
 * produced, so anchoring the check at the start of the output turns a refused command
 * into a silent success. Every line is checked instead.
 *
 * A PERMISSION refusal does NOT carry the `failure:` prefix. Measured on the demo
 * hEX (7.20.8, 2026-08-03) under the hardened worker group, four different denied
 * commands answered on stdout with exit status 0:
 *
 *     not enough permissions (9)
 *     not enough permissions (9) (/user/add; line 1)
 *
 * Without this alternative every such refusal read as SUCCESS. That matters most
 * for `/system/reboot`: `reboot` is the one policy in the worker's minimum set
 * that has never been measured (proving it means rebooting a live gateway), so a
 * missing `reboot` policy is a real possibility — and it would have surfaced as a
 * reboot the worker believed it had issued, failing only later and silently as an
 * unexplained postcondition miss. Now it surfaces as the router's own words.
 */
export function routerOsCommandFailed(output: string): boolean {
  return routerOsFailureLine(output) !== null;
}

/**
 * The first line of `output` RouterOS meant as a refusal, trimmed and bounded, or
 * null. This is what gets reported as the failure message, so an operator reads
 * *why* the router said no ("not enough permissions (9)") instead of a generic
 * "Router operation failed".
 *
 * Only a line that MATCHED the refusal grammar is ever returned, and it is capped,
 * so no arbitrary config text — and in particular no key material, which cannot
 * match — can be carried out of the router this way.
 */
export function routerOsFailureLine(output: string): string | null {
  for (const line of output.split(/\r?\n/u)) {
    const candidate = line.trim();
    if (ROUTEROS_FAILURE_LINE.test(candidate)) return candidate.slice(0, 200);
  }
  return null;
}

interface SshConnectorOptions {
  connection: NetworkConnection;
  credential: RouterCredential;
  commandTimeoutMs: number;
  backupStagingDirectory: string;
  now?: () => Date;
  clientFactory?: () => Client;
}

/**
 * A counter or gauge read off the router.
 *
 * NEGATIVE IS REJECTED, not stored. Every one of this function's call sites
 * lands in a column that forbids it - `network_interface_current.rx_bytes`,
 * `tx_bytes` and `error_count` are all `>= 0`, and `network_device_current`
 * bounds `cpu_pct` - so a negative here is not a smaller number, it is a 23514
 * that rolls back the entire telemetry transaction for the whole worker. The
 * router's counters are unsigned; a value that is not is a garbled read, and
 * "not observed" is the honest way to store a garbled read.
 */
function integer(value: string | undefined): number | null {
  if (!value || !/^-?\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * A percentage gauge, bounded the way its column is
 * (`CHECK (cpu_pct IS NULL OR cpu_pct BETWEEN 0 AND 100)`).
 *
 * Out of range becomes null rather than being clamped: clamping 137 to 100
 * would invent a reading the router never gave, and this codebase has already
 * paid for one fabricated telemetry value (the link-flap counter stored as a
 * line speed).
 */
function percentage(value: string | undefined): number | null {
  const parsed = integer(value);
  return parsed !== null && parsed <= 100 ? parsed : null;
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

/**
 * Parses a RouterOS link rate into bits per second.
 *
 * `nominalSpeedBps` used to be `parseBytes(record.rate ?? record["link-downs"])`,
 * which was wrong twice over. RouterOS 7.20.8 emits no `rate` field at all from
 * `/interface/print detail terse`, so the value actually stored was the
 * **link-flap counter** — the demo hEX reported `ether1 nominalSpeedBps: 3` and
 * `ether2: 8`, which were its `link-downs=3` and `link-downs=8`. And even when a
 * build does emit `rate`, it renders it as `1Gbps`/`100Mbps`, which `parseBytes`
 * (bare digits, or KiB/MiB/GiB/TiB) cannot read either, so it would have
 * returned null anyway.
 *
 * Returns null for anything that is not a recognisable rate. Null means "not
 * observed": `nominal_speed_bps` is a nullable column with a `> 0` CHECK, so an
 * absent speed is representable and a wrong one is not.
 */
export function parseLinkSpeedBps(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^(\d+(?:\.\d+)?)\s*(G|M|K)?bps$/i.exec(value.trim());
  if (!match?.[1]) return null;
  const multipliers: Record<string, number> = { g: 1_000_000_000, m: 1_000_000, k: 1_000 };
  const scale = match[2] ? multipliers[match[2].toLowerCase()] ?? 1 : 1;
  const parsed = Math.round(Number(match[1]) * scale);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Error counter from a single interface record, or null when the router printed
 * neither half. `(rx ?? 0) + (tx ?? 0)` on an absent pair is the false zero.
 */
function errorCountFrom(record: Record<string, string>): number | null {
  const rxErrors = integer(record["rx-error"]);
  const txErrors = integer(record["tx-error"]);
  if (rxErrors === null && txErrors === null) return null;
  return (rxErrors ?? 0) + (txErrors ?? 0);
}

/**
 * Merges `:put [/interface/print as-value stats]` records into a name-keyed
 * counter map.
 *
 * A counter is present only when the router actually printed it. An interface
 * the stats read never mentioned is absent from the map entirely, which is what
 * makes "the router did not tell us" distinguishable from "the counter is zero".
 *
 * FIELD ABSENCE IS REAL, and that is why null-not-zero is the storage decision
 * rather than a style preference. Measured on the demo hEX: the bridge slaves
 * `ether2`–`ether5` report `slave=true` and OMIT `rx-error`, `tx-error`,
 * `rx-drop` and `tx-drop` entirely, while `ether1`, `bridge`, `lo` and
 * `wg-ihome-mgmt` carry all four. Storing 0 for a slave would invent an error
 * count the router never claimed, and every downstream rollup reads these as
 * monotonic counters — so the next genuine reading would look like a negative
 * delta.
 */
export function parseInterfaceCounters(
  records: Record<string, string>[],
): Map<string, { rxBytes: number | null; txBytes: number | null; errorCount: number | null }> {
  const counters = new Map<
    string,
    { rxBytes: number | null; txBytes: number | null; errorCount: number | null }
  >();
  for (const record of records) {
    const name = record.name?.trim();
    if (!name) continue;
    counters.set(name, {
      rxBytes: integer(record["rx-byte"]),
      txBytes: integer(record["tx-byte"]),
      errorCount: errorCountFrom(record),
    });
  }
  return counters;
}

function parseBytes(value: string | undefined): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value);
  const match = /^(\d+(?:\.\d+)?)\s*(KiB|MiB|GiB|TiB)$/i.exec(value);
  if (!match?.[1] || !match[2]) return null;
  const powers: Record<string, number> = { kib: 1, mib: 2, gib: 3, tib: 4 };
  return Math.round(Number(match[1]) * 1024 ** (powers[match[2].toLowerCase()] ?? 0));
}

/**
 * Seconds per RouterOS duration unit.
 *
 * `ms`/`us`/`ns` MUST be matched before `m`/`s`. The parser this replaced used
 * `/(\d+)m/` and therefore read `450ms` as 450 MINUTES — a 60 000x overstatement.
 */
const ROUTER_OS_DURATION_UNIT_SECONDS: Readonly<Record<string, number>> = Object.freeze({
  w: 604_800,
  d: 86_400,
  h: 3_600,
  m: 60,
  s: 1,
  ms: 1e-3,
  us: 1e-6,
  ns: 1e-9,
});

/** Sticky so the suffix run must be consumed left-to-right with no gaps. */
const ROUTER_OS_DURATION_UNIT = /(\d+(?:\.\d+)?)(ms|us|ns|w|d|h|m|s)/y;

/**
 * The trailing `HH:MM:SS[.frac]` clock, with whatever `<n>w<n>d` prefix RouterOS
 * put in front of it captured separately.
 */
const ROUTER_OS_DURATION_CLOCK = /^(.*?)(\d+):([0-5]\d):([0-5]\d(?:\.\d+)?)$/;

/**
 * Parses a RouterOS duration into seconds.
 *
 * ## RouterOS emits TWO renderings of the same value, and both reach this worker
 *
 * Measured on the demo hEX (7.20.8) on 2026-08-03, same router, same session:
 *
 *   - `:put [/system/resource get uptime]`                     -> `1w3d15:41:57`
 *   - `:put [/ip/dhcp-client/print as-value  proplist=…]`      -> `expires-after=20:43:44`
 *   - `/ip/dhcp-client/print detail terse`                     -> `expires-after=20h43m44s`
 *   - `/ip/dhcp-server/lease/print terse     proplist=…`       -> `age=2d5h16m expires-after=29m4s`
 *   - `:put [/ip/dhcp-server/lease/print as-value proplist=…]` -> `age=2d05:16:00 expires-after=00:29:04`
 *
 * So `as-value` (the `:put […]` reads) renders `[<n>w][<n>d]HH:MM:SS` and `terse`
 * renders the suffix run `2d5h16m` — for the SAME property. `:totime` confirms
 * the clock half is always present and always zero-padded in the first form:
 * `0 -> 00:00:00`, `45 -> 00:00:45`, `3600 -> 01:00:00`, `86400 -> 1d00:00:00`,
 * `604800 -> 1w00:00:00`, `1234567 -> 2w06:56:07`, `99999999 -> 165w2d09:46:39`.
 * Sub-second values append a fraction to the seconds field rather than using a
 * unit: `00:00:00.500`, `00:00:00.001`, `00:00:00.000001`.
 *
 * The parser this replaced matched only `(\d+)w|d|h|m|s`, so the ENTIRE clock
 * half was dropped: `1w3d15:41:57` parsed as 864000 — day-truncated, and stuck
 * at exactly that value across 151 consecutive production samples spanning
 * 2 h 46 m. Everything downstream that measured elapsed time from it was
 * therefore reading a clock that never moved.
 *
 * ## Unparseable is `null`, never `0`
 *
 * The old parser returned 0 for any unrecognised string, which is
 * indistinguishable from "just rebooted" — and RouterOS refusals arrive on
 * stdout with exit code 0, so an unrecognised value is a live possibility, not a
 * theoretical one. Callers must decide what an absent measurement means.
 */
export function parseDurationSeconds(value: string | undefined): number | null {
  if (!value) return null;
  const text = value.trim().toLowerCase();
  if (!text) return null;
  // Already seconds. Kept from the previous parser: internal callers and stored
  // observations hand this function a plain count.
  if (/^\d+$/.test(text)) return Number(text);

  let total = 0;
  let head = text;

  const clock = ROUTER_OS_DURATION_CLOCK.exec(text);
  if (clock?.[2] !== undefined && clock[3] !== undefined && clock[4] !== undefined) {
    total += Number(clock[2]) * 3_600 + Number(clock[3]) * 60 + Number(clock[4]);
    head = clock[1] ?? "";
  }

  let index = 0;
  while (index < head.length) {
    ROUTER_OS_DURATION_UNIT.lastIndex = index;
    const unit = ROUTER_OS_DURATION_UNIT.exec(head);
    // Anything the grammar does not cover makes the whole value unparseable.
    // Guessing a number out of a string RouterOS did not promise is how the
    // day-truncation survived 151 samples without anyone noticing.
    if (!unit || unit.index !== index || unit[1] === undefined || unit[2] === undefined) return null;
    total += Number(unit[1]) * (ROUTER_OS_DURATION_UNIT_SECONDS[unit[2]] ?? 0);
    index = ROUTER_OS_DURATION_UNIT.lastIndex;
  }

  // Reaching here means either the clock matched or every character of `head`
  // was consumed by a unit token, so `total` is always a real measurement.
  return total;
}

/**
 * `network_client_current.session_key` and `network_client_sessions.session_key`
 * are both `CHECK (char_length(btrim(session_key)) BETWEEN 8 AND 200)`, and the
 * worker builds them as `dhcp:` + the lease's own identity. Five of the eight
 * characters are therefore already spent before the identity is appended.
 */
const MIN_SESSION_KEY_SOURCE_LENGTH = 3;

/**
 * Absent, blank or whitespace-only all mean "the router did not report this".
 * RouterOS omits keys it has no value for, but a value that trims to nothing is
 * indistinguishable from absence and must not be allowed to become an identity.
 */
function blankToNull(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
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

/**
 * RouterOS reports a dynamic row with the `D` flag in `print detail terse`, and
 * with `dynamic=yes` where the menu exposes it as a property. Both are checked.
 */
function isDynamicRecord(record: Record<string, string>): boolean {
  return hasFlag(record, "D") || boolean(record.dynamic);
}

/**
 * The bootstrap's own `…:lan-recovery` rules, and only those.
 *
 * Dynamic rows are excluded because everything downstream reads this list in the
 * fail-OPEN direction: a matched rule is what SUPPLIES the deployment ownership
 * marker and what marks an interface protected, so a row that got in here is a
 * row the worker then trusts. The bootstrap writes this rule statically and its
 * preflight, its rollback and the router-side cycle guard all select it with
 * `and !dynamic`; this is the same scope, applied to the read side.
 */
function ownedRecoveryRules(
  records: Record<string, string>[],
): Array<{ interfaceName: string; ownershipMarker: string }> {
  return records.flatMap((record) => {
    const interfaceName = record["in-interface"]?.trim();
    const ownershipMarker = RECOVERY_RULE_MARKER.exec(record.comment ?? "")?.[1];
    return record.chain === "input"
      && record.action === "accept"
      && !isDynamicRecord(record)
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

function interfaceKind(type: string): InterfaceKind {
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
  #dnsCommandAck = false;
  /** Guard job this connector armed and has not seen the router reap or cancel. */
  #pendingCycleGuardJobId: string | null = null;
  /**
   * Set when a cycle mutated the router but the worker never learned the guard's id,
   * so this connector can no longer prove it is not stacking guards.
   */
  #cycleGuardIdUnknown = false;
  /**
   * The managed port this connector saw the *router itself* report as disabled, from
   * the ordered `NC_CYCLE_DISABLED` readback. Set whether or not the rest of the cycle
   * went on to succeed — the transition is what a postcondition needs, and it is the
   * interrupted cycle that has nothing else to prove it with.
   */
  #observedPortDisable: {
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

  /**
   * Runs one command and reports how it ended *without* throwing, so a caller that
   * mutated the router can still read the markers the router already printed.
   *
   * `#execute` throws away the output of a failed command, which is the right default
   * for a read. It is the wrong default for the port cycle: the router prints
   * `NC_CYCLE_DISABLED` before it starts sleeping, so the one path where durable
   * evidence matters most — a session that dies inside the `:delay` — is exactly the
   * path where that marker had already reached the worker.
   */
  async #executeDetailed(command: string, mayHaveExecuted = false): Promise<RouterExecOutcome> {
    const client = await this.#connect();
    return new Promise<RouterExecOutcome>((resolve) => {
      client.exec(command, (error: Error | undefined, channel: ClientChannel) => {
        if (error) {
          resolve({
            output: "",
            completed: false,
            failure: new RouterOperationError("SSH_EXEC_START_FAILED", {
              retryable: true,
              mayHaveExecuted,
            }),
          });
          return;
        }
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let bytes = 0;
        let settled = false;
        const settle = (outcome: RouterExecOutcome) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(outcome);
        };
        const delivered = () => Buffer.concat(stdout).toString("utf8");
        const collect = (target: Buffer[]) => (data: Buffer | string) => {
          const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
          bytes += buffer.byteLength;
          if (bytes > MAX_COMMAND_OUTPUT_BYTES) {
            channel.close();
            settle({
              output: "",
              completed: false,
              failure: new RouterOperationError("SSH_OUTPUT_LIMIT", {
                retryable: false,
                mayHaveExecuted,
              }),
            });
            return;
          }
          target.push(buffer);
        };
        const timer = setTimeout(() => {
          channel.close();
          settle({
            output: delivered(),
            completed: false,
            failure: new RouterOperationError("SSH_COMMAND_TIMEOUT", {
              retryable: true,
              mayHaveExecuted,
            }),
          });
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
        channel.once("close", (code?: number | null) => {
          const status = exitObserved ? exitStatus : code;
          const output = delivered();
          if (typeof status !== "number" || !Number.isFinite(status)) {
            settle({
              output,
              completed: false,
              failure: new RouterOperationError("SSH_EXEC_NO_EXIT_STATUS", {
                retryable: true,
                mayHaveExecuted,
              }),
            });
            return;
          }
          const rejected = (code: string, message?: string) => settle({
            output,
            completed: true,
            failure: new RouterOperationError(code, {
              retryable: false,
              mayHaveExecuted,
              ...(message === undefined ? {} : { message }),
            }),
          });
          if (status !== 0) {
            rejected("ROUTEROS_COMMAND_FAILED");
            return;
          }
          if (stderr.length > 0 && Buffer.concat(stderr).toString("utf8").trim()) {
            rejected("ROUTEROS_COMMAND_REJECTED");
            return;
          }
          const refusal = routerOsFailureLine(output);
          if (refusal !== null) {
            // The router's own words, so the recorded failure names the cause.
            rejected("ROUTEROS_COMMAND_REJECTED", refusal);
            return;
          }
          settle({ output, completed: true, failure: null });
        });
      });
    });
  }

  async #execute(command: string, mayHaveExecuted = false): Promise<string> {
    const outcome = await this.#executeDetailed(command, mayHaveExecuted);
    if (outcome.failure) throw outcome.failure;
    return outcome.output;
  }

  // There is deliberately no `#sftp()` here any more. The worker opens NO SFTP
  // session on any router: the only thing it ever fetched that way was the
  // binary `.backup`, whose download is gated on the `sensitive` policy (perfect
  // correlation across seven measured identities), and the redacted export now
  // arrives on the command channel. That is what lets `ftp` leave the managed
  // group entirely — see WORKER_GROUP_POLICIES in scripts/generate-router-bootstrap.mjs.

  /**
   * Reads the interface byte/error counters, tolerating a router that cannot
   * answer.
   *
   * This is the ONE read in `poll()` that is allowed to come back empty, because
   * the `stats` print modifier is the only place RouterOS keeps these counters
   * and the exact spelling has not been exercised against every firmware in the
   * fleet. A refusal here must not take a whole poll cycle down — it must leave
   * the counters unset, so the sample says "not collected" instead of "zero".
   *
   * Parsed with `parseRouterOsValueRecords`, NOT `parseRouterOsRecords`: the
   * as-value answer is one line holding every interface, so the line-oriented
   * parser would return a single merged record. Needs only the `read` policy —
   * measured identical output under `ssh,read` and under the `sensitive`-bearing
   * set, so nothing about the counters justifies a wider credential.
   */
  async #readInterfaceCounters(): Promise<
    Map<string, { rxBytes: number | null; txBytes: number | null; errorCount: number | null }>
  > {
    const outcome = await this.#executeDetailed(ROUTER_OS_READ_COMMANDS.interfaceStats);
    if (outcome.failure || !outcome.completed) return new Map();
    return parseInterfaceCounters(parseRouterOsValueRecords(outcome.output));
  }

  async poll(): Promise<RouterObservation> {
    const [
      identityOutput,
      resourceOutput,
      interfaceOutput,
      interfaceCounters,
      dhcpOutput,
      leaseOutput,
      neighborOutput,
      firewallOutput,
    ] =
      await Promise.all([
        this.#execute(ROUTER_OS_READ_COMMANDS.identity),
        this.#execute(ROUTER_OS_READ_COMMANDS.resource),
        this.#execute(ROUTER_OS_READ_COMMANDS.interfaces),
        this.#readInterfaceCounters(),
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
      // NEVER fall back to another field here. The previous
      // `record.rate ?? record["link-downs"]` silently stored the link-flap
      // counter as a line speed on every real router, because RouterOS 7.20.8
      // prints no `rate` at all.
      const speed = parseLinkSpeedBps(record.rate);
      const counters = interfaceCounters.get(name);
      const metadata: JsonObject = { interfaceKind: interfaceKind(type), sortOrder: index };
      if (record["mac-address"]) metadata.macAddress = record["mac-address"];
      if (speed !== null) metadata.nominalSpeedBps = speed;
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
          // `satisfies` and not a bare literal: `sample` is a JsonObject, so
          // without it this field is only `string` - the same hole that let the
          // two client literals through.
          linkState: (state.running ? "UP" : "DOWN") satisfies InterfaceLinkState,
          // null, not 0. A zero here is indistinguishable from a genuinely idle
          // interface, and every downstream rollup treats the series as a
          // monotonic counter, so a fabricated zero manufactures a negative
          // delta on the next real reading. The column is nullable end to end
          // (network_interface_current.rx_bytes/tx_bytes/error_count and the
          // ingest recordset all accept NULL), so "not collected" is
          // representable without a schema change.
          rxBytes: counters?.rxBytes ?? integer(record["rx-byte"]),
          txBytes: counters?.txBytes ?? integer(record["tx-byte"]),
          errorCount: counters?.errorCount ?? errorCountFrom(record),
          ...metadata,
        },
      };
    });

    const clients: RouterClientObservation[] = parseRouterOsRecords(leaseOutput).map((record, index) => {
      // `?? null` is not enough here, and the difference is another whole-batch
      // rollback. A BLANK value is not null, so `?? null` kept it, `mac ?? address`
      // then chose it, and `sessionKey` became the 5-character `"dhcp:"` against
      // `CHECK (char_length(btrim(session_key)) BETWEEN 8 AND 200)`. Blank means
      // absent, so the key falls through to the `lease-N` form, which always
      // clears the floor.
      const mac = blankToNull(record["mac-address"])?.toLowerCase() ?? null;
      const address = blankToNull(record.address);
      // observed_mac is cast to `macaddr` by the ingest RPC, so a value Postgres
      // cannot parse is a 22P02 with exactly the blast radius of a 23514. An
      // unparseable MAC is reported as not-observed; it still identifies the row.
      const observedMac = mac !== null && HARDWARE_MAC.test(mac) ? mac : null;
      // The router's own identity for the lease, preferred in that order - but
      // only if it can carry a legal session key. `dhcp:` is 5 characters and the
      // floor is 8, so a source shorter than 3 characters is not usable as one.
      const key = [mac, address].find(
        (candidate): candidate is string =>
          candidate !== null && candidate.length >= MIN_SESSION_KEY_SOURCE_LENGTH,
      ) ?? `lease-${index}`;
      return {
        externalKey: key,
        deviceId: this.#connection.deviceId,
        sessionKey: `dhcp:${key}`,
        clientFingerprint: createHash("sha256").update(key).digest("hex"),
        observedMac,
        observedIp: address,
        hostname: blankToNull(record["host-name"]),
        // These two were SWAPPED, and neither value was legal where it stood.
        //
        // `connection_type` is the MEDIUM (UNKNOWN/ETHERNET/WIFI/VPN) and
        // `session_type` is HOW the address was handed out
        // (UNKNOWN/DHCP/HOTSPOT/STATIC/ARP). A DHCP lease record proves the
        // second and says nothing at all about the first:
        // `/ip/dhcp-server/lease/print detail terse` carries no
        // ethernet/wireless discriminator, so UNKNOWN here is the observation
        // the router actually supports - and it is the column's own DEFAULT and
        // the ingest RPC's own coalesce target, i.e. the schema's word for "not
        // observed". Guessing ETHERNET would be a fabricated medium.
        //
        // `LEASE` was never a telemetry value in any version of this schema: the
        // only CHECK constraint in the database that admits it is
        // `network_client_links.source`, which the ingest never writes.
        connectionType: "UNKNOWN",
        sessionType: "DHCP",
        firstSeenAt: now,
        lastSeenAt: now,
        expiresAt: leaseExpiryIso(
          now,
          record["expires-after"],
          this.#connection.pollIntervalSeconds * 3,
        ),
        randomizedMac: observedMac !== null
          && ["2", "6", "a", "e"].includes(observedMac[1] ?? ""),
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
      healthStatus: "HEALTHY" satisfies DeviceHealthStatus,
      identity: identity.name ?? this.#connection.displayName,
      routerosVersion: resource.version ?? null,
      uptimeSeconds: parseDurationSeconds(resource.uptime),
      cpuPct: percentage(resource["cpu-load"]),
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

  /**
   * Captures the pre-action snapshot as a REDACTED TEXT EXPORT read off stdout.
   *
   * ## Why the binary `.backup` is gone
   *
   * It could never be made to work by any credential this hardening is willing
   * to issue. Measured on the demo hEX (7.20.8), each row a freshly created
   * throwaway identity, each with a `:put "CHANNEL_OK"` control in the same run:
   *
   *   - `/system/backup/save` requires `policy` AND `test` — not `write`, not
   *     `ftp`, not `sensitive`. The group deployed in production today
   *     (`ssh,ftp,reboot,read,write,test,sensitive`) lacks `policy`, so it
   *     answers `Failed to save system configuration backup` and writes 0 files.
   *     Reproduced three times: the pre-action backup is ALREADY broken on the
   *     live worker credential, before any hardening.
   *   - downloading a `.backup` over SFTP requires `sensitive` — perfect
   *     correlation across seven identities, with a `.rsc` fetch succeeding in
   *     every one of them as the channel control.
   *   - a `policy`-holding, `!sensitive` user SET ITS OWN GROUP to add
   *     `sensitive` and then read the WireGuard private key in full on a fresh
   *     login (`:len` 5 in-session, 44 after reconnect).
   *
   * So the smallest policy set that completes a binary backup is strictly wider
   * than the one deployed today and hands over both of the capabilities this
   * work exists to remove. There is no tunable middle.
   *
   * ## Why a text export is the right replacement, not a weaker one
   *
   * None of the actions this snapshot precedes mutates state that only a binary
   * image can restore: `FLUSH_DNS_CACHE` and `RENEW_DHCP_LEASE` change no
   * configuration at all, `REBOOT_ROUTER` changes none either, and
   * `CYCLE_ACCESS_PORT` toggles one interface's `disabled` flag behind a
   * router-side dead-man switch that restores it without the worker. The
   * documented rollback path is `/import router-rollback.rsc` over the LAN
   * recovery session; the binary was already only step 6, "when the rollback
   * script is not enough".
   *
   * The text export also downloads for EVERY identity measured and needs only
   * `read` (8455 B under `ssh,read`), so the credential narrows instead of
   * widening. And it is arguably safer at rest than what it replaces: the
   * `.backup` provably contained the WireGuard private key as base64 at a fixed
   * offset, encrypted with a password THE WORKER ITSELF HOLDS, whereas
   * `hide-sensitive` strips the key before it ever leaves the router (0
   * occurrences of `private-key=` in 8133 B).
   *
   * ## The trade-off, stated rather than buried
   *
   * A text export cannot restore binary-only state that a `.backup` image can —
   * certificates and their private keys, SSH host keys, the WireGuard private
   * key, user password hashes. Under `hide-sensitive` those are absent by
   * construction, so a router rebuilt from this artifact alone comes back
   * WITHOUT its management tunnel identity and must be re-bootstrapped. That is
   * written into DEMO-ROUTER-RUNBOOK.md §9 and must not be discovered during an
   * incident.
   *
   * No router-side file is created, so there is no `/file/remove` cleanup and
   * nothing to leave behind when a session dies mid-capture.
   */
  async captureBackup(): Promise<RouterBackup> {
    // Fails CLOSED, unlike the counters read: a refusal here throws
    // ROUTEROS_COMMAND_REJECTED and the action never runs. A pre-action snapshot
    // that quietly captured nothing is exactly the defect this replaces.
    const redactedExport = await this.#execute(ROUTER_OS_EXPORT_COMMAND);
    await mkdir(this.#backupStagingDirectory, { recursive: true, mode: 0o700 });
    const localPath = resolve(
      this.#backupStagingDirectory,
      `nc-${randomBytes(12).toString("hex")}.rsc.part`,
    );
    if (!localPath.startsWith(`${this.#backupStagingDirectory}${sep}`)) {
      throw new RouterOperationError("ROUTER_EXPORT_STAGING_PATH_INVALID", {
        retryable: false,
        mayHaveExecuted: false,
      });
    }
    const artifact = await stageExportTextBounded(redactedExport, {
      destinationPath: localPath,
    });
    return { artifact, redactedExport };
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
      const expiresInSeconds = bound ? parseDurationSeconds(bound["expires-after"]) : null;
      return {
        observedAt,
        reachable: parseRouterOsRecords(identityOutput).length > 0,
        dhcp: bound
          ? {
            leaseKey: bound[".id"] ?? bound.interface ?? "wan-dhcp",
            status: "bound",
            // Same fail-closed rule as `boot` above: an unreadable
            // `expires-after` used to become 0, and 0 is the smallest possible
            // "before", so a garbled PRE_ACTION read made every later reading
            // look like a successful renewal. Omitting the field leaves the
            // verdict UNCERTAIN in the worker and in the settle function, whose
            // `{dhcp,expiresInSeconds}` regex fails closed identically.
            ...(expiresInSeconds === null ? {} : { expiresInSeconds }),
          }
          : { notApplicable: true },
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
      const cycled = this.#observedPortDisable;
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
      const uptimeSeconds = parseDurationSeconds(resource.uptime);
      // An unreadable uptime used to become `0`, which is exactly what a router
      // that has just rebooted reports — so a garbled or refused read (RouterOS
      // puts refusals on stdout with exit code 0) would have settled
      // REBOOT_ROUTER as SUCCEEDED on no evidence at all. Omitting `boot`
      // instead leaves the verdict UNCERTAIN in the worker AND in
      // `network_center_settle_command`, whose regex on
      // `{boot,uptimeSeconds}` fails closed the same way.
      if (uptimeSeconds === null) {
        return { observedAt, reachable: parseRouterOsRecords(identityOutput).length > 0 };
      }
      // `now - uptime` is the only boot identity RouterOS offers: there is no
      // boot UUID. It is honest ONLY once uptime parses correctly — measured on
      // the demo hEX over 14 reads spanning 52 s, the corrected derivation
      // yields ONE value (spread 0 s) while the day-truncated one yielded 14
      // distinct values drifting 1 s per wall-clock second. Deliberately NOT
      // quantised: a bucket wide enough to absorb tick jitter is also wide
      // enough to collapse a fast reboot's before/after into one bucket, which
      // would resurrect the false-UNCERTAIN this change exists to remove.
      const bootEpochSeconds = Math.floor(this.#now().getTime() / 1_000)
        - Math.round(uptimeSeconds);
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

    // 1. Never stack guards. A previous cycle that died mid-window left a job that is
    //    still counting down to re-enable this port; arming a second one would blur
    //    the disable window and let a retry storm fill the router's job table. The
    //    pending guard is itself the thing that restores the port, so waiting for it
    //    is both the safe and the fast answer.
    if (this.#cycleGuardIdUnknown) {
      // A previous cycle on this connector armed a guard whose router-minted id never
      // came back. Its job is still out there and still owns this port's recovery, so
      // there is nothing left to probe and nothing safe to arm.
      throw new RouterOperationError("PORT_CYCLE_GUARD_STATE_UNREADABLE", {
        retryable: true,
        mayHaveExecuted: false,
      });
    }
    if (this.#pendingCycleGuardJobId) {
      const probe = parseAccessPortCycleGuardProbe(await this.#execute(
        buildAccessPortCycleGuardProbeCommand(this.#pendingCycleGuardJobId),
      ));
      if (!probe) {
        throw new RouterOperationError("PORT_CYCLE_GUARD_STATE_UNREADABLE", {
          retryable: true,
          mayHaveExecuted: false,
        });
      }
      if (probe.pending > 0) {
        throw new RouterOperationError("PORT_CYCLE_GUARD_STILL_PENDING", {
          retryable: true,
          mayHaveExecuted: false,
        });
      }
      this.#pendingCycleGuardJobId = null;
    }

    // 2. Arm the dead-man's switch and cycle the port in one console job. Everything
    //    that can refuse still runs before the disable, so a refusal stays a clean,
    //    non-disruptive failure — but the guard's countdown and the disable now share
    //    one anchor, so no SSH round trip can be subtracted from the recovery window.
    //    The guard's id is minted by the router, so the worker can only ever cancel a
    //    job it started itself.
    this.#observedPortDisable = null;
    const attempt = await this.#executeDetailed(
      buildAccessPortCycleCommand(cycleTarget, durationSeconds),
      true,
    );
    const guardJobId = parseAccessPortCycleArmedGuard(attempt.output, resolved.immutableKey);
    if (guardJobId) this.#pendingCycleGuardJobId = guardJobId;
    const markers = routerOsMarkers(attempt.output);
    const disabledIndex = markers.indexOf(`NC_CYCLE_DISABLED:${resolved.immutableKey}`);
    if (disabledIndex >= 0) {
      // The router printed its own disable readback, so the port demonstrably went
      // down. Recorded here rather than after the cycle returns, because the session
      // that dies inside the `:delay` never reaches "after".
      this.#observedPortDisable = {
        managedResourceId: target.managedResourceId,
        immutableKey: resolved.immutableKey,
      };
    }

    // 3. A failure is classified by where the router stopped, not by which exec it
    //    was in. `NC_CYCLE_ARMED` is printed by the statement immediately before the
    //    disable, so on a channel that closed with an exit status its absence proves
    //    the port was never touched. A dead channel proves nothing and stays uncertain.
    if (attempt.failure) {
      if (!guardJobId && !attempt.completed) this.#cycleGuardIdUnknown = true;
      throw new RouterOperationError(attempt.failure.code, {
        retryable: attempt.failure.retryable,
        mayHaveExecuted: !attempt.completed || guardJobId !== null,
      });
    }

    // Success still turns on the ordered disable/enable readback only.
    const enabledIndex = markers.indexOf(`NC_CYCLE_ENABLED:${resolved.immutableKey}`);
    if (disabledIndex < 0 || enabledIndex <= disabledIndex) {
      throw new RouterOperationError("PORT_CYCLE_EVIDENCE_MISSING", {
        retryable: true,
        mayHaveExecuted: true,
      });
    }

    // 4. The port is provably back up, so cancelling the guard is pure hygiene and is
    //    kept in its own exec: a refused or racing `remove` must never demote a cycle
    //    that succeeded. A guard that survives only re-enables an already-enabled port
    //    and then exits by itself, and it stays recorded so the next cycle waits it out.
    if (!guardJobId) {
      // The cycle is proven, so it must not be failed — but without the guard's id the
      // job can only be left to expire, and no further cycle may share this connector.
      this.#cycleGuardIdUnknown = true;
      return;
    }
    try {
      if (parseAccessPortCycleDisarmed(
        await this.#execute(buildAccessPortCycleDisarmCommand(guardJobId)),
      )) this.#pendingCycleGuardJobId = null;
    } catch {
      // Intentionally non-fatal, and intentionally leaves the guard recorded.
    }
  }

  /**
   * The managed access port this connector saw the router report as disabled, or null.
   *
   * Deliberately reports only the *disable* half of a cycle. Whether the port is up
   * again is a live read every time (`observeAction`), never a remembered or stored
   * fact, so nothing here can manufacture a completed cycle on its own.
   */
  observedPortDisable(): { managedResourceId: string; immutableKey: string } | null {
    return this.#observedPortDisable;
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
      // A REFUSAL is the opposite case, and it must not inherit `mayHaveExecuted`.
      // `/system/reboot` is a single statement: if the router answered on a completed
      // channel that it refused the command, the router demonstrably did not reboot.
      // Reported as UNCERTAIN it would lock the device out of every later command
      // (including REBOOT_ROUTER) until a human retires it, and pause the building —
      // for something that provably never happened. Terminal FAILED, carrying the
      // router's own refusal text, is the legible outcome.
      //
      // Scoped to reboot deliberately: a multi-statement command such as the port
      // cycle can be refused at a later statement with earlier ones already applied,
      // so `mayHaveExecuted` stays true there.
      if (
        error instanceof RouterOperationError
        && error.code === "ROUTEROS_COMMAND_REJECTED"
      ) {
        throw new RouterOperationError("ROUTEROS_COMMAND_REJECTED", {
          retryable: false,
          mayHaveExecuted: false,
          message: error.message,
        });
      }
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
