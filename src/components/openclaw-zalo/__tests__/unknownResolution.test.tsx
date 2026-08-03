import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import OpenClawOperations from "../operations/OpenClawOperations";

const noop = vi.fn();

const props = {
  unknownRows: [{
    outboxId: "ob-1",
    payloadHash: "a".repeat(64),
    terminalAt: "2026-08-03T09:00:00Z",
    resolutionOutcome: null as string | null,
  }],
  deadLetters: [{ deadLetterId: "dl-1", reasonCode: "PROVIDER_REJECTED", createdAt: "2026-08-03T08:00:00Z" }],
  loading: false,
  canManageOperations: true,
  canAudit: true,
  busy: false,
  lastReplay: null,
  holdTargetKind: "MESSAGE" as const,
  holdTargetId: "dddd8000-0000-4000-8000-000000000001",
  holdReason: "Tranh chấp hợp đồng",
  onOpenUnknown: noop,
  onReplayDeadLetter: noop,
  onHoldTargetKindChange: noop,
  onHoldTargetIdChange: noop,
  onHoldReasonChange: noop,
  onCreateHold: noop,
};

const render = (overrides: Partial<typeof props> = {}) =>
  renderToStaticMarkup(createElement(OpenClawOperations, { ...props, ...overrides }));

function buttonTag(html: string, action: string) {
  const match = html.match(new RegExp(`<button[^>]*data-openclaw-action="${action}"[^>]*>`, "u"));
  expect(match, `no button for ${action}`).not.toBeNull();
  return match![0];
}

describe("operations screen", () => {
  it("keeps the UNKNOWN badge after a conclusion is recorded", () => {
    const html = render({
      unknownRows: [{ ...props.unknownRows[0], resolutionOutcome: "CONFIRMED_SENT" }],
    });
    expect(html).toContain("UNKNOWN");
    expect(html).toContain('data-openclaw-unknown-resolved="CONFIRMED_SENT"');
    // And the control changes verb, because there is nothing left to decide.
    expect(html).toContain("Xem kết luận");
  });

  it("tells a queued work item apart from a new customer-facing message", () => {
    // One means "the system will retry"; the other means a real person now has a
    // message. Presenting both as "replayed" would lose that.
    const workItem = render({ lastReplay: { kind: "WORK_ITEM", workItemId: "w1" } });
    expect(workItem).toContain('data-openclaw-replay="WORK_ITEM"');
    expect(workItem).toContain("Chưa có tin mới nào tới khách");

    const outbox = render({ lastReplay: { kind: "NEW_OUTBOX", outboxId: "o1" } });
    expect(outbox).toContain('data-openclaw-replay="NEW_OUTBOX"');
    expect(outbox).toContain("tin gửi MỚI tới khách");
  });

  it("says replay is subject to a policy recheck, so it does not read as force", () => {
    expect(render()).toContain("kiểm lại chính sách hiện hành");
  });

  it("names which of the two permissions a legal hold is missing", () => {
    expect(render({ canAudit: false })).toContain('data-openclaw-hold-blocked="PERMISSION_AUDIT"');
    expect(render({ canManageOperations: false }))
      .toContain('data-openclaw-hold-blocked="PERMISSION_OPERATIONS"');
  });

  it("will not create a hold without a target and a reason", () => {
    expect(buttonTag(render({ holdTargetId: "" }), "create-legal-hold")).toContain('disabled=""');
    expect(buttonTag(render({ holdReason: "  " }), "create-legal-hold")).toContain('disabled=""');
    expect(buttonTag(render(), "create-legal-hold")).not.toContain('disabled=""');
  });

  it("offers every legal-hold target kind, widest first", () => {
    const html = render();
    for (const kind of ["ORGANIZATION", "MESSAGE", "MEDIA", "AUDIT"]) {
      expect(html, kind).toContain(`value="${kind}"`);
    }
    expect(html.indexOf('value="ORGANIZATION"')).toBeLessThan(html.indexOf('value="AI_DRAFT"'));
  });

  it("says the reason goes into the audit record", () => {
    expect(render()).toContain("nhật ký kiểm toán");
  });

  it("blocks both write actions for a member who cannot operate", () => {
    const html = render({ canManageOperations: false });
    expect(buttonTag(html, "open-unknown")).toContain('disabled=""');
    expect(buttonTag(html, "replay-dead-letter")).toContain('disabled=""');
  });

  it("distinguishes loading from genuinely nothing to reconcile", () => {
    expect(render({ unknownRows: [], loading: true })).toContain("Đang tải…");
    expect(render({ unknownRows: [], loading: false }))
      .toContain("Không có tin nào cần đối chiếu");
  });
});
