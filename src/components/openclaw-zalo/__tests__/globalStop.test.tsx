import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import OpenClawGlobalStopDialog from "../dialogs/OpenClawGlobalStopDialog";
import OpenClawUnknownResolutionDialog from "../dialogs/OpenClawUnknownResolutionDialog";
import { GLOBAL_STOP_CONFIRMATION } from "@/lib/openclaw-zalo/operations";

const noop = vi.fn();

const stopProps = {
  open: true,
  organizationName: "Tổ chức DEMO",
  canManageOperations: true,
  alreadyStopped: false,
  typedConfirmation: GLOBAL_STOP_CONFIRMATION,
  busy: false,
  onTypedConfirmationChange: noop,
  onConfirm: noop,
  onClose: noop,
};

const renderStop = (overrides: Partial<typeof stopProps> = {}) =>
  renderToStaticMarkup(createElement(OpenClawGlobalStopDialog, { ...stopProps, ...overrides }));

function buttonTag(html: string, action: string) {
  const match = html.match(new RegExp(`<button[^>]*data-openclaw-action="${action}"[^>]*>`, "u"));
  expect(match, `no button for ${action}`).not.toBeNull();
  return match![0];
}

describe("GLOBAL_STOP dialog", () => {
  it("names the organization it is about to stop", () => {
    // An operator with several organizations open must not stop the wrong one from
    // muscle memory.
    expect(renderStop()).toContain("Tổ chức DEMO");
  });

  it("keeps the stop disabled until the phrase matches exactly", () => {
    expect(buttonTag(renderStop({ typedConfirmation: "" }), "confirm-global-stop"))
      .toContain('disabled=""');
    expect(buttonTag(renderStop({ typedConfirmation: "dung toan bo gui cua cong ty" }), "confirm-global-stop"))
      .toContain('disabled=""');
    expect(buttonTag(renderStop(), "confirm-global-stop")).not.toContain('disabled=""');
  });

  it("shows the phrase to type, so it can be copied rather than guessed", () => {
    const html = renderStop();
    expect(html).toContain('data-openclaw-global-stop="phrase"');
    expect(html).toContain(GLOBAL_STOP_CONFIRMATION);
  });

  it("blocks on permission before it blocks on the phrase", () => {
    const html = renderStop({ canManageOperations: false, typedConfirmation: "" });
    expect(html).toContain('data-openclaw-global-stop-blocked="PERMISSION"');
  });

  it("says so rather than offering a second stop when already stopped", () => {
    const html = renderStop({ alreadyStopped: true });
    expect(html).toContain('data-openclaw-global-stop-blocked="ALREADY_STOPPED"');
    expect(buttonTag(html, "confirm-global-stop")).toContain('disabled=""');
  });

  it("warns that sends already gone cannot be recalled", () => {
    expect(renderStop()).toContain("không thu hồi được");
  });
});

const unknownProps = {
  open: true,
  outboxId: "ob-1",
  canManageOperations: true,
  selectedOutcome: null,
  winner: null,
  busy: false,
  onSelectOutcome: noop,
  onConfirm: noop,
  onClose: noop,
};

const renderUnknown = (overrides: Partial<typeof unknownProps> = {}) =>
  renderToStaticMarkup(createElement(OpenClawUnknownResolutionDialog, {
    ...unknownProps, ...overrides,
  }));

describe("UNKNOWN resolution dialog", () => {
  it("offers exactly the three outcomes the server accepts", () => {
    const html = renderUnknown();
    for (const outcome of ["CONFIRMED_SENT", "CONFIRMED_FAILED", "NEW_INTENT_CREATED"]) {
      expect(html, outcome).toContain(`data-openclaw-unknown-outcome="${outcome}"`);
    }
  });

  it("keeps the historical UNKNOWN badge alongside the resolution", () => {
    // Replacing it would erase the fact that the outcome was ever in doubt.
    const html = renderUnknown({
      winner: {
        resolutionId: "r1", outcome: "CONFIRMED_SENT",
        resolvedAt: "2026-08-03T10:00:00Z", newOutboxId: null,
      },
    });
    expect(html).toContain('data-openclaw-unknown-badge="UNKNOWN"');
    expect(html).toContain('data-openclaw-unknown-badge="CONFIRMED_SENT"');
  });

  it("frames the choice as recording an observation, not instructing the system", () => {
    const html = renderUnknown();
    expect(html).toContain("ghi nhận quan sát");
    expect(html).toContain("tự kiểm tra");
  });

  it("shows the winner and stops offering a choice once someone resolved it first", () => {
    // Resolution is one-time; a second attempt would only produce 40001.
    const html = renderUnknown({
      winner: {
        resolutionId: "r1", outcome: "NEW_INTENT_CREATED",
        resolvedAt: "2026-08-03T10:00:00Z", newOutboxId: "ob-2",
      },
    });
    expect(html).toContain('data-openclaw-unknown="winner"');
    expect(html).toContain('data-openclaw-unknown="new-outbox"');
    expect(html).toContain("ob-2");
    expect(html).not.toContain('data-openclaw-unknown-outcome="CONFIRMED_SENT"');
    expect(html).not.toContain('data-openclaw-action="confirm-unknown-resolution"');
  });

  it("will not record anything without a chosen outcome", () => {
    expect(buttonTag(renderUnknown(), "confirm-unknown-resolution")).toContain('disabled=""');
    expect(buttonTag(renderUnknown({ selectedOutcome: "CONFIRMED_SENT" }), "confirm-unknown-resolution"))
      .not.toContain('disabled=""');
  });

  it("blocks a member without manage_operations", () => {
    const html = renderUnknown({ canManageOperations: false, selectedOutcome: "CONFIRMED_SENT" });
    expect(html).toContain('data-openclaw-unknown-blocked="PERMISSION"');
    expect(buttonTag(html, "confirm-unknown-resolution")).toContain('disabled=""');
  });
});
