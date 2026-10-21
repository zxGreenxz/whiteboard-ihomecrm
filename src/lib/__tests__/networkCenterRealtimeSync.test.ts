// @vitest-environment jsdom
// Kênh realtime Network Center (A7, 21/10/2026 — RT-OTHER-1/2/7).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type StatusCallback = (status: string, err?: Error) => void;
type Handler = (payload: unknown) => void;

const harness = vi.hoisted(() => {
  const channels: Array<{
    topic: string;
    handlers: Map<string, Handler>;
    on: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
    cb?: StatusCallback;
  }> = [];
  return {
    channels,
    channelFactory: vi.fn((topic: string) => {
      const channel = {
        topic,
        handlers: new Map<string, Handler>(),
        on: vi.fn((_event: string, filter: { table: string }, handler: Handler) => {
          channel.handlers.set(filter.table, handler);
          return channel;
        }),
        subscribe: vi.fn((cb: StatusCallback) => {
          channel.cb = cb;
          return channel;
        }),
        cb: undefined as StatusCallback | undefined,
      };
      channels.push(channel);
      return channel;
    }),
    removeChannel: vi.fn(() => Promise.resolve("ok")),
  };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { channel: harness.channelFactory, removeChannel: harness.removeChannel },
}));

import {
  NETWORK_CENTER_REALTIME_DEBOUNCE_MS,
  subscribeNetworkCenterRealtime,
  type NetworkCenterRealtimeContext,
} from "@/lib/network-center/realtimeSync";
import { networkCenterQueryKeys } from "@/lib/network-center/queryKeys";
import { __resetChannelHealthForTest } from "@/lib/realtime/channelHealth";

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

const FLEET = networkCenterQueryKeys.fleet("actor-a", ["org-a"]);

describe("subscribeNetworkCenterRealtime", () => {
  let invalidateQueries: ReturnType<typeof vi.fn>;
  let context: NetworkCenterRealtimeContext;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-21T08:00:00Z"));
    harness.channels.length = 0;
    harness.channelFactory.mockClear();
    harness.removeChannel.mockClear();
    __resetChannelHealthForTest();
    setVisibility("visible");
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    invalidateQueries = vi.fn(async () => undefined);
    context = {
      selectedBuildingId: "building-a",
      fleetKey: FLEET,
      organizationIdOf: () => "org-a",
    };
  });

  afterEach(() => {
    warn.mockRestore();
    vi.useRealTimers();
  });

  function open() {
    return subscribeNetworkCenterRealtime({
      actorId: "actor-a",
      queryClient: { invalidateQueries } as never,
      getContext: () => context,
    });
  }
  const channel = () => harness.channels[harness.channels.length - 1];
  const fire = (table: string, payload: unknown = {}) => {
    const handler = channel().handlers.get(table);
    expect(handler, `không nghe ${table}`).toBeTypeOf("function");
    handler!(payload);
  };
  const keys = () => invalidateQueries.mock.calls.map(([f]) => (f as { queryKey: unknown[] }).queryKey);

  it("mở MỘT kênh network-center-<actor>, nghe đúng 4 bảng — không có nhịp tim worker", () => {
    const stop = open();
    expect(harness.channelFactory).toHaveBeenCalledTimes(1);
    expect(channel().topic).toBe("network-center-actor-a");
    expect([...channel().handlers.keys()].sort()).toEqual([
      "network_command_events",
      "network_device_current",
      "network_incidents",
      "network_interface_current",
    ]);
    stop();
  });

  it("gom cụm 5 s rồi làm mới fleet + toà trong payload, đúng key exact", () => {
    const stop = open();
    fire("network_device_current", { new: { building_id: "BUILDING-B" } });
    fire("network_interface_current", { new: { building_id: "building-b" } });
    vi.advanceTimersByTime(NETWORK_CENTER_REALTIME_DEBOUNCE_MS - 1);
    expect(invalidateQueries).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(keys()).toEqual([
      FLEET,
      networkCenterQueryKeys.building("actor-a", "org-a", "building-b"),
      networkCenterQueryKeys.aruba("actor-a", "org-a", "building-b"),
    ]);
    expect(invalidateQueries.mock.calls.every(([f]) => (f as { exact?: boolean }).exact === true)).toBe(true);
    stop();
  });

  it("đổi toà KHÔNG dựng lại kênh; sự kiện lệnh đọc toà đang chọn LÚC NHẬN", () => {
    const stop = open();
    context = { ...context, selectedBuildingId: "building-z" };
    fire("network_command_events", { new: { command_id: "cmd" } });
    vi.advanceTimersByTime(NETWORK_CENTER_REALTIME_DEBOUNCE_MS);
    expect(harness.channelFactory).toHaveBeenCalledTimes(1);
    expect(keys()).toContainEqual(networkCenterQueryKeys.building("actor-a", "org-a", "building-z"));
    stop();
  });

  it("tab ẩn: không refetch dù quá trần; hiện lại thì nhả một lần", () => {
    const stop = open();
    setVisibility("hidden");
    fire("network_incidents", { new: { building_id: "building-a" } });
    vi.advanceTimersByTime(30_000);
    expect(invalidateQueries).not.toHaveBeenCalled();
    setVisibility("visible");
    vi.advanceTimersByTime(0);
    expect(keys()).toContainEqual(FLEET);
    const calls = invalidateQueries.mock.calls.length;
    vi.advanceTimersByTime(30_000);
    expect(invalidateQueries.mock.calls.length).toBe(calls);
    stop();
  });

  it("dọn kênh khi còn việc chờ: NHẢ việc đó thay vì làm rơi, rồi gỡ kênh", () => {
    const stop = open();
    fire("network_device_current", { new: { building_id: "building-a" } });
    stop();
    expect(keys()).toContainEqual(FLEET);
    expect(harness.removeChannel).toHaveBeenCalledTimes(1);
  });

  it("CHANNEL_ERROR → SUBSCRIBED: làm tươi mọi query NC của actor (active) MỘT lần, bỏ việc chờ", () => {
    const stop = open();
    channel().cb!("SUBSCRIBED");
    fire("network_device_current", { new: { building_id: "building-a" } });
    channel().cb!("CHANNEL_ERROR", new Error("socket"));
    channel().cb!("SUBSCRIBED");
    expect(invalidateQueries).toHaveBeenCalledTimes(1);
    expect(invalidateQueries.mock.calls[0][0]).toEqual({
      queryKey: networkCenterQueryKeys.user("actor-a"),
      refetchType: "active",
    });
    vi.advanceTimersByTime(NETWORK_CENTER_REALTIME_DEBOUNCE_MS * 3);
    expect(invalidateQueries).toHaveBeenCalledTimes(1);
    stop();
  });
});
