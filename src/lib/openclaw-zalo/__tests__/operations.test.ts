import { describe, expect, it } from "vitest";

import {
  classifyResolutionFailure,
  GLOBAL_STOP_CONFIRMATION,
  globalStopConfirmationMatches,
  globalStopGate,
  UNKNOWN_OUTCOMES,
  unknownBadges,
} from "../operations";

describe("GLOBAL_STOP confirmation", () => {
  it("accepts only the exact phrase", () => {
    expect(globalStopConfirmationMatches(GLOBAL_STOP_CONFIRMATION)).toBe(true);
    for (const wrong of [
      "dung toan bo gui cua cong ty",
      "DUNG TOAN BO GUI",
      "DUNG TOAN BO GUI CUA CONG TY!",
      "DỪNG TOÀN BỘ GỬI CỦA CÔNG TY",
      "",
    ]) {
      expect(globalStopConfirmationMatches(wrong), wrong).toBe(false);
    }
  });

  it("forgives surrounding whitespace but nothing inside", () => {
    // Leading/trailing space comes from paste and mobile keyboards and changes no
    // intent. An interior change does.
    expect(globalStopConfirmationMatches(`  ${GLOBAL_STOP_CONFIRMATION}\n`)).toBe(true);
    expect(globalStopConfirmationMatches("DUNG  TOAN BO GUI CUA CONG TY")).toBe(false);
  });

  it("is unaccented, so an operator without Vietnamese input can still type it", () => {
    // A confirmation nobody can type is a confirmation that gets worked around.
    expect(GLOBAL_STOP_CONFIRMATION).toMatch(/^[A-Z ]+$/u);
  });
});

describe("GLOBAL_STOP gate", () => {
  const base = { canManageOperations: true, typedConfirmation: GLOBAL_STOP_CONFIRMATION, alreadyStopped: false };

  it("requires the permission before the phrase", () => {
    // Otherwise a member without the permission types the phrase, gets an enabled
    // button, and meets a server refusal.
    expect(globalStopGate({ ...base, canManageOperations: false, typedConfirmation: "" }).blockedBy)
      .toBe("PERMISSION");
  });

  it("refuses when the phrase does not match", () => {
    expect(globalStopGate({ ...base, typedConfirmation: "dung" }).blockedBy).toBe("CONFIRMATION");
    expect(globalStopGate(base).canStop).toBe(true);
  });

  it("does not offer a second stop when everything is already stopped", () => {
    expect(globalStopGate({ ...base, alreadyStopped: true }).blockedBy).toBe("ALREADY_STOPPED");
  });
});

describe("UNKNOWN outcomes", () => {
  it("offers exactly the three the server accepts", () => {
    expect(UNKNOWN_OUTCOMES.map(item => item.outcome)).toEqual([
      "CONFIRMED_SENT", "CONFIRMED_FAILED", "NEW_INTENT_CREATED",
    ]);
  });

  it("pairs each outcome with the reason code its schema demands", () => {
    // The request schema is a discriminated union with LITERAL reason codes, and the
    // third pair is not derivable from the second - NEW_INTENT_CREATED maps to
    // OPERATOR_CREATED_NEW_INTENT, with the words in the other order. Spelling the
    // pairs out beats a transformation that happens to reproduce them.
    expect(UNKNOWN_OUTCOMES.map(item => [item.outcome, item.reasonCode])).toEqual([
      ["CONFIRMED_SENT", "OPERATOR_CONFIRMED_SENT"],
      ["CONFIRMED_FAILED", "OPERATOR_CONFIRMED_FAILED"],
      ["NEW_INTENT_CREATED", "OPERATOR_CREATED_NEW_INTENT"],
    ]);
  });

  it("never describes an outcome as instructing the system to claim delivery", () => {
    // The operator records what they OBSERVED. "Mark as sent" would invite someone to
    // clear a queue rather than check a phone.
    const sent = UNKNOWN_OUTCOMES.find(item => item.outcome === "CONFIRMED_SENT")!;
    expect(sent.detail).toContain("tự kiểm tra");
    expect(sent.createsNewSend).toBe(false);
    const failed = UNKNOWN_OUTCOMES.find(item => item.outcome === "CONFIRMED_FAILED")!;
    expect(failed.detail).toContain("không tự gửi lại");
  });

  it("marks the one outcome that actually sends something", () => {
    expect(UNKNOWN_OUTCOMES.filter(item => item.createsNewSend).map(item => item.outcome))
      .toEqual(["NEW_INTENT_CREATED"]);
  });
});

describe("UNKNOWN badges", () => {
  it("keeps the historical UNKNOWN badge after a resolution", () => {
    // The row is evidence of what the system observed; the resolution is evidence of
    // what an operator later established. Replacing the first erases the fact that
    // the outcome was ever in doubt.
    expect(unknownBadges({ resolutionOutcome: null })).toEqual(["UNKNOWN"]);
    expect(unknownBadges({ resolutionOutcome: "CONFIRMED_SENT" }))
      .toEqual(["UNKNOWN", "CONFIRMED_SENT"]);
  });
});

describe("resolution failure classification", () => {
  it("reads 40001 as somebody else got there first", () => {
    // Resolution is one-time. The right response is to show THEIR outcome, not to
    // retry - which is why the hook reloads the winner instead of erroring.
    expect(classifyResolutionFailure({ code: "40001" })).toBe("ALREADY_RESOLVED");
    expect(classifyResolutionFailure({ code: "42501" })).toBe("PERMISSION_DENIED");
    expect(classifyResolutionFailure({ code: "22023" })).toBe("STALE_EVIDENCE");
    expect(classifyResolutionFailure(new Error("boom"))).toBe("UNKNOWN");
  });
});
