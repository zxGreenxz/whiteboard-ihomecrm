import type { OpenClawAccountSummary, OpenClawControlState } from "./types";

/**
 * The ceiling the UI will display for a QR code, matching the plan's 120-second
 * window. It is a CEILING, not the source of truth: the countdown is derived from
 * the ticket's own issuedAt/expiresAt so a server that shortens the lifetime takes
 * effect immediately.
 */
export const QR_TTL_SECONDS = 120;

/** True when a ticket outlives the documented window, which is worth surfacing. */
export function qrLifetimeIsAnomalous(secondsLeft: number) {
  return secondsLeft > QR_TTL_SECONDS;
}

function epoch(timestamp: string): number | null {
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : null;
}

/**
 * Whole seconds left before `expiresAt`, floored at 0.
 *
 * NOT clamped at the top. An earlier version returned `min(seconds, 120)` and
 * claimed that stopped an over-long ticket from parking a QR on screen - it did
 * not: expiry is driven by the real `expiresAt`, so a one-hour ticket sat there for
 * an hour while the UI confidently displayed a frozen "120s". The clamp turned a
 * visible anomaly into an invisible one. Callers that want the ceiling enforced
 * should compare against {@link QR_TTL_SECONDS} and act, not hide the number.
 *
 * An unparseable timestamp counts as expired: the safe reading of "I cannot tell
 * when this dies" is "it is already dead".
 */
export function qrCountdownSeconds(expiresAt: string, now: string): number {
  const end = epoch(expiresAt);
  const current = epoch(now);
  if (end === null || current === null) return 0;
  const seconds = Math.floor((end - current) / 1000);
  return seconds <= 0 ? 0 : seconds;
}

export type DisclosureReason = "VERSION_MOVED" | "NEVER_ACKNOWLEDGED" | null;

export interface DisclosureState {
  acknowledged: boolean;
  /** The version the acknowledge RPC must be given; it raises 40001 on a mismatch. */
  versionToAcknowledge: number;
  reason: DisclosureReason;
}

/**
 * Whether the operator still owes an acknowledgement before a QR may be requested.
 *
 * Mirrors exactly what `openclaw_begin_qr_login_v1` enforces:
 * `disclosure_acknowledged_version <> disclosure_version or disclosure_acknowledged_at is null`.
 *
 * An earlier version also re-armed on a LIMITED session forcing a reconnect. That
 * was an INVENTED LOCKOUT: nothing in the migration set ever writes
 * `session_risk_state = 'LIMITED'`, the acknowledge RPC touches neither
 * session_risk_state nor connection_state, and the gate therefore could never be
 * satisfied - the operator acknowledged, the account came back unchanged, and the
 * button stayed disabled with no way out through the UI.
 */
export function disclosureState(account: OpenClawAccountSummary): DisclosureState {
  const versionToAcknowledge = account.disclosureVersion;
  if (account.disclosureAcknowledgedVersion === null) {
    return { acknowledged: false, versionToAcknowledge, reason: "NEVER_ACKNOWLEDGED" };
  }
  if (account.disclosureAcknowledgedVersion !== account.disclosureVersion) {
    return { acknowledged: false, versionToAcknowledge, reason: "VERSION_MOVED" };
  }
  return { acknowledged: true, versionToAcknowledge, reason: null };
}

export type QrBlockedBy =
  | "PERMISSION"
  | "ALREADY_CONNECTED"
  | "UNRECOVERABLE_STATE"
  | "NO_READY_CELL"
  | "DISCLOSURE";

export interface QrGateInput {
  account: OpenClawAccountSummary;
  canManageConnections: boolean;
}

export interface QrGateState {
  canRequestQr: boolean;
  blockedBy: QrBlockedBy | null;
  disclosure: DisclosureState;
}

/**
 * The gates a QR request must pass, MIRRORING `openclaw_begin_qr_login_v1`.
 *
 * Read that function before changing anything here. What it actually checks, in
 * order: `require_perm_v1('openclaw_zalo.manage_connections')`, then a
 * `select ... into strict` on the account (`is_active`, `connection_state in
 * ('DISCONNECTED','QR_PENDING')`, no unacknowledged revocation), then a strict
 * select on the cell (`is_current and state = 'READY'`), then one on the lease,
 * then the disclosure comparison.
 *
 * What it does NOT check: `global_stop` and `feature_enabled`. An earlier version
 * of this gate blocked on both and claimed to be "in the order the server checks
 * them". It was not: with GLOBAL_STOP set and the disclosure stale, the client told
 * the operator to lift the emergency stop, and the server then refused for
 * disclosure anyway - the exact misattribution the comment claimed to prevent.
 *
 * The three strict selects raise a bare `P0002 no_data_found` with no message, so
 * anything predictable from the bootstrap is worth blocking on here rather than
 * letting an operator meet an empty error.
 */
export function qrGateState(input: QrGateInput): QrGateState {
  const { account } = input;
  const disclosure = disclosureState(account);
  const blockedBy: QrBlockedBy | null = !input.canManageConnections
    ? "PERMISSION"
    : account.connectionState === "CONNECTED"
      ? "ALREADY_CONNECTED"
      // DISCONNECTED and QR_PENDING are the only states the server accepts.
      // CONNECTING and DISCONNECTING are transient; RECONNECT_REQUIRED is not - no
      // function in the migration set moves an account out of it, so the honest
      // answer is that the UI cannot fix this, not a button that raises P0002.
      : account.connectionState !== "DISCONNECTED" && account.connectionState !== "QR_PENDING"
        ? "UNRECOVERABLE_STATE"
        : account.currentCellId === null
          ? "NO_READY_CELL"
          : disclosure.acknowledged
            ? null
            : "DISCLOSURE";
  return { canRequestQr: blockedBy === null, blockedBy, disclosure };
}

/**
 * Every event that must drop QR material from component memory.
 *
 * Exported as data rather than left implicit in a component, because "we handle
 * most of these" is indistinguishable from "we handle all of these" by inspection.
 * QR material is never written to localStorage, sessionStorage, the React Query
 * cache, analytics, or toast text - so memory is the only place it can linger.
 */
export function qrClearReasons(): readonly [
  "DIALOG_CLOSED",
  "EXPIRED",
  "SUCCESSFUL_LOGIN",
  "LOGOUT",
  "ORGANIZATION_SWITCH",
  "ACCOUNT_SWITCH",
  "ROUTE_UNMOUNTED",
] {
  return [
    "DIALOG_CLOSED",
    "EXPIRED",
    "SUCCESSFUL_LOGIN",
    "LOGOUT",
    "ORGANIZATION_SWITCH",
    "ACCOUNT_SWITCH",
    "ROUTE_UNMOUNTED",
  ];
}
