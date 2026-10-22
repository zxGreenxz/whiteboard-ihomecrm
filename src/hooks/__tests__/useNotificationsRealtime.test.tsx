// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

type StatusCallback = (status: string, err?: Error) => void;
type ChangeCallback = (payload: unknown) => void;

const harness = vi.hoisted(() => {
  const channels: Array<{
    topic: string;
    bindings: Array<{ type: string; filter: Record<string, unknown>; cb: ChangeCallback }>;
    cb?: StatusCallback;
  }> = [];
  return {
    channels,
    uid: "u1" as string | null,
    channelFactory: vi.fn((topic: string) => {
      const record = { topic, bindings: [] as Array<{ type: string; filter: Record<string, unknown>; cb: ChangeCallback }>, cb: undefined as StatusCallback | undefined };
      const channel = {
        on: vi.fn((type: string, filter: Record<string, unknown>, cb: ChangeCallback) => {
          // Listener `system` của subscribeResilient (RT-CLIENT-1) không phải binding dữ liệu.
          if (type === "system") return channel;
          record.bindings.push({ type, filter, cb });
          return channel;
        }),
        subscribe: vi.fn((cb: StatusCallback) => {
          record.cb = cb;
          return channel;
        }),
      };
      channels.push(record);
      return channel;
    }),
    removeChannel: vi.fn(() => Promise.resolve("ok")),
  };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { channel: harness.channelFactory, removeChannel: harness.removeChannel },
}));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ data: harness.uid ? { id: harness.uid } : null }) }));

import { useNotificationConnectionStatus, useNotificationsRealtime } from "@/hooks/useNotifications";
import { __resetChannelHealthForTest } from "@/lib/realtime/channelHealth";
import { GOM_THONG_BAO_MS } from "@/lib/notifications/realtimeSignal";

const last = () => harness.channels[harness.channels.length - 1]!;
const emit = (payload: unknown) => last().bindings[0]!.cb(payload);
const dong = (over: Record<string, unknown> = {}) => ({ id: "n1", status: "PENDING", subject: "S", content: "C", push_state: null, ...over });

function setup() {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue(undefined);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const hook = renderHook(() => {
    useNotificationsRealtime();
    return useNotificationConnectionStatus();
  }, { wrapper });
  return { invalidate, hook };
}

describe("kênh notif-<uid> (C1)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-21T08:00:00Z"));
    harness.channels.length = 0;
    harness.uid = "u1";
    harness.channelFactory.mockClear();
    harness.removeChannel.mockClear();
    __resetChannelHealthForTest();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("nghe MỌI sự kiện của đúng người (event '*', filter user_id) — không chỉ INSERT", () => {
    setup();
    expect(last().topic).toBe("notif-u1");
    expect(last().bindings).toHaveLength(1);
    expect(last().bindings[0]).toMatchObject({
      type: "postgres_changes",
      filter: { event: "*", schema: "public", table: "notifications", filter: "user_id=eq.u1" },
    });
  });

  it("máy khác đánh dấu đã đọc (UPDATE status) ⇒ làm mới; UPDATE cột drain ⇒ bỏ qua", () => {
    const { invalidate } = setup();
    act(() => emit({ eventType: "UPDATE", old: dong(), new: dong({ push_state: "SENDING" }) }));
    vi.advanceTimersByTime(GOM_THONG_BAO_MS * 4);
    expect(invalidate).not.toHaveBeenCalled();
    act(() => emit({ eventType: "UPDATE", old: dong(), new: dong({ status: "READ" }) }));
    vi.advanceTimersByTime(GOM_THONG_BAO_MS);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["notifications"] });
  });

  it("markAll ở máy khác (300 UPDATE liền nhau) chỉ gây một lần làm mới", () => {
    const { invalidate } = setup();
    act(() => {
      for (let i = 0; i < 300; i++) emit({ eventType: "UPDATE", old: dong({ id: `n${i}` }), new: dong({ id: `n${i}`, status: "READ" }) });
    });
    vi.advanceTimersByTime(GOM_THONG_BAO_MS);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("DELETE/INSERT làm mới", () => {
    const { invalidate } = setup();
    act(() => emit({ eventType: "DELETE", old: dong(), new: {} }));
    vi.advanceTimersByTime(GOM_THONG_BAO_MS);
    act(() => emit({ eventType: "INSERT", old: {}, new: dong() }));
    vi.advanceTimersByTime(GOM_THONG_BAO_MS);
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it("rớt kênh rồi nối lại ⇒ bắt kịp NGAY (không chờ gom); trạng thái chuông đọc từ channelHealth", () => {
    const { invalidate, hook } = setup();
    expect(hook.result.current).toBe("connecting");
    act(() => last().cb!("SUBSCRIBED"));
    expect(hook.result.current).toBe("connected");
    expect(invalidate).not.toHaveBeenCalled();
    act(() => last().cb!("CHANNEL_ERROR", new Error("1006")));
    expect(hook.result.current).toBe("interrupted");
    act(() => last().cb!("SUBSCRIBED"));
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(hook.result.current).toBe("connected");
  });

  it("chưa đăng nhập: không mở kênh, chuông 'connecting'; tháo hook thì gỡ kênh và huỷ lần làm mới đang chờ", () => {
    harness.uid = null;
    const first = setup();
    expect(harness.channelFactory).not.toHaveBeenCalled();
    expect(first.hook.result.current).toBe("connecting");
    first.hook.unmount();
    harness.uid = "u1";
    const { invalidate, hook } = setup();
    act(() => emit({ eventType: "INSERT", new: dong(), old: {} }));
    hook.unmount();
    vi.advanceTimersByTime(GOM_THONG_BAO_MS * 4);
    expect(invalidate).not.toHaveBeenCalled();
    expect(harness.removeChannel).toHaveBeenCalledOnce();
  });
});
