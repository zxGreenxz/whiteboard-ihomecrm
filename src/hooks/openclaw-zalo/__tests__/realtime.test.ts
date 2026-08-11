import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  createOpenClawRealtimeEvent,
  openClawRealtimeInvalidationKeys,
  OPENCLAW_REALTIME_DEBOUNCE_MS,
  OPENCLAW_REALTIME_MAX_WAIT_MS,
  scheduleRealtimeFlush,
  shouldInvalidateOpenClawRealtime,
} from "@/hooks/openclaw-zalo/useOpenClawRealtime";
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

describe("realtime refresh under a firehose", () => {
  // An account syncing its Zalo history writes continuously. A plain debounce
  // never fires while events keep arriving, so the conversation list was
  // cancelled and restarted about ten times a second and the inbox showed
  // "Đang tải hội thoại…" forever while every request returned 200.
  it("still flushes while events never stop arriving", () => {
    let queuedSince: number | null = null;
    let lastFlushAt = 0;
    let now = 0;
    const gaps: number[] = [];

    // One row change every 50ms for 20 seconds: no quiet period, ever.
    for (let tick = 0; tick < 400; tick += 1) {
      now += 50;
      const schedule = scheduleRealtimeFlush(now, queuedSince);
      queuedSince = schedule.queuedSince;
      const firesAt = now + schedule.delayMs;
      // The timer is rearmed by the next event unless it fires first.
      if (firesAt <= now + 50) {
        gaps.push(firesAt - lastFlushAt);
        lastFlushAt = firesAt;
        queuedSince = null;
      }
    }

    expect(gaps.length).toBeGreaterThan(0);
    for (const gap of gaps) {
      expect(gap).toBeLessThanOrEqual(OPENCLAW_REALTIME_MAX_WAIT_MS + 100);
    }
  });

  it("waits out a burst that does go quiet, instead of refetching per row", () => {
    const first = scheduleRealtimeFlush(1_000, null);
    expect(first.delayMs).toBe(OPENCLAW_REALTIME_DEBOUNCE_MS);
    const second = scheduleRealtimeFlush(1_100, first.queuedSince);
    expect(second.delayMs).toBe(OPENCLAW_REALTIME_DEBOUNCE_MS);
    expect(second.queuedSince).toBe(1_000);
  });

  it("never postpones past the ceiling", () => {
    const schedule = scheduleRealtimeFlush(5_000, 1_200);
    expect(schedule.delayMs).toBe(200);
  });

  it("refreshes only what a row change can affect", () => {
    const organizationId = "aaaa0000-0000-4000-8000-000000000001";
    const accountId = "aaaa1000-0000-4000-8000-000000000001";
    const inbox = openClawRealtimeInvalidationKeys("openclaw_messages", organizationId, accountId);
    const flattened = inbox.map(key => key.join("/"));
    expect(flattened.some(key => key.endsWith("conversations"))).toBe(true);
    expect(flattened.some(key => key.endsWith("messages"))).toBe(true);
    // A message must not drag the bootstrap or the overview along with it.
    expect(flattened.some(key => key.endsWith("bootstrap"))).toBe(false);
    expect(flattened.some(key => key.endsWith("overview"))).toBe(false);

    const connection = openClawRealtimeInvalidationKeys("openclaw_accounts", organizationId, accountId)
      .map(key => key.join("/"));
    expect(connection.some(key => key.endsWith("bootstrap"))).toBe(true);
    expect(connection.some(key => key.endsWith("conversations"))).toBe(false);
  });
});
