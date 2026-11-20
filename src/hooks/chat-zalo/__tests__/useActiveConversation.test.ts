// @vitest-environment jsdom
// Chốt hội thoại mặc định + bỏ chọn khi đổi công ty (A8 — RT-OTHER-M2, RT-OTHER-7).
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useActiveConversation, useConversationReply } from "@/hooks/chat-zalo/useActiveConversation";

import type { ZaloMessage } from "@/components/chat-zalo/types";

type Props = { list: { id: string }[]; org: string | null };

describe("useActiveConversation", () => {
  it("chốt hội thoại đầu MỘT lần; danh sách đổi thứ tự không đổi hội thoại đang mở", () => {
    const { result, rerender } = renderHook(({ list, org }: Props) => useActiveConversation(list, org), {
      initialProps: { list: [{ id: "a" }, { id: "b" }], org: "org-1" },
    });
    expect(result.current[0]).toBe("a");
    rerender({ list: [{ id: "b" }, { id: "a" }], org: "org-1" });
    expect(result.current[0]).toBe("a");
  });

  it("chưa có danh sách thì chưa chọn; danh sách về thì chốt", () => {
    const { result, rerender } = renderHook(({ list, org }: Props) => useActiveConversation(list, org), {
      initialProps: { list: [], org: "org-1" },
    });
    expect(result.current[0]).toBe("");
    rerender({ list: [{ id: "x" }], org: "org-1" });
    expect(result.current[0]).toBe("x");
  });

  it("người dùng chọn thì giữ lựa chọn đó", () => {
    const { result, rerender } = renderHook(({ list, org }: Props) => useActiveConversation(list, org), {
      initialProps: { list: [{ id: "a" }, { id: "b" }], org: "org-1" },
    });
    act(() => result.current[1]("b"));
    rerender({ list: [{ id: "c" }, { id: "a" }, { id: "b" }], org: "org-1" });
    expect(result.current[0]).toBe("b");
  });

  it("đổi nick trong cùng công ty chọn ngay một hội thoại của nick mới", () => {
    const { result, rerender } = renderHook(({ list, org }: Props) => useActiveConversation(list, org), {
      initialProps: { list: [{ id: "conversation-a" }], org: "org-1" },
    });
    rerender({ list: [{ id: "conversation-b" }], org: "org-1" });
    expect(result.current[0]).toBe("conversation-b");
  });

  it("đổi công ty: bỏ hội thoại của công ty cũ, chốt hội thoại đầu của công ty mới", () => {
    const { result, rerender } = renderHook(({ list, org }: Props) => useActiveConversation(list, org), {
      initialProps: { list: [{ id: "a" }, { id: "b" }], org: "org-1" },
    });
    act(() => result.current[1]("b"));
    rerender({ list: [], org: "org-2" });
    expect(result.current[0]).toBe("");
    rerender({ list: [{ id: "z" }], org: "org-2" });
    expect(result.current[0]).toBe("z");
  });
});

it("không mang trích dẫn sang nick khác và lượt gửi cũ không xoá trích dẫn mới", () => {
  const { result, rerender } = renderHook(({ id }) => useConversationReply(id), { initialProps: { id: "group-a" } });
  const quote = { id: "msg-a", text: "tin nhắn riêng" } as ZaloMessage;
  act(() => result.current.select(quote));
  const finishOldSend = result.current.clearSent;
  rerender({ id: "group-b" });
  expect(result.current.message).toBeNull();
  const next = { id: "msg-b" } as ZaloMessage;
  act(() => result.current.select(next));
  act(finishOldSend);
  expect(result.current.message).toBe(next);
});
