// @vitest-environment jsdom
// Chốt hội thoại mặc định + bỏ chọn khi đổi công ty (A8 — RT-OTHER-M2, RT-OTHER-7).
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useActiveConversation } from "@/hooks/chat-zalo/useActiveConversation";

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
