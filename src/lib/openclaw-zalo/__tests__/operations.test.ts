import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  buildUnknownResolutionRequest,
  classifyResolutionFailure,
  dialogFailure,
  dialogWinner,
  GLOBAL_STOP_CONFIRMATION,
  globalStopConfirmationMatches,
  globalStopGate,
  operatorEvidenceHash,
  UNKNOWN_OUTCOMES,
  unknownBadges,
  type UnknownAuthorityEvidence,
} from "../operations";

/**
 * The contract is read from the migration, so these tests fail when the server
 * changes rather than when this module does.
 */
const RPC_SQL = readFileSync(
  "supabase/migrations/20260727060000_openclaw_rpc_surface.sql",
  "utf8",
);

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
  // Every raise the resolve RPC can perform, taken from the migration rather than
  // from what this module happens to handle.
  const RAISES = (() => {
    const body = /create or replace function public\.openclaw_resolve_unknown_v1[\s\S]*?\n\$function\$;/u
      .exec(RPC_SQL);
    expect(body, "resolve RPC not found in the migration").not.toBeNull();
    return [...body![0].matchAll(/raise exception '([^']*)' using errcode='([0-9A-Z]+)'/gu)]
      .map(match => ({ message: match[1], code: match[2] }));
  })();

  it("covers every error the server can actually raise", () => {
    expect(RAISES.length).toBeGreaterThan(0);
    for (const raised of RAISES) {
      expect(classifyResolutionFailure(raised), `${raised.code} ${raised.message}`)
        .not.toBe("UNKNOWN");
    }
  });

  it("separates the three different meanings of 40001", () => {
    // The SQLSTATE alone cannot say what happened, so the message has to be read.
    // Telling an operator "someone else resolved it" when the real problem is stale
    // evidence sends them looking for a winner that does not exist.
    expect(classifyResolutionFailure({
      code: "40001", message: "UNKNOWN resolution concurrent winner",
    })).toBe("ALREADY_RESOLVED");
    expect(classifyResolutionFailure({
      code: "40001", message: "UNKNOWN resolution lost CAS",
    })).toBe("ALREADY_RESOLVED");
    expect(classifyResolutionFailure({
      code: "40001", message: "UNKNOWN authority evidence mismatch",
    })).toBe("STALE_EVIDENCE");
    expect(classifyResolutionFailure({
      code: "40001", message: "new UNKNOWN intent was not created",
    })).toBe("NEW_SEND_FAILED");
  });

  it("calls a malformed request what it is instead of blaming stale evidence", () => {
    // 22023 is only ever raised for a request this client built wrong. Retrying it
    // fails identically, so it must not be dressed up as a concurrency problem.
    expect(classifyResolutionFailure({
      code: "22023", message: "UNKNOWN outcome/reason mismatch",
    })).toBe("MALFORMED_REQUEST");
    expect(classifyResolutionFailure({
      code: "22023", message: "newIntent must be null unless NEW_INTENT_CREATED",
    })).toBe("MALFORMED_REQUEST");
  });

  it("does not claim to recognise codes the resolve path never raises", () => {
    // 55000 belongs to immutability triggers on other tables; mapping it here was
    // an invented meaning.
    expect(RAISES.some(raised => raised.code === "55000")).toBe(false);
    expect(classifyResolutionFailure({ code: "55000", message: "x is immutable" }))
      .toBe("UNKNOWN");
    expect(classifyResolutionFailure({ code: "42501", message: "authentication required" }))
      .toBe("PERMISSION_DENIED");
    expect(classifyResolutionFailure(new Error("boom"))).toBe("UNKNOWN");
    expect(classifyResolutionFailure(null)).toBe("UNKNOWN");
  });
});

