import type { OpenClawAccountSummary, OpenClawControlState } from "./types";

/**
 * The ceiling the UI will display for a QR code, matching the plan's 120-second
 * window. It is a CEILING, not the source of truth: the countdown is derived from
 * the ticket's own issuedAt/expiresAt so a server that shortens the lifetime takes
 * effect immediately.
 */
export const QR_TTL_SECONDS = 120;

function epoch(timestamp: string): number | null {
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : null;
}

/**
 * Whole seconds left before `expiresAt`, clamped to [0, QR_TTL_SECONDS].
 *
 * Both clamps matter. A browser clock skewed backwards must not resurrect an
 * expired code, and a malformed or over-long lifetime must not park a QR - which
 * grants access to the operator's phone - on screen indefinitely. An unparseable
 * timestamp counts as expired, because the safe reading of "I cannot tell when this
 * dies" is "it is already dead".
 */
export function qrCountdownSeconds(expiresAt: string, now: string): number {
  const end = epoch(expiresAt);
  const current = epoch(now);
  if (end === null || current === null) return 0;
  const seconds = Math.floor((end - current) / 1000);
  if (seconds <= 0) return 0;
  return Math.min(seconds, QR_TTL_SECONDS);
}

export type DisclosureReason = "VERSION_MOVED" | "NEVER_ACKNOWLEDGED" | "LIMITED_RECONNECT" | null;

export interface DisclosureState {
  acknowledged: boolean;
  /** The version the acknowledge RPC must be given; it raises 40001 on a mismatch. */
  versionToAcknowledge: number;
  reason: DisclosureReason;
}

/**
 * Whether the operator still owes an acknowledgement before a QR may be requested.
 *
 * Mirrors what `openclaw_begin_qr_login_v1` enforces, plus the plan's rule that a
 * LIMITED session forcing a reconnect re-arms the disclosure: that reconnect is a
 * fresh grant of access to the phone even though the published version has not moved.
 */
export function disclosureState(account: OpenClawAccountSummary): DisclosureState {
  const versionToAcknowledge = account.disclosureVersion;
  if (account.disclosureAcknowledgedVersion === null) {
    return { acknowledged: false, versionToAcknowledge, reason: "NEVER_ACKNOWLEDGED" };
  }
  if (account.disclosureAcknowledgedVersion !== account.disclosureVersion) {
    return { acknowledged: false, versionToAcknowledge, reason: "VERSION_MOVED" };
  }
  if (account.sessionRiskState === "LIMITED" && account.connectionState === "RECONNECT_REQUIRED") {
    return { acknowledged: false, versionToAcknowledge, reason: "LIMITED_RECONNECT" };
  }
  return { acknowledged: true, versionToAcknowledge, reason: null };
}

export type QrBlockedBy =
  | "PERMISSION"
  | "GLOBAL_STOP"
  | "FEATURE_DISABLED"
  | "ALREADY_CONNECTED"
  | "DISCLOSURE";

export interface QrGateInput {
  account: OpenClawAccountSummary;
  control: OpenClawControlState | null;
  canManageConnections: boolean;
  now: string;
}

export interface QrGateState {
  canRequestQr: boolean;
  blockedBy: QrBlockedBy | null;
  disclosure: DisclosureState;
}

/**
 * The gates a QR request must pass, IN THE ORDER THE SERVER CHECKS THEM.
 *
 * Order is the whole point. If the UI reported DISCLOSURE while GLOBAL_STOP was
 * also set, the operator would acknowledge the disclosure and still be refused,
 * with no idea why. Reporting the gate the server would actually hit first keeps
 * the explanation truthful.
 */
export function qrGateState(input: QrGateInput): QrGateState {
  const disclosure = disclosureState(input.account);
  const blockedBy: QrBlockedBy | null = !input.canManageConnections
    ? "PERMISSION"
    : input.control?.globalStop === true
      ? "GLOBAL_STOP"
      : input.control?.featureEnabled === false
        ? "FEATURE_DISABLED"
        : input.account.connectionState === "CONNECTED"
          ? "ALREADY_CONNECTED"
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
