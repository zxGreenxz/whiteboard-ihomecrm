import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import OpenClawConnectionDialog from "../dialogs/OpenClawConnectionDialog";
import { qrGateState } from "@/lib/openclaw-zalo/connection";
import type { OpenClawAccountSummary, OpenClawControlState } from "@/lib/openclaw-zalo/types";

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

const noop = vi.fn();

function renderDialog(overrides: {
  account?: Partial<OpenClawAccountSummary>;
  control?: Partial<OpenClawControlState>;
  canManageConnections?: boolean;
  challenge?: Parameters<typeof OpenClawConnectionDialog>[0]["challenge"];
  open?: boolean;
} = {}) {
  const merged = { ...account, ...overrides.account };
  const gate = qrGateState({
    account: merged,
    control: { ...control, ...overrides.control },
    canManageConnections: overrides.canManageConnections ?? true,
    now: "2026-08-03T10:00:00.000Z",
  });
  return renderToStaticMarkup(createElement(OpenClawConnectionDialog, {
    open: overrides.open ?? true,
    gate,
    accountName: merged.displayName,
    challenge: overrides.challenge ?? null,
    pending: false,
    onRequestQr: noop,
    onAcknowledgeDisclosure: noop,
    onClose: noop,
  }));
}

const CHALLENGE = {
  challengeId: "q1",
  qrPayload: "2|abc-def",
  secondsLeft: 97,
  status: "PENDING" as const,
};

describe("connection dialog", () => {
  it("renders nothing at all when closed", () => {
    expect(renderDialog({ open: false })).toBe("");
  });

  it("tells the operator to use the same phone before anything else", () => {
    // Scanning from a second device kicks the live session; the warning has to be
    // in front of the code, not in a help page.
    expect(renderDialog()).toContain("chính chiếc điện thoại");
  });

  it("names the gate that would refuse, and hides the code until it opens", () => {
    for (const [label, overrides] of [
      ["PERMISSION", { canManageConnections: false }],
      ["GLOBAL_STOP", { control: { globalStop: true } }],
      ["FEATURE_DISABLED", { control: { featureEnabled: false } }],
      ["ALREADY_CONNECTED", { account: { connectionState: "CONNECTED" as const } }],
      ["DISCLOSURE", { account: { disclosureAcknowledgedVersion: 1 } }],
    ] as const) {
      const html = renderDialog(overrides);
      expect(html, label).toContain(`data-openclaw-blocked="${label}"`);
      expect(html, label).toContain("disabled");
    }
  });

  it("offers the exact disclosure version the RPC will accept", () => {
    // openclaw_acknowledge_disclosure_v1 raises 40001 on a version mismatch, so a
    // constant baked into the client would break the moment the text is republished.
    const html = renderDialog({
      account: { disclosureVersion: 7, disclosureAcknowledgedVersion: 3 },
    });
    expect(html).toContain('data-openclaw-action="acknowledge-disclosure"');
    expect(html).toContain("Xác nhận công bố phiên bản 7");
  });

  it("re-asks for acknowledgement after a LIMITED reconnect", () => {
    const html = renderDialog({
      account: { sessionRiskState: "LIMITED", connectionState: "RECONNECT_REQUIRED" },
    });
    expect(html).toContain('data-openclaw-blocked="DISCLOSURE"');
    expect(html).toContain("Phiên bị hạn chế");
  });

  it("shows the countdown against the ceiling while the code is live", () => {
    const html = renderDialog({ challenge: CHALLENGE });
    expect(html).toContain('data-openclaw-qr="countdown"');
    expect(html).toContain("Còn 97s / 120s");
    expect(html).toContain("2|abc-def");
  });

  it("replaces an expired code with a prompt for a new one, never the stale payload", () => {
    const html = renderDialog({ challenge: { ...CHALLENGE, secondsLeft: 0 } });
    expect(html).toContain('data-openclaw-qr="expired"');
    expect(html).not.toContain("2|abc-def");
    // Same for a challenge the server marked expired while seconds remained.
    const serverExpired = renderDialog({
      challenge: { ...CHALLENGE, status: "EXPIRED" },
    });
    expect(serverExpired).toContain('data-openclaw-qr="expired"');
    expect(serverExpired).not.toContain("2|abc-def");
  });

  it("states that the code lives only in page memory", () => {
    expect(renderDialog({ challenge: CHALLENGE })).toContain("chỉ nằm trong bộ nhớ trang");
  });
});
