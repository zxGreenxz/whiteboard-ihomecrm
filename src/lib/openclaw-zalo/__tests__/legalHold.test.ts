import { describe, expect, it } from "vitest";

import {
  classifyReplayResult,
  LEGAL_HOLD_TARGET_KINDS,
  legalHoldGate,
} from "../legalHold";

const base = {
  canAudit: true,
  canManageOperations: true,
  targetId: "dddd8000-0000-4000-8000-000000000001",
  reason: "Tranh chấp hợp đồng",
};

describe("legal hold gate", () => {
  it("requires BOTH permissions and names which one is missing", () => {
    // A hold stops evidence from being deleted: an operational act and an audit act
    // at once. Reporting one generic "no permission" would send the operator to ask
    // for the wrong role.
    expect(legalHoldGate({ ...base, canAudit: false }).blockedBy).toBe("PERMISSION_AUDIT");
    expect(legalHoldGate({ ...base, canManageOperations: false }).blockedBy)
      .toBe("PERMISSION_OPERATIONS");
    expect(legalHoldGate(base).canCreate).toBe(true);
  });

  it("refuses an empty target or reason, including whitespace-only", () => {
    expect(legalHoldGate({ ...base, targetId: "   " }).blockedBy).toBe("NO_TARGET");
    expect(legalHoldGate({ ...base, reason: "\n" }).blockedBy).toBe("NO_REASON");
  });

  it("puts the permission checks ahead of the field checks", () => {
    // Otherwise a member without the permission fills the form, gets an enabled
    // button, and meets a server refusal.
    expect(legalHoldGate({
      ...base, canAudit: false, targetId: "", reason: "",
    }).blockedBy).toBe("PERMISSION_AUDIT");
  });

  it("carries every target kind the request schema accepts", () => {
    expect(LEGAL_HOLD_TARGET_KINDS).toHaveLength(16);
    expect(new Set(LEGAL_HOLD_TARGET_KINDS).size).toBe(16);
    // ORGANIZATION is first because it is the widest and the easiest to pick by
    // accident; a list that buried it alphabetically would make that likelier.
    expect(LEGAL_HOLD_TARGET_KINDS[0]).toBe("ORGANIZATION");
  });
});

describe("dead-letter replay outcome", () => {
  it("tells a queued work item apart from a new outbound message", () => {
    // These mean different things: one is "the system will retry", the other is
    // "a new message now exists addressed to a customer".
    expect(classifyReplayResult({ version: 1, sendWorkItemId: "w1", state: "QUEUED" }))
      .toEqual({ kind: "WORK_ITEM", workItemId: "w1" });
    expect(classifyReplayResult({ version: 1, newOutboxId: "o1", state: "QUEUED" }))
      .toEqual({ kind: "NEW_OUTBOX", outboxId: "o1" });
  });

  it("returns null rather than guessing on a shape it does not recognise", () => {
    for (const value of [null, undefined, "queued", {}, { version: 1 }]) {
      expect(classifyReplayResult(value)).toBeNull();
    }
  });
});
