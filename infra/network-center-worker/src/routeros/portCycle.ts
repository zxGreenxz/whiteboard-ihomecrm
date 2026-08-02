/**
 * Access-port cycle scripting.
 *
 * A port cycle disables a tenant's access port, waits, then enables it again. The
 * enable MUST NOT depend on the SSH session surviving: a container SIGKILL, an OOM
 * kill, a WireGuard reset or a host reboot during the wait would otherwise leave the
 * port disabled with no code path anywhere able to restore it.
 *
 * The router therefore arms its own dead-man's switch first — a background job
 * started with `:execute` that sleeps out the cycle window and then re-enables the
 * port. Only after the guard is verifiably running is anything disabled, and the two
 * happen in the same console job so the guard's countdown and the disable share one
 * anchor (see `buildAccessPortCycleCommand`). On the happy path the worker enables
 * the port explicitly and cancels the job, leaving no residue.
 *
 * ## Why `:execute` and not `/system/scheduler`
 *
 * The fleet's routers run RouterOS device-mode `home` (`/system/device-mode/print`
 * reports `scheduler: no`). There, `/system/scheduler/add` is answered with
 * `failure: not allowed by device-mode (/system/scheduler/add; line 1)` — printed on
 * **stdout, with exit status 0** — for every user including `admin` in group `full`.
 * Leaving that mode needs physical access to each router (power cycle plus the reset
 * button inside a confirmation window), so a scheduler-based guard simply does not
 * exist in production. `:execute` is a console primitive, is not gated by
 * device-mode, runs under the managed user's own restricted policy set, and its job
 * outlives the console job that started it.
 *
 * ## Ownership, with no name to collide over
 *
 * A scheduler entry is a persistent, *named* resource, so the previous design had to
 * prove that the entry holding the managed name was its own. A `:execute` job has no
 * name: the router mints its id and hands it back to the caller, so the worker only
 * ever addresses a job it created itself, in this process, moments earlier. Ownership
 * of the *router* is still proven out of band — the cycle command refuses unless the
 * router still carries this deployment's `…:lan-recovery` firewall rule at the moment
 * it arms, which also closes the gap between reading that rule and using it.
 *
 * ## Overlapping guards
 *
 * A guard can only ever *enable*, and it self-terminates. Two overlapping guards
 * therefore cannot strand a port; the worst they can do is end a later cycle's
 * disable window early. The worker still refuses to arm while its own previous guard
 * is running, so a retry storm can neither stack jobs on the router nor blur the
 * disable window — and the pending guard is itself what restores the port.
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
 * Scope suffix of the bootstrap firewall rule that carries the deployment's
 * ownership marker (see `templates/router-bootstrap.rsc.tmpl`).
 */
export const ROUTER_RECOVERY_RULE_SCOPE = "lan-recovery";

