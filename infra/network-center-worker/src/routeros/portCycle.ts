/**
 * Access-port cycle scripting.
 *
 * A port cycle disables a tenant's access port, waits, then enables it again. The
 * enable MUST NOT depend on the SSH session surviving: a container SIGKILL, an OOM
 * kill, a WireGuard reset or a host reboot during the wait would otherwise leave the
 * port disabled with no code path anywhere able to restore it.
 *
 * The router therefore arms its own dead-man's switch first — a one-shot
 * `/system/scheduler` entry that re-enables the port and then removes itself. Only
 * after the guard is verifiably armed does the worker disable anything. On the happy
 * path the worker enables the port explicitly and removes the guard, leaving no
 * residue.
 *
 * The guard carries the repository's ownership-marker convention
 * (`ihomecrm-network-center:v1:<deploymentId>:<scope>`, see
 * `templates/router-bootstrap.rsc.tmpl` and `scripts/generate-router-bootstrap.mjs`)
 * so it can never be confused with, or clobber, an operator's own scheduler entry.
 */

export const MIN_ACCESS_PORT_CYCLE_SECONDS = 5;
export const MAX_ACCESS_PORT_CYCLE_SECONDS = 30;

/**
 * Head-room between the intended disable window and the moment the router-side guard
 * fires. The worker normally re-enables well inside it, so the guard stays a fallback.
 */
export const ACCESS_PORT_CYCLE_GUARD_GRACE_SECONDS = 15;

/** Head-room the SSH command timeout must keep on top of the router-side delay. */
export const ACCESS_PORT_CYCLE_TIMEOUT_MARGIN_MS = 15_000;

/** Smallest SSH command timeout that can still outlive the longest allowed cycle. */
export const MINIMUM_COMMAND_TIMEOUT_MS =
  MAX_ACCESS_PORT_CYCLE_SECONDS * 1_000 + ACCESS_PORT_CYCLE_TIMEOUT_MARGIN_MS;

/**
 * Namespaced managed name. Bare-word safe on purpose: the guard's own `on-event`
 * script refers to it, and keeping it free of quotes avoids nested string escaping.
 */
export const ACCESS_PORT_CYCLE_GUARD_NAME = "ihomecrm-network-center-v1-port-cycle";

/** Ownership-marker scope appended to the router's deployment marker. */
export const ACCESS_PORT_CYCLE_GUARD_SCOPE = "port-cycle";

/** Strict subset of the managed group's policy (ssh,ftp,reboot,read,write,test,sensitive). */
export const ACCESS_PORT_CYCLE_GUARD_POLICY = "read,write";

const ROUTEROS_RESOURCE_ID = /^\*[0-9A-Fa-f]+$/;
const PHYSICAL_ACCESS_PORT = /^ether(?:[2-9]|[1-9][0-9])$/i;

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

/**
 * Quotes a script that will be *stored* as a RouterOS string literal and executed
 * later (a scheduler `on-event`). RouterOS interpolates `$` inside string literals and
 * only understands a small set of escapes, so both `$` and `\` are rejected outright
 * rather than escaped; the generated body never needs either.
 */
