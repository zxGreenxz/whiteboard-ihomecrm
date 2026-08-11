import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  QR_TTL_SECONDS,
  disclosureState,
  qrCountdownSeconds,
  qrGateState,
  qrClearReasons,
  qrLifetimeIsAnomalous,
} from "../connection";
import type { OpenClawAccountSummary, OpenClawControlState } from "../types";

const ISSUED = "2026-08-03T10:00:00.000Z";
const EXPIRES = "2026-08-03T10:02:00.000Z";

const account: OpenClawAccountSummary = {
  accountId: "dddd1000-0000-4000-8000-00000000000a",
  displayName: "Zalo bán hàng",
  connectionState: "DISCONNECTED",
  sessionRiskState: "HEALTHY",
  configuredMode: "MANUAL_SEND",
  effectiveMode: "MANUAL_SEND",
  connectionGeneration: 3,
  sessionGeneration: 4,
  disclosureVersion: 2,
  disclosureAcknowledgedVersion: 2,
  currentCellId: "dddd2000-0000-4000-8000-000000000010",
};

const control: OpenClawControlState = {
  globalStop: false,
  featureEnabled: true,
  limitedAutoReplyEnabled: false,
  proactiveEnabled: false,
  salesGroupsEnabled: false,
  controlVersion: 9,
};

describe("QR countdown", () => {
  it("counts down from the ticket's own lifetime, not a hardcoded 120", () => {
    // The countdown is derived from issuedAt/expiresAt so a server that shortens the
    // ticket is reflected immediately; 120s is only the ceiling the UI will show.
    expect(qrCountdownSeconds(EXPIRES, ISSUED)).toBe(120);
    expect(qrCountdownSeconds(EXPIRES, "2026-08-03T10:01:30.000Z")).toBe(30);
    expect(qrCountdownSeconds(EXPIRES, "2026-08-03T10:02:00.000Z")).toBe(0);
  });

  it("never reports time left after expiry", () => {
    // A clock skewed backwards must not resurrect an expired code.
    fc.assert(fc.property(fc.integer({ min: -86_400, max: 86_400 }), (offsetSeconds) => {
      const now = new Date(Date.parse(EXPIRES) - offsetSeconds * 1000).toISOString();
      const left = qrCountdownSeconds(EXPIRES, now);
      expect(left).toBeGreaterThanOrEqual(0);
      if (offsetSeconds <= 0) expect(left).toBe(0);
    }));
  });

  it("reports an over-long ticket instead of hiding it behind the ceiling", () => {
    // The old upper clamp displayed a frozen "120s" while a one-hour ticket sat on
    // screen for an hour - a visible anomaly turned invisible.
    const hour = qrCountdownSeconds("2026-08-03T11:00:00.000Z", ISSUED);
    expect(hour).toBe(3600);
    expect(qrLifetimeIsAnomalous(hour)).toBe(true);
    expect(qrLifetimeIsAnomalous(QR_TTL_SECONDS)).toBe(false);
  });

  it("treats an unparseable timestamp as expired rather than as infinite", () => {
    expect(qrCountdownSeconds("not-a-date", ISSUED)).toBe(0);
    expect(qrCountdownSeconds(EXPIRES, "not-a-date")).toBe(0);
  });
});

describe("disclosure gate", () => {
  it("requires acknowledgement when the published version moves ahead", () => {
    expect(disclosureState({ ...account, disclosureAcknowledgedVersion: 2 }).acknowledged).toBe(true);
    expect(disclosureState({ ...account, disclosureAcknowledgedVersion: 1 }).acknowledged).toBe(false);
    // Never acknowledged at all.
    expect(disclosureState({ ...account, disclosureAcknowledgedVersion: null }).acknowledged).toBe(false);
  });

  it("reports the version to acknowledge, so the UI cannot send a stale one", () => {
    // openclaw_acknowledge_disclosure_v1 raises 40001 on a version mismatch, so the
    // number offered to the operator must come from the account, never from a
    // constant in the client.
    expect(disclosureState({ ...account, disclosureVersion: 7, disclosureAcknowledgedVersion: 3 })
      .versionToAcknowledge).toBe(7);
  });

  it("does not invent a re-acknowledgement the server cannot clear", () => {
    // An earlier version re-armed on LIMITED + RECONNECT_REQUIRED. Nothing in the
    // migration set ever writes session_risk_state='LIMITED', and the acknowledge
    // RPC touches neither session_risk_state nor connection_state - so the gate
    // could never be satisfied and locked the operator out with no exit.
    const limited = disclosureState({
      ...account,
      sessionRiskState: "LIMITED",
      connectionState: "RECONNECT_REQUIRED",
    });
    expect(limited.acknowledged).toBe(true);
    expect(limited.reason).toBeNull();
  });
});