const ROUTEROS_RESOURCE_ID = /^\*[0-9A-Fa-f]{1,16}$/;
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
 * Validates a script that will be handed to `:execute` inside a `{ … }` block. The
 * block is parsed by the console, not stored as a string literal, so the hazard is
 * not escaping but *closing the block early*: a stray `}` would turn the remainder of
 * the guard into statements of the outer command. Quotes, `$` and `\` are rejected
 * too — the generated body never needs any of them, so anything that does is a bug.
 */
export function assertRouterOsScriptBlock(value: string): string {
  if (
    value.length < 1
    || value.length > 512
    || /[^\x20-\x7e]/.test(value)
    || /["\\${}]/.test(value)
  ) {
    throw new TypeError("RouterOS script block contains unsafe characters");
  }
  return value;
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

/**
 * The duration is the only value in this file that reaches the router as a bare
 * number rather than through a quoter or a pattern, so nothing else can catch a
 * bad one: `assertRouterOsScriptBlock` sees `NaN` and `undefined` as ordinary
 * printable ASCII and passes them straight through. Observed on the demo hEX —
 * a call that left `durationSeconds` undefined shipped a script containing
 * `:delay NaNs`, which the router parsed and rejected at runtime, mid-cycle.
 * `commands.ts` bounds the value upstream, so this is defence in depth for every
 * other caller, and it keeps the file consistent with `assertResourceId` and
 * `assertImmutableKey`.
 */
function assertCycleDurationSeconds(value: number): number {
  if (
    typeof value !== "number"
    || !Number.isInteger(value)
    || value < MIN_ACCESS_PORT_CYCLE_SECONDS
    || value > MAX_ACCESS_PORT_CYCLE_SECONDS
  ) {
    throw new TypeError("Managed access port cycle duration is invalid");
  }
  return value;
}

export function accessPortCycleGuardDelaySeconds(durationSeconds: number): number {
  return assertCycleDurationSeconds(durationSeconds)
    + ACCESS_PORT_CYCLE_GUARD_GRACE_SECONDS;
}

export function routerRecoveryRuleComment(ownershipMarker: string): string {
  return `${ownershipMarker}:${ROUTER_RECOVERY_RULE_SCOPE}`;
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

function guardJobSelector(guardJobId: string): string {
  return `[/system/script/job/find where .id=${assertResourceId(guardJobId)}]`;
}

function ownershipRuleSelector(ownershipMarker: string): string {
  return "[/ip/firewall/filter/find where chain=input and action=accept"
    + ` and comment=${quoteRouterOsValue(routerRecoveryRuleComment(ownershipMarker))}]`;
}

/**
 * Read-only probe for a guard this worker armed earlier and never cancelled. It
 * reports nothing about anybody else's jobs, so it can neither leak nor depend on an
 * operator's background work.
 */
export function buildAccessPortCycleGuardProbeCommand(guardJobId: string): string {
  return `:put ("NC_CYCLE_GUARD_PENDING:" . [:len ${guardJobSelector(guardJobId)}])`;
}

export function parseAccessPortCycleGuardProbe(output: string): { pending: number } | null {
  const pending = output.split(/\r?\n/u)
    .map((line) => line.trim())
    .flatMap((line) => /^NC_CYCLE_GUARD_PENDING:(\d{1,4})$/.exec(line)?.[1] ?? [])
    .map(Number);
  return pending.length === 1 && pending[0] !== undefined ? { pending: pending[0] } : null;
}

/**
 * The script the router runs on its own if the worker never comes back. Deliberately
 * tiny, bare-word only, enable-only, and bound to the immutable `default-name` so an
 * operator rename during the window cannot redirect it at another interface.
 *
 * The leading `:delay` is also what makes arming verifiable: the job is guaranteed to
 * still be in `/system/script/job` when the arm command checks for it.
 */
export function buildAccessPortCycleGuardScript(
  target: AccessPortCycleTarget,
  durationSeconds: number,
): string {
  return assertRouterOsScriptBlock(
    `:delay ${accessPortCycleGuardDelaySeconds(durationSeconds)}s;`
    + ` /interface/enable [/interface/find where .id=${assertResourceId(target.resourceId)}`
    + ` and default-name=${assertImmutableKey(target.immutableKey)}]`,
  );
}

/** Returns the router-minted id of the guard job, or null if it was not armed. */
export function parseAccessPortCycleArmedGuard(
  output: string,
  immutableKey: string,
): string | null {
  const armed = output.split(/\r?\n/u)
    .map((line) => line.trim())
    .flatMap((line) => {
      const match = /^NC_CYCLE_ARMED:(\*[0-9A-Fa-f]{1,16}):(.+)$/.exec(line);
      return match?.[1] && match[2] === immutableKey ? [match[1]] : [];
    });
  return armed.length === 1 && armed[0] !== undefined ? armed[0] : null;
}

/**
 * Arms the dead-man's switch and then disables, waits and enables — in one console
 * job, in that order.
 *
 * ## Why arming cannot be its own SSH exec
 *
 * The guard's `:delay` starts the instant the router creates the job, so the recovery
 * window is anchored wherever the `:execute` runs. Arming from a separate exec put an
 * entire SSH round trip between that anchor and the disable, and the round trip is
 * subtracted from the window at both ends:
 *
 *  - a trip longer than `ACCESS_PORT_CYCLE_GUARD_GRACE_SECONDS` let the guard fire
 *    *inside* the disable window, re-enabling the port early. The worker's own enable
 *    then found the port already up, the readback passed, and a cycle the tenant never
 *    saw was reported as healthy;
 *  - a trip longer than the whole window left the guard already reaped, so the cycle
 *    aborted on "guard is missing" — with `mayHaveExecuted` set, i.e. UNCERTAIN, for a
 *    command that had not touched the port at all.
 *
 * Inside one console job the gap between `:execute` and `/interface/disable` is a
 * handful of router-local statements, so no network latency can enter it and neither
 * race has anywhere to happen.
 *
 * Everything that can refuse the cycle still runs *before* the disable, so a refusal
 * remains a clean, non-disruptive failure; `NC_CYCLE_ARMED` is the marker that tells
 * the worker which side of the disable a failure landed on. Every statement from
 * `:delay` onwards is expendable: if the session dies there the router restores the
 * port on its own.
 *
 * `NC_CYCLE_OWNER` is emitted before the guard is started on purpose: any refusal of
 * `:execute` then lands *after* a marker line, which is exactly the shape of failure
 * (`failure: …` on stdout, exit status 0) that a start-anchored output check misses.
 */
export function buildAccessPortCycleCommand(
  target: AccessPortCycleTarget,
  durationSeconds: number,
): string {
  // Asserted here as well as inside the guard script: the two `:delay` values are
  // separate interpolations, and this one must not depend on the order in which
  // the array literal below happens to be evaluated.
  assertCycleDurationSeconds(durationSeconds);
  return [
    `:local ncPort ${portSelector(target)}`,
    ":if ([:len $ncPort] != 1) do={:error \"managed access port identity changed\"}",
    `:if ([:len ${ownershipRuleSelector(target.ownershipMarker)}] < 1)`
      + " do={:error \"managed router ownership marker is missing\"}",
    ":put (\"NC_CYCLE_OWNER:\" . [/interface/get $ncPort default-name])",
    ":local ncGuard [:execute script="
      + `{${buildAccessPortCycleGuardScript(target, durationSeconds)}}]`,
    ":if ([:len [/system/script/job/find where .id=$ncGuard]] != 1)"
      + " do={:error \"managed port cycle guard was not armed\"}",
    ":put (\"NC_CYCLE_ARMED:\" . [:tostr $ncGuard] . \":\""
      + " . [/interface/get $ncPort default-name])",
    "/interface/disable $ncPort",
    ":if ([/interface/get $ncPort disabled] != true)"
      + " do={:error \"access port disable readback failed\"}",
    ":put (\"NC_CYCLE_DISABLED:\" . [/interface/get $ncPort default-name])",
    `:delay ${durationSeconds}s`,
    "/interface/enable $ncPort",
    ":if ([/interface/get $ncPort disabled] = true)"
      + " do={:error \"access port enable readback failed\"}",
    ":put (\"NC_CYCLE_ENABLED:\" . [/interface/get $ncPort default-name])",
  ].join("; ");
}

/**
 * Cancels the guard once the worker has restored the port itself.
 *
 * Deliberately its own exec, and deliberately expressed against a `find` selector.
 * A guard that already fired has left the job table, so removing it must be a no-op
 * rather than a `failure: no such item` — and a refusal to remove must not be able to
 * turn a cycle whose port is provably back up into a failed or UNCERTAIN command.
 */
export function buildAccessPortCycleDisarmCommand(guardJobId: string): string {
  return [
    `/system/script/job/remove ${guardJobSelector(guardJobId)}`,
    `:put ("NC_CYCLE_DISARMED:" . [:len ${guardJobSelector(guardJobId)}])`,
  ].join("; ");
}

/** True only when the router confirmed the guard job is gone. */
export function parseAccessPortCycleDisarmed(output: string): boolean {
  return output.split(/\r?\n/u)
    .map((line) => line.trim())
    .includes("NC_CYCLE_DISARMED:0");
}