describe("which conclusion the dialog shows", () => {
  const settled = {
    resolutionId: "r-1",
    outcome: "CONFIRMED_SENT" as const,
    resolvedAt: "2026-08-03T10:00:00Z",
    newOutboxId: null,
  };
  const mine = {
    resolutionId: "r-2",
    outcome: "CONFIRMED_FAILED" as const,
    resolvedAt: "2026-08-03T11:00:00Z",
    newOutboxId: null,
  };

  it("shows the conclusion a row already carries", () => {
    // "Xem kết luận" used to open a dialog that showed nothing and offered to
    // resolve a row somebody had already resolved, because the winner was only ever
    // learned from this session's own mutation.
    expect(dialogWinner({
      openOutboxId: "ob-1", mutationWinner: null, rowResolution: settled,
    })).toEqual(settled);
  });

  it("prefers this session's own result over the list, which may be stale", () => {
    expect(dialogWinner({
      openOutboxId: "ob-1",
      mutationWinner: { outboxId: "ob-1", winner: mine },
      rowResolution: settled,
    })).toEqual(mine);
  });

  it("never shows one row's conclusion under another row", () => {
    // The close button is not disabled while a write is in flight, so a callback
    // can land after the operator moved on. Untagged state would then put ob-1's
    // outcome under ob-2's heading - and an operator would read it as settled.
    expect(dialogWinner({
      openOutboxId: "ob-2",
      mutationWinner: { outboxId: "ob-1", winner: mine },
      rowResolution: null,
    })).toBeNull();
    expect(dialogWinner({
      openOutboxId: "ob-2",
      mutationWinner: { outboxId: "ob-1", winner: mine },
      rowResolution: settled,
    })).toEqual(settled);
  });

  it("shows nothing when no row is open", () => {
    expect(dialogWinner({
      openOutboxId: null,
      mutationWinner: { outboxId: "ob-1", winner: mine },
      rowResolution: settled,
    })).toBeNull();
  });

  it("keeps a failure message with the row it was raised for", () => {
    expect(dialogFailure({
      openOutboxId: "ob-1", failure: { outboxId: "ob-1", message: "hỏng" },
    })).toBe("hỏng");
    expect(dialogFailure({
      openOutboxId: "ob-2", failure: { outboxId: "ob-1", message: "hỏng" },
    })).toBeNull();
    expect(dialogFailure({
      openOutboxId: null, failure: { outboxId: "ob-1", message: "hỏng" },
    })).toBeNull();
  });
});

