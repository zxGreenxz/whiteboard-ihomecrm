import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createOpenClawRealtimeEvent, shouldInvalidateOpenClawRealtime } from "@/hooks/openclaw-zalo/useOpenClawRealtime";
import type { RealtimeDedupeState } from "@/lib/openclaw-zalo/state-machine";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACCOUNT = "11111111-1111-4111-8111-111111111111";

describe("OpenClaw Realtime", () => {
  it("dedupes duplicate events but accepts a unique late event", () => {
    fc.assert(
      fc.property(fc.uuid(), fc.integer({ min: 1, max: 86_400 }), (rowId, seconds) => {
        const payload = {
          eventType: "UPDATE",
          commit_timestamp: "2026-01-02T00:00:00Z",
          new: { id: rowId, organization_id: ORG, account_id: ACCOUNT },
        };
        const first = createOpenClawRealtimeEvent("openclaw_messages", payload, ORG, ACCOUNT)!;
        const duplicate = createOpenClawRealtimeEvent("openclaw_messages", payload, ORG, ACCOUNT)!;
        const lateAt = new Date(Date.parse(payload.commit_timestamp) - seconds * 1000).toISOString();
        const late = createOpenClawRealtimeEvent("openclaw_messages", { ...payload, commit_timestamp: lateAt }, ORG, ACCOUNT)!;
        let state: RealtimeDedupeState = { seen: new Set<string>() };
        const accepted = shouldInvalidateOpenClawRealtime(state, first);
        state = accepted.state;
        expect(accepted.accepted).toBe(true);
        expect(shouldInvalidateOpenClawRealtime(state, duplicate).accepted).toBe(false);
        expect(shouldInvalidateOpenClawRealtime(state, late).accepted).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("never crosses organization/account boundaries", () => {
    fc.assert(
      fc.property(fc.uuid().filter(value => value !== ORG), fc.uuid().filter(value => value !== ACCOUNT), (organizationId, accountId) => {
        const event = createOpenClawRealtimeEvent("openclaw_messages", {
          eventType: "INSERT",
          new: { id: "33333333-3333-4333-8333-333333333333", organization_id: organizationId, account_id: accountId },
        }, ORG, ACCOUNT);
        expect(event).toBeNull();
      }),
      { numRuns: 100 },
    );
  });
});
