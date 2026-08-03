import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import OpenClawGlobalStopDialog from "../dialogs/OpenClawGlobalStopDialog";
import OpenClawUnknownResolutionDialog from "../dialogs/OpenClawUnknownResolutionDialog";
import {
  GLOBAL_STOP_CONFIRMATION,
  MIN_OBSERVATION_LENGTH,
  UNAVAILABLE_UNKNOWN_OUTCOMES,
} from "@/lib/openclaw-zalo/operations";
import type { OpenClawUnknownResolutionOutcome } from "@/lib/openclaw-zalo/types";

const noop = vi.fn();

const stopProps = {
  open: true,
  organizationName: "Tổ chức DEMO",
  canManageOperations: true,
  alreadyStopped: false,
  typedConfirmation: GLOBAL_STOP_CONFIRMATION,
  busy: false,
  failureMessage: null as string | null,
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
  selectedOutcome: null as OpenClawUnknownResolutionOutcome | null,
  observation: "Đã mở máy khách lúc 10:05, thấy tin đã tới.",
  authorityHash: "b".repeat(64) as string | null,
  authorityLoading: false,
  authorityError: false,
  winner: null,
  busy: false,
  failureMessage: null as string | null,
  onSelectOutcome: noop,
  onObservationChange: noop,
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

  it("asks for the observation the evidence hash will stand for", () => {
    // The server stores the hash and never recomputes it, so an empty observation
    // would put a meaningless number into the audit record.
    const html = renderUnknown({ selectedOutcome: "CONFIRMED_SENT", observation: "" });
    expect(html).toContain('data-openclaw-unknown="observation"');
    expect(html).toContain('data-openclaw-unknown-blocked="OBSERVATION"');
    expect(buttonTag(html, "confirm-unknown-resolution")).toContain('disabled=""');
    expect(buttonTag(
      renderUnknown({ selectedOutcome: "CONFIRMED_SENT", observation: "x".repeat(MIN_OBSERVATION_LENGTH) }),
      "confirm-unknown-resolution",
    )).not.toContain('disabled=""');
  });

  it("will not let an outcome be recorded before the evidence is read", () => {
    // Submitting without it is a guaranteed 40001, and the operator would have no
    // way to tell that from a real conflict.
    for (const [state, overrides] of [
      ["AUTHORITY_LOADING", { authorityLoading: true }],
      ["AUTHORITY_ERROR", { authorityError: true }],
      ["AUTHORITY_UNAVAILABLE", { authorityHash: null }],
    ] as const) {
      const html = renderUnknown({ selectedOutcome: "CONFIRMED_SENT", ...overrides });
      expect(html, state).toContain(`data-openclaw-unknown-blocked="${state}"`);
      expect(buttonTag(html, "confirm-unknown-resolution"), state).toContain('disabled=""');
    }
  });

  it("shows why an outcome it cannot build is disabled instead of hiding it", () => {
    // Hiding it would leave an operator hunting for a choice they remember. The
    // reason names the alternative that does work.
    const html = renderUnknown();
    for (const [outcome, reason] of Object.entries(UNAVAILABLE_UNKNOWN_OUTCOMES)) {
      const button = html.match(
        new RegExp(`<button[^>]*data-openclaw-unknown-outcome="${outcome}"[^>]*>`, "u"),
      );
      expect(button, outcome).not.toBeNull();
      expect(button![0], outcome).toContain('disabled=""');
      expect(html).toContain(reason.slice(0, 30));
    }
  });

  it("surfaces what a failed attempt failed with", () => {
    // Silence here would leave the operator pressing a button that does nothing.
    const html = renderUnknown({
      selectedOutcome: "CONFIRMED_SENT",
      failureMessage: "Người khác vừa đối chiếu tin này trước bạn.",
    });
    expect(html).toContain('data-openclaw-unknown="failure"');
    expect(html).toContain("Người khác vừa đối chiếu");
  });
});
