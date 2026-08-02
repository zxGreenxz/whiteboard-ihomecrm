import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  OPENCLAW_OUTBOX_STATES,
  canTransitionOutbox,
  compareCursor,
} from "@/lib/openclaw-zalo/state-machine";
import type { OpenClawOutboxState } from "@/lib/openclaw-zalo/types";

describe("OpenClaw outbox state machine", () => {
  it("accepts only the closed transition graph", () => {
    const states = fc.constantFrom(...OPENCLAW_OUTBOX_STATES);
    const expected: Record<OpenClawOutboxState, readonly OpenClawOutboxState[]> = {
      QUEUED: ["LEASED", "FAILED", "DEAD_LETTER"],
      LEASED: ["QUEUED", "DISPATCHING", "FAILED", "UNKNOWN", "DEAD_LETTER"],
      DISPATCHING: ["SENT", "FAILED", "UNKNOWN", "DEAD_LETTER"],
      SENT: [],
      FAILED: [],
      UNKNOWN: [],
      DEAD_LETTER: [],
    };
    fc.assert(
      fc.property(states, states, (from, to) => {
        return canTransitionOutbox(from, to) === expected[from].includes(to);
      }),
      { numRuns: 200 },
    );
  });

  it("keeps equal-timestamp cursors ordered by id", () => {
    fc.assert(
      fc.property(fc.uuid(), fc.uuid(), (leftId, rightId) => {
        const left = { receivedAt: "2026-01-01T00:00:00.000Z", id: leftId };
        const right = { receivedAt: left.receivedAt, id: rightId };
        expect(Math.sign(compareCursor(left, right))).toBe(
          leftId < rightId ? -1 : leftId > rightId ? 1 : 0,
        );
      }),
      { numRuns: 200 },
    );
  });

  it("does not allow UNKNOWN to be mutated", () => {
    fc.assert(
      fc.property(fc.constantFrom<OpenClawOutboxState>("UNKNOWN"), states => {
        expect(canTransitionOutbox(states, "SENT")).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});
