// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type StatusCallback = (status: string, err?: Error) => void;

const harness = vi.hoisted(() => {
  const channels: Array<{ topic: string; on: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn>; cb?: StatusCallback }> = [];
  return {
    channels,
    channelFactory: vi.fn((topic: string) => {
      const channel = {
        topic,
        on: vi.fn(() => channel),
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
  AN_TAB_TOI_THIEU_MS,
  BACKOFF_DUNG_LAI_MS,
  GIAN_CACH_BAT_KIP_MS,
  ON_DINH_SAU_MS,
  subscribeResilient,
} from "@/lib/realtime/subscribeResilient";
import {
  __resetChannelHealthForTest,
  getRealtimeHealth,
  requestResyncAll,
} from "@/lib/realtime/channelHealth";

function last() {
  return harness.channels[harness.channels.length - 1];
}

/** Callback `system` mà subscribeResilient gắn lên kênh (RT-CLIENT-1). */
function systemCb(channel = last()) {
  const call = channel.on.mock.calls.find((args: unknown[]) => args[0] === "system");
  if (!call) throw new Error("kênh chưa gắn listener system");
  return call[2] as (payload: unknown) => void;
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("subscribeResilient", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-21T08:00:00Z"));
    harness.channels.length = 0;
    harness.channelFactory.mockClear();
    harness.removeChannel.mockClear();
    __resetChannelHealthForTest();
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    setVisibility("visible");
  });

  afterEach(() => {
    warn.mockRestore();
    vi.useRealTimers();
  });

  function open(onResync = vi.fn()) {
    const bind = vi.fn((channel) => channel.on("postgres_changes", {}, () => undefined));
    const stop = subscribeResilient({ id: "hub", topic: "crm-data-sync-u1", bind, onResync });
    return { stop, bind, onResync };
  }

  it("lần SUBSCRIBED đầu không bắt kịp, store chuyển connecting → connected", () => {
    const { onResync, bind } = open();
    expect(bind).toHaveBeenCalledTimes(1);
    expect(getRealtimeHealth().state).toBe("connecting");
    last().cb!("SUBSCRIBED");
    expect(onResync).not.toHaveBeenCalled();
    expect(getRealtimeHealth().state).toBe("connected");
  });

  it("CHANNEL_ERROR rồi SUBSCRIBED lại thì bắt kịp đúng một lần", () => {
    const { onResync } = open();
    last().cb!("SUBSCRIBED");
    last().cb!("CHANNEL_ERROR", new Error("socket 1006"));
    expect(getRealtimeHealth().state).toBe("interrupted");
    expect(getRealtimeHealth().interruptedSince).toBe(Date.now());
    last().cb!("SUBSCRIBED");
    expect(onResync).toHaveBeenCalledTimes(1);
    expect(getRealtimeHealth().state).toBe("connected");
    // SUBSCRIBED lặp không kèm gián đoạn: không bắt kịp thêm.
    last().cb!("SUBSCRIBED");
    expect(onResync).toHaveBeenCalledTimes(1);
  });

  it("hai gián đoạn sát nhau: lượt bắt kịp thứ hai bị giãn cách thì HOÃN tới hết giãn cách, không vứt (RT-CLIENT-3)", () => {
    const { onResync } = open();
    last().cb!("SUBSCRIBED");
    last().cb!("TIMED_OUT");
    last().cb!("SUBSCRIBED");
    expect(onResync).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(GIAN_CACH_BAT_KIP_MS - 1);
    last().cb!("CHANNEL_ERROR");
    last().cb!("SUBSCRIBED");
    // Chưa hết giãn cách: chưa gọi ngay, nhưng đã hẹn một lượt trailing.
    expect(onResync).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(onResync).toHaveBeenCalledTimes(2);
    // Gián đoạn thứ ba ngay sau lượt trailing: lại hoãn đủ một khoảng giãn cách.
    last().cb!("CHANNEL_ERROR");
    last().cb!("SUBSCRIBED");
    expect(onResync).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(GIAN_CACH_BAT_KIP_MS);
    expect(onResync).toHaveBeenCalledTimes(3);
    // Không có gián đoạn mới thì không có lượt nào nữa.
    vi.advanceTimersByTime(GIAN_CACH_BAT_KIP_MS * 3);
    expect(onResync).toHaveBeenCalledTimes(3);
  });

  it("tab hiện lại bắt kịp trước, kênh join lại ngay sau: lượt SUBSCRIBED bị giãn cách được hoãn chứ không mất (RT-CLIENT-3)", () => {
    const { onResync } = open();
    last().cb!("SUBSCRIBED");
    setVisibility("hidden");
    vi.advanceTimersByTime(AN_TAB_TOI_THIEU_MS);
    last().cb!("CHANNEL_ERROR");
    setVisibility("visible");
    expect(onResync).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_500);
    last().cb!("SUBSCRIBED");
    expect(onResync).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(GIAN_CACH_BAT_KIP_MS - 1_500);
    expect(onResync).toHaveBeenCalledTimes(2);
  });

  it("lượt trailing được phủ bởi lượt bắt kịp chạy trước hạn, và bị huỷ khi dọn kênh", () => {
    const { onResync, stop } = open();
    last().cb!("SUBSCRIBED");
    last().cb!("TIMED_OUT");
    last().cb!("SUBSCRIBED");
    last().cb!("TIMED_OUT");
    last().cb!("SUBSCRIBED");
    expect(onResync).toHaveBeenCalledTimes(1);
    requestResyncAll();
    expect(onResync).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(GIAN_CACH_BAT_KIP_MS);
    expect(onResync).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(1);
    last().cb!("TIMED_OUT");
    last().cb!("SUBSCRIBED");
    expect(onResync).toHaveBeenCalledTimes(3);
    last().cb!("TIMED_OUT");
    last().cb!("SUBSCRIBED");
    stop();
    vi.advanceTimersByTime(GIAN_CACH_BAT_KIP_MS);
    expect(onResync).toHaveBeenCalledTimes(3);
  });

  it("join đầu TIMED_OUT trước lần SUBSCRIBED đầu thì vẫn bắt kịp đúng một lần (RT-CLIENT-4)", () => {
    const { onResync } = open();
    last().cb!("TIMED_OUT");
    expect(getRealtimeHealth().state).toBe("interrupted");
    last().cb!("SUBSCRIBED");
    expect(onResync).toHaveBeenCalledTimes(1);
    expect(getRealtimeHealth().state).toBe("connected");
    last().cb!("SUBSCRIBED");
    vi.advanceTimersByTime(GIAN_CACH_BAT_KIP_MS * 2);
    expect(onResync).toHaveBeenCalledTimes(1);
  });

  it("CLOSED trước lần SUBSCRIBED đầu, dựng lại thành công thì bắt kịp (RT-CLIENT-4)", async () => {
    const { onResync } = open();
    last().cb!("CLOSED");
    await vi.advanceTimersByTimeAsync(BACKOFF_DUNG_LAI_MS[0]);
    last().cb!("SUBSCRIBED");
    expect(onResync).toHaveBeenCalledTimes(1);
  });

  it("CLOSED ngoài ý muốn: gỡ kênh cũ, dựng kênh mới có hậu tố thế hệ, bắt kịp khi join lại", async () => {
    const { onResync, bind } = open();
    const first = last();
    first.cb!("SUBSCRIBED");
    first.cb!("CLOSED");
    expect(harness.channelFactory).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(BACKOFF_DUNG_LAI_MS[0]);
    expect(harness.removeChannel).toHaveBeenCalledWith(first);
    expect(harness.channelFactory).toHaveBeenLastCalledWith("crm-data-sync-u1:r1");
    expect(bind).toHaveBeenCalledTimes(2);
    // Callback muộn của kênh cũ bị bỏ qua (không dựng lại vòng nữa).
    first.cb!("CLOSED");
    await vi.advanceTimersByTimeAsync(BACKOFF_DUNG_LAI_MS[1]);
    expect(harness.channelFactory).toHaveBeenCalledTimes(2);
    last().cb!("SUBSCRIBED");
    expect(onResync).toHaveBeenCalledTimes(1);
  });

  it("CLOSED lặp lại thì giãn backoff tăng dần", async () => {
    open();
    last().cb!("CLOSED");
    await vi.advanceTimersByTimeAsync(BACKOFF_DUNG_LAI_MS[0]);
    last().cb!("CLOSED");
    await vi.advanceTimersByTimeAsync(BACKOFF_DUNG_LAI_MS[0]);
    expect(harness.channelFactory).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(BACKOFF_DUNG_LAI_MS[1] - BACKOFF_DUNG_LAI_MS[0]);
    expect(harness.channelFactory).toHaveBeenLastCalledWith("crm-data-sync-u1:r2");
  });

  it("SUBSCRIBED chưa ổn định thì backoff KHÔNG về đầu; giữ đủ ON_DINH_SAU_MS mới về đầu (RT-CLIENT-5)", async () => {
    open();
    last().cb!("SUBSCRIBED");
    last().cb!("CLOSED");
    await vi.advanceTimersByTimeAsync(BACKOFF_DUNG_LAI_MS[0]);
    expect(harness.channelFactory).toHaveBeenCalledTimes(2);
    // Server nhận join rồi đóng ngay: lần dựng lại sau phải chờ mức backoff kế.
    last().cb!("SUBSCRIBED");
    vi.advanceTimersByTime(ON_DINH_SAU_MS - 1);
    last().cb!("CLOSED");
    await vi.advanceTimersByTimeAsync(BACKOFF_DUNG_LAI_MS[0]);
    expect(harness.channelFactory).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(BACKOFF_DUNG_LAI_MS[1] - BACKOFF_DUNG_LAI_MS[0]);
    expect(harness.channelFactory).toHaveBeenCalledTimes(3);
    // Lần này giữ SUBSCRIBED đủ lâu ⇒ lần CLOSED kế tiếp lại chờ mức đầu.
    last().cb!("SUBSCRIBED");
    vi.advanceTimersByTime(ON_DINH_SAU_MS);
    last().cb!("CLOSED");
    await vi.advanceTimersByTimeAsync(BACKOFF_DUNG_LAI_MS[0]);
    expect(harness.channelFactory).toHaveBeenCalledTimes(4);
  });

  it("trong vòng dựng lại store giữ 'interrupted' với mốc của lần rớt đầu, không nhảy về 'connecting' (RT-CLIENT-5)", async () => {
    open();
    last().cb!("SUBSCRIBED");
    const roiLuc = Date.now();
    last().cb!("CLOSED");
    await vi.advanceTimersByTimeAsync(BACKOFF_DUNG_LAI_MS[0]);
    expect(harness.channelFactory).toHaveBeenCalledTimes(2);
    expect(getRealtimeHealth()).toMatchObject({ state: "interrupted", interruptedSince: roiLuc });
    last().cb!("CLOSED");
    await vi.advanceTimersByTimeAsync(BACKOFF_DUNG_LAI_MS[1]);
    expect(harness.channelFactory).toHaveBeenCalledTimes(3);
    expect(getRealtimeHealth()).toMatchObject({ state: "interrupted", interruptedSince: roiLuc });
    last().cb!("SUBSCRIBED");
    expect(getRealtimeHealth().state).toBe("connected");
  });

  it("teardown chủ động: không cảnh báo, không dựng lại, rời store", async () => {
    const { stop } = open();
    const channel = last();
    channel.cb!("SUBSCRIBED");
    stop();
    expect(harness.removeChannel).toHaveBeenCalledWith(channel);
    channel.cb!("CLOSED");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(warn).not.toHaveBeenCalled();
    expect(harness.channelFactory).toHaveBeenCalledTimes(1);
    expect(getRealtimeHealth().channels).toEqual({});
    stop();
    expect(harness.removeChannel).toHaveBeenCalledTimes(1);
  });

  it("tab ẩn quá ngưỡng rồi hiện lại thì bắt kịp; ẩn ngắn thì không", () => {
    const { onResync } = open();
    last().cb!("SUBSCRIBED");
    setVisibility("hidden");
    vi.advanceTimersByTime(AN_TAB_TOI_THIEU_MS - 1);
    setVisibility("visible");
    expect(onResync).not.toHaveBeenCalled();
    setVisibility("hidden");
    vi.advanceTimersByTime(AN_TAB_TOI_THIEU_MS);
    setVisibility("visible");
    expect(onResync).toHaveBeenCalledTimes(1);
  });

  it("sự kiện online bắt kịp sau khi đã từng SUBSCRIBED", () => {
    const { onResync } = open();
    window.dispatchEvent(new Event("online"));
    expect(onResync).not.toHaveBeenCalled();
    last().cb!("SUBSCRIBED");
    window.dispatchEvent(new Event("online"));
    expect(onResync).toHaveBeenCalledTimes(1);
  });

  it("requestResyncAll bắt kịp ngay, bỏ qua giãn cách", () => {
    const { onResync } = open();
    last().cb!("SUBSCRIBED");
    requestResyncAll();
    requestResyncAll();
    expect(onResync).toHaveBeenCalledTimes(2);
  });

  it("onResync ném lỗi không làm vỡ vòng đời kênh", () => {
    const onResync = vi.fn(() => {
      throw new Error("boom");
    });
    open(onResync);
    last().cb!("SUBSCRIBED");
    last().cb!("CHANNEL_ERROR");
    expect(() => last().cb!("SUBSCRIBED")).not.toThrow();
    expect(getRealtimeHealth().state).toBe("connected");
  });

  it("system báo lỗi postgres_changes dù SUBSCRIBED: cảnh báo + 'interrupted'; system 'ok' thì về connected và bắt kịp (RT-CLIENT-1)", () => {
    const { onResync } = open();
    last().cb!("SUBSCRIBED");
    expect(getRealtimeHealth().state).toBe("connected");
    // Thông điệp system khác (replication_ready…) hoặc 'ok' khi không có lỗi: bỏ qua.
    systemCb()({ extension: "system", status: "error", message: "khác" });
    systemCb()({ extension: "postgres_changes", status: "ok", message: "Subscribed to PostgreSQL" });
    expect(getRealtimeHealth().state).toBe("connected");
    expect(warn).not.toHaveBeenCalled();
    expect(onResync).not.toHaveBeenCalled();

    const loiLuc = Date.now();
    systemCb()({
      extension: "postgres_changes",
      status: "error",
      message: "Unable to subscribe to changes with given parameters … table: meters",
      channel: "crm-data-sync-u1",
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("postgres_changes lỗi"),
      expect.stringContaining("table: meters"),
    );
    expect(getRealtimeHealth()).toMatchObject({ state: "interrupted", interruptedSince: loiLuc });

    // Join lại trong lúc lỗi chưa gỡ: vẫn 'interrupted' với mốc cũ, chưa bắt kịp.
    vi.advanceTimersByTime(5_000);
    last().cb!("CHANNEL_ERROR");
    last().cb!("SUBSCRIBED");
    expect(getRealtimeHealth()).toMatchObject({ state: "interrupted", interruptedSince: loiLuc });
    expect(onResync).not.toHaveBeenCalled();

    systemCb()({ extension: "postgres_changes", status: "ok", message: "Subscribed to PostgreSQL" });
    expect(getRealtimeHealth().state).toBe("connected");
    expect(onResync).toHaveBeenCalledTimes(1);
  });

  it("system của kênh CŨ (đã bị thay khi dựng lại) bị bỏ qua", async () => {
    open();
    const first = last();
    first.cb!("SUBSCRIBED");
    first.cb!("CLOSED");
    await vi.advanceTimersByTimeAsync(BACKOFF_DUNG_LAI_MS[0]);
    last().cb!("SUBSCRIBED");
    expect(getRealtimeHealth().state).toBe("connected");
    systemCb(first)({ extension: "postgres_changes", status: "error", message: "cũ" });
    expect(getRealtimeHealth().state).toBe("connected");
  });

  it("kênh không có .on hợp lệ (mock/webview rút gọn) vẫn subscribe bình thường, chỉ thiếu listener system", () => {
    // bind trả về kênh không có .on (mock/webview rút gọn).
    const bind = (channel: Parameters<Parameters<typeof subscribeResilient>[0]["bind"]>[0]) => {
      (channel as unknown as { on?: unknown }).on = undefined;
      return channel;
    };
    subscribeResilient({ id: "bare", topic: "bare", bind, onResync: vi.fn() });
    expect(last().subscribe).toHaveBeenCalledTimes(1);
    last().cb!("SUBSCRIBED");
    expect(getRealtimeHealth().channels).toMatchObject({ bare: "connected" });
  });

  it("store tổng hợp: một kênh rớt là cả cụm rớt, mốc là kênh rớt sớm nhất", () => {
    const a = subscribeResilient({ id: "a", topic: "a", bind: (c) => c, onResync: vi.fn() });
    const chA = last();
    const b = subscribeResilient({ id: "b", topic: "b", bind: (c) => c, onResync: vi.fn() });
    const chB = last();
    chA.cb!("SUBSCRIBED");
    chB.cb!("SUBSCRIBED");
    chA.cb!("TIMED_OUT");
    const since = Date.now();
    vi.advanceTimersByTime(5_000);
    chB.cb!("CHANNEL_ERROR");
    expect(getRealtimeHealth()).toMatchObject({ state: "interrupted", interruptedSince: since });
    chA.cb!("SUBSCRIBED");
    expect(getRealtimeHealth().interruptedSince).toBe(since + 5_000);
    chB.cb!("SUBSCRIBED");
    expect(getRealtimeHealth().state).toBe("connected");
    a();
    b();
  });
});