describe("UNKNOWN resolution request", () => {
  const authority: UnknownAuthorityEvidence = {
    authoritativeEvidenceDomain: "ihome-openclaw-unknown-authority-v1\\0",
    authoritativeEvidenceHash: "b".repeat(64),
    resolutionVersion: 0,
  };
  const base = {
    organizationId: "dddd0000-0000-4000-8000-000000000001",
    outboxId: "ob-1",
    authority,
    operatorEvidenceHash: "a".repeat(64),
  };

  /**
   * The key lists the server enforces, read out of the migration. The resolve RPC
   * validates strictly twice - once for the request, once for the nested newIntent -
   * so this returns one entry per validation in the order they appear.
   */
  function strictKeyLists(functionName: string): string[][] {
    const body = new RegExp(
      `create or replace function public\\.${functionName}[\\s\\S]*?\\n\\$function\\$;`, "u",
    ).exec(RPC_SQL);
    expect(body, `${functionName} not found`).not.toBeNull();
    const calls = [...body![0].matchAll(
      /openclaw_assert_strict_object_v1\(([\s\S]*?)\n\s*\);/gu,
    )];
    expect(calls.length, `${functionName} does not validate strictly`).toBeGreaterThan(0);
    return calls.map(call => {
      const firstArray = /array\[([\s\S]*?)\]/u.exec(call[1]);
      expect(firstArray, "no accepted-key array").not.toBeNull();
      return [...firstArray![1].matchAll(/'([^']+)'/gu)].map(match => match[1]);
    });
  }

  it("sends exactly the keys the server accepts, no more and no fewer", () => {
    // The server refuses an unexpected key before it runs anything, so a builder
    // that drifts from this list fails every call rather than degrading.
    const accepted = strictKeyLists("openclaw_resolve_unknown_v1")[0];
    const built = buildUnknownResolutionRequest({ ...base, outcome: "CONFIRMED_SENT", newIntent: null });
    expect(Object.keys(built).filter(key => key !== "version").sort())
      .toEqual(accepted.filter(key => key !== "version").sort());
  });

  it("echoes the authority evidence rather than rebuilding it", () => {
    // The server recomputes the hash and compares exactly; anything constructed
    // here - including re-deriving the trailing "\\0" of the domain - is a 40001.
    const built = buildUnknownResolutionRequest({ ...base, outcome: "CONFIRMED_FAILED", newIntent: null });
    expect(built.expectedEvidenceHash).toBe(authority.authoritativeEvidenceHash);
    expect(built.expectedEvidenceDomain).toBe(authority.authoritativeEvidenceDomain);
    expect(built.expectedResolutionVersion).toBe(0);
  });

  it("pairs each outcome with the one reason code the server allows", () => {
    for (const outcome of UNKNOWN_OUTCOMES) {
      const built = buildUnknownResolutionRequest({
        ...base,
        outcome: outcome.outcome,
        newIntent: outcome.createsNewSend
          ? {
            clientOperationId: "op-1", targetId: "t-1", sourceDraftId: "d-1",
            expectedDraftVersion: 3, replyToMessageId: null,
          }
          : null,
      });
      expect(built.reasonCode).toBe(outcome.reasonCode);
    }
  });

  it("builds newIntent with exactly the nested keys the server requires", () => {
    const lists = strictKeyLists("openclaw_resolve_unknown_v1");
    expect(lists.length, "newIntent is no longer validated strictly").toBeGreaterThan(1);
    const accepted = lists[1];
    const built = buildUnknownResolutionRequest({
      ...base,
      outcome: "NEW_INTENT_CREATED",
      newIntent: {
        clientOperationId: "op-1", targetId: "t-1", sourceDraftId: "d-1",
        expectedDraftVersion: 3, replyToMessageId: "m-9",
      },
    });
    expect(Object.keys(built.newIntent as object).sort()).toEqual([...accepted].sort());
  });

  it("refuses the pairings the server would reject with 22023", () => {
    // Catching these here turns a server error the operator cannot act on into a
    // programming error visible in tests.
    expect(() => buildUnknownResolutionRequest({
      ...base, outcome: "CONFIRMED_SENT",
      newIntent: {
        clientOperationId: "op-1", targetId: "t-1", sourceDraftId: "d-1",
        expectedDraftVersion: 1, replyToMessageId: null,
      },
    })).toThrow(/must not carry newIntent/u);
    expect(() => buildUnknownResolutionRequest({
      ...base, outcome: "NEW_INTENT_CREATED", newIntent: null,
    })).toThrow(/requires newIntent/u);
  });

  it("refuses an operator evidence hash the server would reject", () => {
    for (const bad of ["", "abc", "A".repeat(64), "g".repeat(64), "a".repeat(63)]) {
      expect(() => buildUnknownResolutionRequest({
        ...base, operatorEvidenceHash: bad, outcome: "CONFIRMED_SENT", newIntent: null,
      }), bad).toThrow(/64 lowercase hex/u);
    }
  });

  it("derives the operator hash from the observation, not from nothing", async () => {
    const observed = {
      outboxId: "ob-1", outcome: "CONFIRMED_SENT" as const,
      observedAt: "2026-08-03T10:00:00Z", observation: "Đã mở máy khách, thấy tin.",
    };
    const hash = await operatorEvidenceHash(observed);
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    // Same observation, same hash; a different observation, a different hash.
    expect(await operatorEvidenceHash(observed)).toBe(hash);
    expect(await operatorEvidenceHash({ ...observed, observation: "Không thấy tin." }))
      .not.toBe(hash);
    expect(await operatorEvidenceHash({ ...observed, outcome: "CONFIRMED_FAILED" }))
      .not.toBe(hash);
  });
});
