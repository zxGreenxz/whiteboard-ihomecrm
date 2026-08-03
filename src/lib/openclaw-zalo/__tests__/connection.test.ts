import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  QR_TTL_SECONDS,
  disclosureState,
  qrCountdownSeconds,
  qrGateState,
  qrClearReasons,
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

  it("never reports time left after expiry, and never more than the ceiling", () => {
    // A clock skewed backwards must not resurrect an expired code, and a server
    // sending an absurd lifetime must not park a QR on screen for an hour.
    fc.assert(fc.property(fc.integer({ min: -86_400, max: 86_400 }), (offsetSeconds) => {
      const now = new Date(Date.parse(EXPIRES) - offsetSeconds * 1000).toISOString();
      const left = qrCountdownSeconds(EXPIRES, now);
      expect(left).toBeGreaterThanOrEqual(0);
      expect(left).toBeLessThanOrEqual(QR_TTL_SECONDS);
      if (offsetSeconds <= 0) expect(left).toBe(0);
    }));
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

  it("re-arms when a LIMITED session forces a reconnect", () => {
    // A LIMITED reconnect is a fresh grant of access to the phone, so the operator
    // acknowledges again even though the published version has not moved.
    const limited = disclosureState({
      ...account,
      sessionRiskState: "LIMITED",
      connectionState: "RECONNECT_REQUIRED",
    });
    expect(limited.acknowledged).toBe(false);
    expect(limited.reason).toBe("LIMITED_RECONNECT");
  });
});

describe("QR gate", () => {
  const base = { account, control, canManageConnections: true, now: ISSUED };

  it("blocks a QR the server would refuse, and says which gate stopped it", () => {
    expect(qrGateState({ ...base, canManageConnections: false }).blockedBy)
      .toBe("PERMISSION");
    expect(qrGateState({ ...base, control: { ...control, globalStop: true } }).blockedBy)
      .toBe("GLOBAL_STOP");
    expect(qrGateState({ ...base, control: { ...control, featureEnabled: false } }).blockedBy)
      .toBe("FEATURE_DISABLED");
    expect(qrGateState({
      ...base,
      account: { ...account, disclosureAcknowledgedVersion: 1 },
    }).blockedBy).toBe("DISCLOSURE");
  });

  it("orders the gates the way the server does, so the UI never blames the wrong one", () => {
    // GLOBAL_STOP is checked before the disclosure gate server-side. If the UI
    // reported DISCLOSURE here, an operator would acknowledge and still be refused.
    const both = qrGateState({
      ...base,
      control: { ...control, globalStop: true },
      account: { ...account, disclosureAcknowledgedVersion: null },
    });
    expect(both.blockedBy).toBe("GLOBAL_STOP");
  });

  it("allows the QR only when every gate is open", () => {
    const open = qrGateState(base);
    expect(open.blockedBy).toBeNull();
    expect(open.canRequestQr).toBe(true);
  });

  it("refuses to keep offering a QR while one is already connected", () => {
    expect(qrGateState({ ...base, account: { ...account, connectionState: "CONNECTED" } }).blockedBy)
      .toBe("ALREADY_CONNECTED");
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
