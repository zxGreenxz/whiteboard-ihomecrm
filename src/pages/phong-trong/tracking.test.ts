import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTracker, NOOP_TRACKER } from "./tracking";
import { fmtDuration } from "@/components/sale-phong/analyticsUtils";
import { supabase } from "@/integrations/supabase/client";

/**
 * A minimal view of the client, used only for spying.
 *
 * `supabase.rpc` carries one overload per database function, and the generated
 * Database type now spans every table in the project - enough that inferring
 * through those overloads inside `vi.spyOn` exceeds TypeScript's instantiation
 * depth (TS2589). The spy only needs to observe calls, so it attaches through
 * this narrow shape instead, the same way src/hooks/openclaw-zalo/openClawRpc.ts
 * keeps its one deliberate cast in a single place.
 */
const spyableClient = supabase as unknown as {
  rpc: (name: string, params?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
};

describe("fmtDuration", () => {
  it("formats m:ss and h:mm", () => {
    expect(fmtDuration(0)).toBe("0:00");
    expect(fmtDuration(5_000)).toBe("0:05");
    expect(fmtDuration(65_000)).toBe("1:05");
    expect(fmtDuration(600_000)).toBe("10:00");
    expect(fmtDuration(3_661_000)).toBe("1h01");
    expect(fmtDuration(-50)).toBe("0:00");
    expect(fmtDuration(NaN as unknown as number)).toBe("0:00");
  });
});

describe("createTracker", () => {
  beforeEach(() => {
    try { sessionStorage.clear(); } catch { /* node */ }
    vi.restoreAllMocks();
    // chặn mọi network thật (flush keepalive) trong test
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true } as Response)));
  });

  it("returns a no-op tracker when no token", () => {
    const t = createTracker(undefined, { isStaff: false });
    expect(t.enabled).toBe(false);
    expect(t.sessionId).toBe("");
    // không ném khi gọi các API
    expect(() => { t.track("session"); t.start(); t.stop(); }).not.toThrow();
  });

  it("buffers events and flushes via supabase.rpc (not immediately)", async () => {
    const rpc = vi.spyOn(spyableClient, "rpc").mockResolvedValue({ data: 1, error: null } as never);
    const t = createTracker("tok-abc", { isStaff: true });
    expect(t.enabled).toBe(true);
    expect(t.sessionId).toBeTruthy();

    // track chỉ đẩy buffer — chưa gọi RPC ngay
    t.track("room_open", { room_id: "11111111-1111-1111-1111-111111111111", dwell_ms: 1234 });
    expect(rpc).not.toHaveBeenCalled();

    // flush thủ công (non-final) → gọi đúng RPC với token + mảng sự kiện
    t.flush();
    expect(rpc).toHaveBeenCalled();
    const [fn, params] = rpc.mock.calls[0];
    expect(fn).toBe("log_public_room_events");
    expect(params).toHaveProperty("p_token", "tok-abc");
    expect(Array.isArray((params as { p_events: unknown[] }).p_events)).toBe(true);
  });

  it("dedupes impressions per room within a session", () => {
    const rpc = vi.spyOn(spyableClient, "rpc").mockResolvedValue({ data: 1, error: null } as never);
    const t = createTracker("tok-imp", { isStaff: false });
    const room = { room_id: "22222222-2222-2222-2222-222222222222" };
    t.track("impression", room);
    t.track("impression", room); // trùng → bỏ
    t.flush();
    const calls = rpc.mock.calls.filter((c) => c[0] === "log_public_room_events");
    const events = (calls[0]?.[1] as { p_events: { event_type: string }[] } | undefined)?.p_events ?? [];
    const impressions = events.filter((e) => e.event_type === "impression");
    expect(impressions.length).toBe(1);
  });
});

describe("NOOP_TRACKER", () => {
  it("is inert", () => {
    expect(NOOP_TRACKER.enabled).toBe(false);
    expect(() => NOOP_TRACKER.track("error")).not.toThrow();
  });
});