export function quoteRouterOsScript(value: string): string {
  if (
    value.length < 1
    || value.length > 512
    || /[^\x20-\x7e]/.test(value)
    || /["\\$]/.test(value)
  ) {
    throw new TypeError("RouterOS script contains unsafe characters");
  }
  return `"${value}"`;
}

function assertResourceId(value: string): string {
  if (!ROUTEROS_RESOURCE_ID.test(value)) {
    throw new TypeError("RouterOS resource id is invalid");
  }
  return value;
}

function assertImmutableKey(value: string): string {
  if (!PHYSICAL_ACCESS_PORT.test(value)) {
    throw new TypeError("Managed access port immutable key is invalid");
  }
  return value;
}

export function accessPortCycleGuardComment(ownershipMarker: string): string {
  return `${ownershipMarker}:${ACCESS_PORT_CYCLE_GUARD_SCOPE}`;
}

export function accessPortCycleGuardIntervalSeconds(durationSeconds: number): number {
  return durationSeconds + ACCESS_PORT_CYCLE_GUARD_GRACE_SECONDS;
}

export interface AccessPortCycleTarget {
  /** RouterOS internal id of the managed port, e.g. `*B`. */
  resourceId: string;
  /** Operator-visible name at the time of resolution. */
  currentName: string;
  /** Immutable `default-name`, e.g. `ether4`. */
  immutableKey: string;
  /** `ihomecrm-network-center:v1:<deploymentId>` read back from the router itself. */
  ownershipMarker: string;
}

function portSelector(target: AccessPortCycleTarget): string {
  return `[/interface/find where .id=${assertResourceId(target.resourceId)}`
    + ` and name=${quoteRouterOsValue(target.currentName)}`
    + ` and default-name=${quoteRouterOsValue(assertImmutableKey(target.immutableKey))}]`;
}

function guardSelector(comment: string): string {
  return `[/system/scheduler find where name=${ACCESS_PORT_CYCLE_GUARD_NAME}`
    + ` and comment=${quoteRouterOsValue(comment)}]`;
}

/**
 * Read-only probe. Reports how many entries already hold the managed name and whether
 * the single one is ours, without ever dumping an operator's scheduler scripts.
 */
export function buildAccessPortCycleGuardProbeCommand(comment: string): string {
  return [
    `:local ncGuard [/system/scheduler find where name=${ACCESS_PORT_CYCLE_GUARD_NAME}]`,
    ":put (\"NC_CYCLE_GUARD_COUNT:\" . [:len $ncGuard])",
    ":if ([:len $ncGuard] = 1) do={"
      + `:if ([/system/scheduler get $ncGuard comment] = ${quoteRouterOsValue(comment)})`
      + " do={:put \"NC_CYCLE_GUARD_OWNED:true\"}"
      + " else={:put \"NC_CYCLE_GUARD_OWNED:false\"}}",
  ].join("; ");
}

export interface AccessPortCycleGuardProbe {
  count: number;
  owned: boolean;
}

export function parseAccessPortCycleGuardProbe(output: string): AccessPortCycleGuardProbe | null {
  const lines = output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const count = lines
    .flatMap((line) => /^NC_CYCLE_GUARD_COUNT:(\d{1,4})$/.exec(line)?.[1] ?? [])
    .map(Number);
  if (count.length !== 1 || count[0] === undefined) return null;
  const owned = lines.includes("NC_CYCLE_GUARD_OWNED:true");
  if (count[0] === 1 && !owned && !lines.includes("NC_CYCLE_GUARD_OWNED:false")) return null;
  return { count: count[0], owned };
}

/**
 * The script the router runs on its own if the worker never comes back. Deliberately
 * tiny, bare-word only, and bound to the immutable `default-name` so an operator
 * rename during the window cannot redirect it at another interface.
 */
export function buildAccessPortCycleGuardEvent(target: AccessPortCycleTarget): string {
  return `/interface/enable [/interface/find where .id=${assertResourceId(target.resourceId)}`
    + ` and default-name=${assertImmutableKey(target.immutableKey)}];`
    + ` /system/scheduler remove [/system/scheduler find where name=${ACCESS_PORT_CYCLE_GUARD_NAME}]`;
}

/**
 * Arms the dead-man's switch. Mutates nothing on the access port, so a failure here is
 * always a clean, non-disruptive failure.
 */
export function buildAccessPortCycleArmCommand(
  target: AccessPortCycleTarget,
  durationSeconds: number,
): string {
  const comment = accessPortCycleGuardComment(target.ownershipMarker);
  const quotedComment = quoteRouterOsValue(comment);
  return [
    `:local ncPort ${portSelector(target)}`,
    ":if ([:len $ncPort] != 1) do={:error \"managed access port identity changed\"}",
    `:local ncGuard [/system/scheduler find where name=${ACCESS_PORT_CYCLE_GUARD_NAME}]`,
    ":if ([:len $ncGuard] > 1) do={:error \"managed port cycle guard is ambiguous\"}",
    ":if ([:len $ncGuard] = 1) do={"
      + `:if ([/system/scheduler get $ncGuard comment] != ${quotedComment})`
      + " do={:error \"managed port cycle guard is not owned\"}"
      + " else={/system/scheduler remove $ncGuard}}",
    `/system/scheduler add name=${ACCESS_PORT_CYCLE_GUARD_NAME} comment=${quotedComment}`
      + ` interval=${accessPortCycleGuardIntervalSeconds(durationSeconds)}s`
      + ` policy=${ACCESS_PORT_CYCLE_GUARD_POLICY}`
      + ` on-event=${quoteRouterOsScript(buildAccessPortCycleGuardEvent(target))}`,
    `:if ([:len ${guardSelector(comment)}] != 1)`
      + " do={:error \"managed port cycle guard was not armed\"}",
    ":put (\"NC_CYCLE_ARMED:\" . [/interface/get $ncPort default-name])",
  ].join("; ");
}

/**
 * Disables, waits, enables and disarms. Every statement after `:delay` is expendable:
 * if the session dies here the router still restores the port on its own.
 */
export function buildAccessPortCycleCommand(
  target: AccessPortCycleTarget,
  durationSeconds: number,
): string {
  const comment = accessPortCycleGuardComment(target.ownershipMarker);
  const selector = guardSelector(comment);
  return [
    `:local ncPort ${portSelector(target)}`,
    ":if ([:len $ncPort] != 1) do={:error \"managed access port identity changed\"}",
    `:if ([:len ${selector}] != 1) do={:error \"managed port cycle guard is missing\"}`,
    "/interface/disable $ncPort",
    ":if ([/interface/get $ncPort disabled] != true)"
      + " do={:error \"access port disable readback failed\"}",
    ":put (\"NC_CYCLE_DISABLED:\" . [/interface/get $ncPort default-name])",
    `:delay ${durationSeconds}s`,
    "/interface/enable $ncPort",
    ":if ([/interface/get $ncPort disabled] = true)"
      + " do={:error \"access port enable readback failed\"}",
    ":put (\"NC_CYCLE_ENABLED:\" . [/interface/get $ncPort default-name])",
    // Best effort by construction: `remove` on an empty selector is a no-op, so a
    // guard that already fired and removed itself is not an error. Anything that does
    // survive is picked up and replaced by the next cycle's ownership probe, so a
    // stuck guard must never escalate this command into an UNCERTAIN device lockout.
    `/system/scheduler remove ${selector}`,
    ":put (\"NC_CYCLE_DISARMED:\" . [/interface/get $ncPort default-name])",
  ].join("; ");
}
