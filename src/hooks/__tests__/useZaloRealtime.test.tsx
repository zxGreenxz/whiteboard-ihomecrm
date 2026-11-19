// @vitest-environment jsdom
// Kênh realtime Zalo (A8, 21/10/2026 — RT-OTHER-2/3/7).
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type StatusCallback = (status: string, err?: Error) => void;
type Handler = () => void;

const harness = vi.hoisted(() => {
  const channels: Array<{
    topic: string;
    bindings: Array<{ table: string; filter?: string; handler: Handler }>;
    on: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
    cb?: StatusCallback;
  }> = [];
  return {
    channels,
    org: { id: "org-a" } as { id: string } | null,
    channelFactory: vi.fn((topic: string) => {
      const channel = {
        topic,
        bindings: [] as Array<{ table: string; filter?: string; handler: Handler }>,
        on: vi.fn((event: string, cfg: { table: string; filter?: string }, handler: Handler) => {
          // Listener `system` của subscribeResilient (RT-CLIENT-1) không phải bảng.
          if (event === "system") return channel;
          channel.bindings.push({ table: cfg.table, filter: cfg.filter, handler });
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
vi.mock("@/contexts/OrganizationContext", () => ({
  useOrganization: () => ({ organization: harness.org }),
}));

import { QK, useZaloRealtime, ZALO_REALTIME_DEBOUNCE_MS, ZALO_REALTIME_MAX_WAIT_MS } from "@/hooks/useZaloChat";
import { __resetChannelHealthForTest } from "@/lib/realtime/channelHealth";

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("useZaloRealtime", () => {
  let qc: QueryClient;
  let invalidate: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-21T08:00:00Z"));
    harness.channels.length = 0;
    harness.channelFactory.mockClear();
    harness.removeChannel.mockClear();
    harness.org = { id: "org-a" };
    __resetChannelHealthForTest();
    setVisibility("visible");
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    qc = new QueryClient();
    invalidate = vi.spyOn(qc, "invalidateQueries");
  });

  afterEach(() => {
    qc.clear();
    warn.mockRestore();
    vi.useRealTimers();
  });

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const kenh = (prefix: string) => harness.channels.filter((c) => c.topic.startsWith(prefix));
  const fire = (topicPrefix: string, table: string) => {
    const channel = kenh(topicPrefix).at(-1)!;
    channel.bindings.find((b) => b.table === table)!.handler();
  };
  const keys = () => invalidate.mock.calls.map(([f]) => (f as { queryKey: unknown[] }).queryKey);

  it("mở zalo-convs-<org> (3 bảng, lọc org) và zalo-msg-<hội thoại>", () => {
    const { unmount } = renderHook(() => useZaloRealtime("conv-1"), { wrapper });
    const convs = kenh("zalo-convs-")[0];
    expect(convs.topic).toBe("zalo-convs-org-a");
    expect(convs.bindings.map((b) => [b.table, b.filter])).toEqual([
      ["zalo_conversations", "organization_id=eq.org-a"],
      ["zalo_accounts", "organization_id=eq.org-a"],
      ["zalo_labels", "organization_id=eq.org-a"],
    ]);
    const msg = kenh("zalo-msg-")[0];
    expect(msg.topic).toBe("zalo-msg-conv-1");
    expect(msg.bindings.map((b) => [b.table, b.filter])).toEqual([
      ["zalo_messages", "conversation_id=eq.conv-1"],
    ]);
    unmount();
  });

  it("bão 20 sự kiện danh sách ⇒ MỘT lượt, key EXACT theo org (không kéo key thành viên)", () => {
    const { unmount } = renderHook(() => useZaloRealtime(undefined), { wrapper });
    for (let i = 0; i < 20; i += 1) {
      fire("zalo-convs-", "zalo_conversations");
      vi.advanceTimersByTime(100);
    }
    // 20 × 100 ms = 2 s < trần 2,5 s, chưa nhả vì bão chưa ngớt 800 ms.
    expect(invalidate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(ZALO_REALTIME_MAX_WAIT_MS);
    expect(keys()).toEqual([[...QK.conversations, "org-a"]]);
    expect(invalidate.mock.calls[0][0]).toMatchObject({ exact: true });
    unmount();
  });

  it("sự kiện tin nhắn chỉ làm mới luồng tin đang mở, không tải lại danh sách", () => {
    const { unmount } = renderHook(() => useZaloRealtime("conv-1"), { wrapper });
    fire("zalo-msg-", "zalo_messages");
    vi.advanceTimersByTime(ZALO_REALTIME_DEBOUNCE_MS);
    expect(keys()).toEqual([QK.messages("conv-1")]);
    unmount();
  });

  it("tab ẩn: không tải gì; hiện lại thì tải MỘT lần cho cả quãng ẩn", () => {
    const { unmount } = renderHook(() => useZaloRealtime("conv-1"), { wrapper });
    setVisibility("hidden");
    for (let i = 0; i < 10; i += 1) {
      fire("zalo-convs-", "zalo_conversations");
      fire("zalo-msg-", "zalo_messages");
      vi.advanceTimersByTime(5_000);
    }
    expect(invalidate).not.toHaveBeenCalled();
    setVisibility("visible");
    vi.advanceTimersByTime(0);
    expect(keys().sort()).toEqual([[...QK.conversations, "org-a"], QK.messages("conv-1")].sort());
    unmount();
  });

  it("CHANNEL_ERROR → SUBSCRIBED trên zalo-convs: làm tươi danh sách, tài khoản, nhãn (active) một lần", () => {
    const { unmount } = renderHook(() => useZaloRealtime(undefined), { wrapper });
    const channel = kenh("zalo-convs-")[0];
    channel.cb!("SUBSCRIBED");
    channel.cb!("CHANNEL_ERROR", new Error("socket"));
    channel.cb!("SUBSCRIBED");
    expect(keys()).toEqual([
      [...QK.conversations, "org-a"],
      [...QK.accounts, "org-a"],
      [...QK.labels, "org-a"],
    ]);
    expect(invalidate.mock.calls.every(([f]) => (f as { refetchType?: string }).refetchType === "active")).toBe(true);
    unmount();
  });

  it("đổi hội thoại chỉ dựng lại kênh tin nhắn; kênh danh sách giữ nguyên", () => {
    const { rerender, unmount } = renderHook(({ id }) => useZaloRealtime(id), {
      wrapper,
      initialProps: { id: "conv-1" },
    });
    rerender({ id: "conv-2" });
    expect(kenh("zalo-convs-")).toHaveLength(1);
    expect(kenh("zalo-msg-").map((c) => c.topic)).toEqual(["zalo-msg-conv-1", "zalo-msg-conv-2"]);
    unmount();
    expect(harness.removeChannel).toHaveBeenCalledTimes(3);
  });
});
