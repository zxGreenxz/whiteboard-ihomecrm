import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  MANUAL_SEND_STATES,
  conversationCursorAfter,
  manualSendGate,
  sendLifecycle,
  threadEvents,
} from "../inboxView";
import type { OpenClawConversation, OpenClawMessage } from "../types";

const message = (id: string, receivedAt: string): OpenClawMessage => ({
  messageId: id,
  direction: "INBOUND",
  eventKind: "TEXT",
  providerTimestamp: null,
  receivedAt,
  createdAt: receivedAt,
});

const conversation = (id: string, lastReceivedAt: string): OpenClawConversation => ({
  conversationId: id,
  targetId: `target-${id}`,
  status: "OPEN",
  assignedMembershipId: null,
  unreadCount: 0,
  lastReceivedAt,
  lastMessageId: null,
  version: 1,
});

describe("thread ordering", () => {
  it("reads oldest-first even though the RPC returns newest-first", () => {
    const ordered = threadEvents([
      message("b", "2026-08-03T10:00:02.000Z"),
      message("a", "2026-08-03T10:00:01.000Z"),
    ]);
    expect(ordered.map(event => event.messageId)).toEqual(["a", "b"]);
  });

  it("collapses duplicates, which realtime and polling will both deliver", () => {
    const ordered = threadEvents([
      message("a", "2026-08-03T10:00:01.000Z"),
      message("a", "2026-08-03T10:00:01.000Z"),
      message("b", "2026-08-03T10:00:02.000Z"),
    ]);
    expect(ordered.map(event => event.messageId)).toEqual(["a", "b"]);
  });

  it("is deterministic whatever order the pages arrive in", () => {
    // Out-of-order delivery must not change what the operator sees, or two people
    // reading the same thread would disagree about the sequence of events.
    const events = [
      message("a", "2026-08-03T10:00:01.000Z"),
      message("b", "2026-08-03T10:00:02.000Z"),
      message("c", "2026-08-03T10:00:03.000Z"),
    ];
    // Compared against a LITERAL, not against threadEvents(events): running the
    // function on both sides made a sort-direction inversion invisible, because both
    // sides would have flipped together.
    fc.assert(fc.property(fc.shuffledSubarray(events, { minLength: 3 }), (shuffled) => {
      expect(threadEvents(shuffled).map(event => event.messageId)).toEqual(["a", "b", "c"]);
    }));
  });

  it("breaks ties on id so identical timestamps still have one order", () => {
    const ordered = threadEvents([
      message("z", "2026-08-03T10:00:01.000Z"),
      message("a", "2026-08-03T10:00:01.000Z"),
    ]);
    expect(ordered.map(event => event.messageId)).toEqual(["a", "z"]);
  });
});

describe("cursor pagination", () => {
  it("takes the next cursor from the LAST row of the page it was given", () => {
    // The RPC orders newest-first and pages with (received_at, id) < cursor, so the
    // cursor is the oldest row on screen. Taking the first row would re-request the
    // page just shown, forever.
    const page = [
      conversation("new", "2026-08-03T10:00:03.000Z"),
      conversation("old", "2026-08-03T10:00:01.000Z"),
    ];
    expect(conversationCursorAfter(page)).toEqual({
      lastReceivedAt: "2026-08-03T10:00:01.000Z",
      id: "old",
    });
  });

  it("returns no cursor for an empty page, which ends the pagination", () => {
    expect(conversationCursorAfter([])).toBeNull();
  });
});

describe("send lifecycle", () => {
  it("calls nothing a success except SENT", () => {
    // The plan forbids optimistic fake success. QUEUED/LEASED/DISPATCHING are all
    // "in flight" - showing any of them as delivered would tell an operator a
    // customer got a message that may never arrive.
    for (const state of MANUAL_SEND_STATES) {
      expect(sendLifecycle(state).delivered).toBe(state === "SENT");
    }
  });

  it("marks UNKNOWN as needing a human decision rather than as a failure", () => {
    // UNKNOWN means the send may or may not have reached the customer. Presenting it
    // as FAILED invites a duplicate send to a real person.
    const unknown = sendLifecycle("UNKNOWN");
    expect(unknown.delivered).toBe(false);
    expect(unknown.terminal).toBe(false);
    expect(unknown.needsResolution).toBe(true);
    expect(sendLifecycle("FAILED").needsResolution).toBe(false);
  });

  it("treats SENT, FAILED and DEAD_LETTER as the only settled outcomes", () => {
    expect(MANUAL_SEND_STATES.filter(state => sendLifecycle(state).terminal))
      .toEqual(["SENT", "FAILED", "DEAD_LETTER"]);
  });

  it("gives every state its OWN Vietnamese label, so no raw enum reaches the operator", () => {
    const labels = MANUAL_SEND_STATES.map(state => sendLifecycle(state).label);
    for (const [index, label] of labels.entries()) {
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toBe(MANUAL_SEND_STATES[index]);
    }
    // Distinct, not merely non-empty: `label = "x"` for everything, or one label
    // shared by SENT and FAILED, satisfied the previous version of this assertion.
    expect(new Set(labels).size).toBe(MANUAL_SEND_STATES.length);
  });
});

describe("manual send gate", () => {
  const base = {
    canSend: true,
    connectionState: "CONNECTED" as const,
    policy: { allowed: true, reason: "ALLOWED" as const },
    takeoverByAnotherMember: false,
  };

  it("requires the send permission before anything else", () => {
    expect(manualSendGate({ ...base, canSend: false }).blockedBy).toBe("PERMISSION");
  });

  it("refuses while the session is not connected", () => {
    expect(manualSendGate({ ...base, connectionState: "RECONNECT_REQUIRED" }).blockedBy)
      .toBe("NOT_CONNECTED");
  });

  it("surfaces the policy reason verbatim instead of a generic refusal", () => {
    // The operator needs to know it was quiet hours rather than "not allowed", or
    // they will retry into the same wall.
    const gate = manualSendGate({
      ...base,
      policy: { allowed: false, reason: "QUIET_HOURS" },
    });
    expect(gate.blockedBy).toBe("POLICY");
    expect(gate.policyReason).toBe("QUIET_HOURS");
  });

  it("blocks while another member holds the takeover", () => {
    expect(manualSendGate({ ...base, takeoverByAnotherMember: true }).blockedBy)
      .toBe("TAKEOVER_HELD");
  });

  it("allows only when every gate is open, and says so explicitly", () => {
    const gate = manualSendGate(base);
    expect(gate.blockedBy).toBeNull();
    expect(gate.canSend).toBe(true);
  });
});
