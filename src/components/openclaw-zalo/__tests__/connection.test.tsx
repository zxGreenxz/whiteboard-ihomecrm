import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import OpenClawConnectionDialog from "../dialogs/OpenClawConnectionDialog";
import { qrGateState } from "@/lib/openclaw-zalo/connection";
import type { OpenClawAccountSummary } from "@/lib/openclaw-zalo/types";

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


const noop = vi.fn();

function renderDialog(overrides: {
  account?: Partial<OpenClawAccountSummary>;
  canManageConnections?: boolean;
  challenge?: Parameters<typeof OpenClawConnectionDialog>[0]["challenge"];
  errorMessage?: string | null;
  open?: boolean;
  onDisconnect?: (() => void) | undefined;
} = {}) {
  const merged = { ...account, ...overrides.account };
  const gate = qrGateState({
    account: merged,
    canManageConnections: overrides.canManageConnections ?? true,
  });
  return renderToStaticMarkup(createElement(OpenClawConnectionDialog, {
    open: overrides.open ?? true,
    gate,
    accountName: merged.displayName,
    challenge: overrides.challenge ?? null,
    pending: false,
    errorMessage: overrides.errorMessage ?? null,
    onRequestQr: noop,
    onAcknowledgeDisclosure: noop,
    onDisconnect: "onDisconnect" in overrides ? overrides.onDisconnect : noop,
    onClose: noop,
  }));
}

/**
 * The opening tag of the button carrying `data-openclaw-action="<action>"`.
 *
 * Asserting on the tag rather than on the whole document is what gives the disabled
 * check teeth: `toContain("disabled")` was unconditionally true because the
 * className already holds `disabled:cursor-not-allowed disabled:opacity-60`, so
 * deleting the `disabled={...}` prop - letting an operator fire a QR request with
 * GLOBAL_STOP on or no permission at all - kept every assertion green.
 */
function buttonTag(html: string, action: string) {
  const match = html.match(
    new RegExp(`<button[^>]*data-openclaw-action="${action}"[^>]*>`, "u"),
  );
  expect(match, `no button for ${action}`).not.toBeNull();
  return match![0];
}

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const CHALLENGE = {
  challengeId: "q1",
  pngDataUrl: PNG,
  secondsLeft: 97,
  status: "READY" as const,
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

  // The dialog tells a connected owner to "Ngắt kết nối trước nếu muốn quét lại".
  // Nothing in the app could do that: no production file called the disconnect path
  // at all, so a connected account could never be re-linked. Copy that names an
  // action the UI does not offer is worse than no copy.
  it("offers the way out of ALREADY_CONNECTED, not just the instruction", () => {
    const html = renderDialog({ account: { connectionState: "CONNECTED" as const } });
    expect(html).toContain("Ngắt kết nối trước nếu muốn quét lại");
    expect(buttonTag(html, "disconnect")).toBeTruthy();
  });

  it("hides the disconnect button from anyone who cannot manage connections", () => {
    // The caller passes no handler at all - absent beats present-and-refused.
    const html = renderDialog({
      account: { connectionState: "CONNECTED" as const },
      canManageConnections: false,
      onDisconnect: undefined,
    });
    expect(html).not.toContain('data-openclaw-action="disconnect"');
  });

  it("names the gate that would refuse, and hides the code until it opens", () => {
    for (const [label, overrides] of [
      ["PERMISSION", { canManageConnections: false }],
      ["ALREADY_CONNECTED", { account: { connectionState: "CONNECTED" as const } }],
      ["UNRECOVERABLE_STATE", { account: { connectionState: "RECONNECT_REQUIRED" as const } }],
      ["NO_READY_CELL", { account: { currentCellId: null } }],
      ["DISCLOSURE", { account: { disclosureAcknowledgedVersion: 1 } }],
    ] as const) {
      const html = renderDialog(overrides);
      expect(html, label).toContain(`data-openclaw-blocked="${label}"`);
      expect(buttonTag(html, "request-qr"), label).toContain('disabled=""');
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

  it("says plainly that an unrecoverable session cannot be fixed from here", () => {
    // Nothing in the migration set moves an account out of RECONNECT_REQUIRED, so a
    // "try again" button would only ever produce a bare P0002.
    const html = renderDialog({ account: { connectionState: "RECONNECT_REQUIRED" } });
    expect(html).toContain('data-openclaw-blocked="UNRECOVERABLE_STATE"');
    expect(html).toContain("không thể tự khôi phục");
  });

  it("renders the decrypted PNG, which is the only scannable form there is", () => {
    // An earlier version printed `challengeId.nonce` as monospace text under
    // "scan this with your phone". The real code is AES-GCM ciphertext that only the
    // openclaw-qr Edge function can decrypt, so that string was unscannable forever.
    const html = renderDialog({ challenge: CHALLENGE });
    expect(html).toContain('data-openclaw-qr="image"');
    expect(html).toContain(PNG);
    expect(html).toContain('data-openclaw-qr="countdown"');
    expect(html).toContain("Còn 97s");
  });

  it("waits visibly while the challenge is still PENDING", () => {
    const html = renderDialog({
      challenge: { ...CHALLENGE, status: "PENDING", pngDataUrl: null },
    });
    expect(html).toContain('data-openclaw-qr="waiting"');
    expect(html).not.toContain('data-openclaw-qr="image"');
  });

  it("flags a ticket that outlives the documented window instead of hiding it", () => {
    const html = renderDialog({ challenge: { ...CHALLENGE, secondsLeft: 3600 } });
    expect(html).toContain('data-openclaw-qr="lifetime-anomaly"');
  });

  it("shows what the server refused with, rather than swallowing it", () => {
    const html = renderDialog({ errorMessage: "Phiên đăng nhập đã hết hạn" });
    expect(html).toContain('data-openclaw-qr="error"');
    expect(html).toContain("Phiên đăng nhập đã hết hạn");
  });

  it("enables the request button when no gate blocks it", () => {
    // The negative case above only proves the attribute appears when blocked; without
    // this, hardcoding `disabled` would also pass.
    const html = renderDialog();
    expect(buttonTag(html, "request-qr")).not.toContain('disabled=""');
  });

  it("replaces an expired code with a prompt for a new one, never the stale payload", () => {
    const html = renderDialog({ challenge: { ...CHALLENGE, secondsLeft: 0 } });
    expect(html).toContain('data-openclaw-qr="expired"');
    expect(html).not.toContain(PNG);
    // Same for a challenge the server marked terminal while seconds remained.
    for (const status of ["EXPIRED", "REVOKED"] as const) {
      const serverExpired = renderDialog({ challenge: { ...CHALLENGE, status } });
      expect(serverExpired, status).toContain('data-openclaw-qr="expired"');
      expect(serverExpired, status).not.toContain(PNG);
    }
  });

  it("states that the code lives only in page memory", () => {
    expect(renderDialog({ challenge: CHALLENGE })).toContain("chỉ nằm trong bộ nhớ trang");
  });
});
