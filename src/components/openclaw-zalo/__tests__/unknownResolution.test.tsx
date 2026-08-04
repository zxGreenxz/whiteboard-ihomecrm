import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import OpenClawOperations from "../operations/OpenClawOperations";

/** The migration is the authority on what the audit event actually carries. */
const RPC_SQL = readFileSync(
  "supabase/migrations/20260727060000_openclaw_rpc_surface.sql",
  "utf8",
);

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
  listsUnavailable: false,
  canManageOperations: true,
  canAudit: true,
  isActiveOwner: true,
  busy: false,
  lastReplay: null as { kind: "WORK_ITEM"; workItemId: string } | { kind: "NEW_OUTBOX"; outboxId: string } | null,
  replayFailure: null as string | null,
  holdTargetKind: "MESSAGE" as const,
  holdTargetId: "dddd8000-0000-4000-8000-000000000001",
  holdReason: "Tranh chấp hợp đồng",
  holds: [{
    holdId: "hold-1",
    targetKind: "MESSAGE",
    targetId: "dddd8000-0000-4000-8000-000000000001",
    reason: "Tranh chấp hợp đồng",
    holdVersion: 1,
    createdAt: "2026-08-03T07:00:00Z",
    expiresAt: null as string | null,
    releasedAt: null as string | null,
    releaseReason: null as string | null,
  }],
  holdsLoading: false,
  holdsUnavailable: false,
  holdFailure: null as string | null,
  releasingHoldId: null as string | null,
  releaseReason: "",
  onOpenUnknown: noop,
  onReplayDeadLetter: noop,
  onHoldTargetKindChange: noop,
  onHoldTargetIdChange: noop,
  onHoldReasonChange: noop,
  onCreateHold: noop,
  onSelectHoldForRelease: noop,
  onReleaseReasonChange: noop,
  onReleaseHold: noop,
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
    expect(outbox).toContain("dòng gửi MỚI tới khách trong hàng đợi");
  });

  it("warns that replay queues immediately and does NOT recheck policy", () => {
    // The RPC inserts the outbox row unconditionally. An earlier version of this copy
    // promised a policy recheck that does not happen, and this test pinned the false
    // sentence - so the wrong claim was regression-protected.
    const html = render();
    expect(html).toContain('data-openclaw-operations="replay-warning"');
    expect(html).toContain("không kiểm chính sách ở bước này");
    expect(html).toContain("GLOBAL_STOP");
    // The refuted claim must not come back.
    expect(html).not.toContain("sẽ không có tin nào được tạo");
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

  it("does not claim the reason reaches the audit record, because it does not", () => {
    // The audit event the RPC emits carries holdId, targetKind, targetId, holdVersion
    // and active - and no reason. The reason lives on the hold row, which is what the
    // list below reads. Promising an auditor they will find it in the append-only log
    // would be a promise the server does not keep.
    const create = /create or replace function public\.openclaw_create_legal_hold_v1[\s\S]*?\n\$function\$;/u
      .exec(RPC_SQL);
    expect(create, "create RPC not found").not.toBeNull();
    const auditPayload = /v_result:=jsonb_build_object\(([\s\S]*?)\);/u.exec(create![0]);
    expect(auditPayload, "audit payload not found").not.toBeNull();
    expect(auditPayload![1]).not.toContain("'reason'");

    const html = render();
    expect(html).toContain("nhật ký kiểm toán");
    expect(html).toContain("lưu cùng lệnh giữ");
  });

  it("shows the stored reason on each hold rather than only in the audit log", () => {
    const html = render();
    expect(html).toContain('data-openclaw-hold-row="hold-1"');
    expect(html).toContain('data-openclaw-hold="stored-reason"');
    expect(html).toContain("Tranh chấp hợp đồng");
  });

  it("separates an unreadable hold list from an empty one", () => {
    // "No holds" and "we could not read the holds" mean opposite things to someone
    // deciding whether evidence is protected from deletion.
    expect(render({ holds: [], holdsUnavailable: true }))
      .toContain('data-openclaw-holds="unavailable"');
    expect(render({ holds: [], holdsLoading: true })).toContain('data-openclaw-holds="loading"');
    expect(render({ holds: [] })).toContain('data-openclaw-holds="empty"');
  });

  it("requires an active owner for both creating and releasing a hold", () => {
    const html = render({ isActiveOwner: false, releasingHoldId: "hold-1", releaseReason: "xong việc" });
    expect(html).toContain('data-openclaw-hold-blocked="NOT_OWNER"');
    expect(buttonTag(html, "create-legal-hold")).toContain('disabled=""');
    expect(html).toContain('data-openclaw-release-blocked="NOT_OWNER"');
    expect(buttonTag(html, "release-legal-hold")).toContain('disabled=""');
  });

  it("will not offer to release a hold somebody already released", () => {
    const released = [{
      ...props.holds[0],
      releasedAt: "2026-08-03T11:00:00Z",
      releaseReason: "Vụ việc đã khép",
    }];
    const html = render({ holds: released, releasingHoldId: "hold-1" });
    expect(html).toContain('data-openclaw-hold-state="RELEASED"');
    expect(html).toContain('data-openclaw-hold="released"');
    expect(html).not.toContain('data-openclaw-action="release-legal-hold"');
  });

  it("needs a reason before it will release", () => {
    const withForm = { releasingHoldId: "hold-1" };
    expect(buttonTag(render({ ...withForm, releaseReason: " " }), "release-legal-hold"))
      .toContain('disabled=""');
    expect(buttonTag(render({ ...withForm, releaseReason: "Vụ việc đã khép" }), "release-legal-hold"))
      .not.toContain('disabled=""');
  });

  it("surfaces what a failed hold or replay failed with", () => {
    // A write that failed silently reads exactly like one that worked, and the next
    // move - wait, or try again - depends on knowing which.
    expect(render({ holdFailure: "Đối tượng này đã có một lệnh giữ đang hiệu lực" }))
      .toContain('data-openclaw-hold="failure"');
    expect(render({ replayFailure: "Chưa phát lại được dead-letter này." }))
      .toContain('data-openclaw-replay="failure"');
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