describe("QR gate", () => {
  const base = { account, canManageConnections: true };

  it("blocks exactly what the server blocks, and nothing it does not", () => {
    // Disconnecting is gated by the same permission but NOT by the QR
    // preconditions: the account an operator needs to disconnect is precisely
    // the CONNECTED one, which can never request a QR. The dialog read this
    // field before it existed, so the disconnect button did nothing at all.
    expect(qrGateState({ ...base, account: { ...account, connectionState: "CONNECTED" } }).canManageConnections)
      .toBe(true);
    expect(qrGateState({ ...base, canManageConnections: false }).canManageConnections)
      .toBe(false);
    expect(qrGateState({ ...base, canManageConnections: false }).blockedBy)
      .toBe("PERMISSION");
    expect(qrGateState({ ...base, account: { ...account, connectionState: "CONNECTED" } })
      .blockedBy).toBe("ALREADY_CONNECTED");
    expect(qrGateState({ ...base, account: { ...account, currentCellId: null } })
      .blockedBy).toBe("NO_READY_CELL");
    expect(qrGateState({
      ...base,
      account: { ...account, disclosureAcknowledgedVersion: 1 },
    }).blockedBy).toBe("DISCLOSURE");
  });

  it("does not block on GLOBAL_STOP or the feature flag, because the server does not", () => {
    // openclaw_begin_qr_login_v1 checks neither. Blocking here told the operator to
    // lift the emergency stop, after which the server refused for disclosure anyway
    // - the exact misattribution the old comment claimed to prevent.
    const stale = { ...account, disclosureAcknowledgedVersion: 1 };
    expect(qrGateState({ ...base, account: stale }).blockedBy).toBe("DISCLOSURE");
  });

  it("refuses RECONNECT_REQUIRED as unrecoverable rather than raising a bare P0002", () => {
    // The server's account select is `into strict` on
    // `connection_state in ('DISCONNECTED','QR_PENDING')`, so this state yields
    // no_data_found with no message. No function in the migration set moves an
    // account out of RECONNECT_REQUIRED, so the honest answer is that the UI cannot
    // fix it.
    for (const state of ["RECONNECT_REQUIRED", "CONNECTING", "DISCONNECTING"] as const) {
      expect(qrGateState({ ...base, account: { ...account, connectionState: state } })
        .blockedBy, state).toBe("UNRECOVERABLE_STATE");
    }
  });

  it("allows the QR from the two states the server accepts", () => {
    for (const state of ["DISCONNECTED", "QR_PENDING"] as const) {
      const open = qrGateState({ ...base, account: { ...account, connectionState: state } });
      expect(open.blockedBy, state).toBeNull();
      expect(open.canRequestQr, state).toBe(true);
    }
  });
});

describe("QR lifetime in the browser", () => {
  it("names every event that must clear the code from memory", () => {
    // The plan forbids persisting QR material anywhere; the counterpart is that it
    // has to be dropped on each of these. Pinned as data so a component cannot
    // quietly handle only some of them.
    expect([...qrClearReasons()].sort()).toEqual([
      "ACCOUNT_SWITCH",
      "DIALOG_CLOSED",
      "EXPIRED",
      "LOGOUT",
      "ORGANIZATION_SWITCH",
      "ROUTE_UNMOUNTED",
      "SUCCESSFUL_LOGIN",
    ]);
  });
});
