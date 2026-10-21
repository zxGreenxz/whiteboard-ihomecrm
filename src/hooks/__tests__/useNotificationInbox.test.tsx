// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

interface Row { id: string; created_at: string; status: string; type: string }

const io = vi.hoisted(() => ({
  parity: [] as Row[],
  pageReply: [] as Row[],
  calls: [] as Array<{ eq: Array<[string, unknown]>; neq: Array<[string, unknown]>; or: string[] }>,
}));

vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ data: { id: "u1" } }) }));
vi.mock("@/contexts/OrganizationContext", () => ({ useOrganization: () => ({ selectedOrganizationId: "org-a" }) }));
vi.mock("@/hooks/useNotifications", () => ({
  inboxScope: (org: string | null) => (org ? `organization_id.eq.${org}` : "x"),
  useNotifications: () => ({ data: io.parity, isLoading: false }),
  useUnreadNotificationsCount: () => ({ data: 1979, isLoading: false }),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => {
      const call = { eq: [] as Array<[string, unknown]>, neq: [] as Array<[string, unknown]>, or: [] as string[] };
      io.calls.push(call);
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => { call.eq.push([c, v]); return q; },
        neq: (c: string, v: unknown) => { call.neq.push([c, v]); return q; },
        or: (f: string) => { call.or.push(f); return q; },
        order: () => q,
        limit: () => Promise.resolve({ data: io.pageReply, error: null }),
      };
      return q;
    },
  },
}));

import { useNotificationInbox, type InboxTab } from "@/hooks/useNotificationPages";

const iso = (i: number) => new Date(Date.UTC(2026, 9, 21, 8, 0, 0) - i * 60_000).toISOString();
const row = (i: number, status = "READ"): Row => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, created_at: iso(i), status, type: "CUSTOM" });

function setup(tab: InboxTab) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(() => useNotificationInbox(tab), { wrapper });
}

describe("useNotificationInbox — 200 dòng parity + Xem thêm keyset, tab Chưa đọc lọc server", () => {
  beforeEach(() => {
    io.parity = [];
    io.pageReply = [];
    io.calls = [];
  });
  afterEach(cleanup);

  it("dưới 200 dòng: không có Xem thêm, không gọi thêm truy vấn nào", () => {
    io.parity = [row(0), row(1)];
    const { result } = setup("all");
    expect(result.current.rows).toHaveLength(2);
    expect(result.current.coThem).toBe(false);
    expect(result.current.unreadCount).toBe(1979);
    expect(io.calls).toHaveLength(0);
  });

  it("đủ 200 dòng: Xem thêm tải tiếp từ dòng cuối (gồm cả nhóm cùng mốc), khử trùng khi ghép", async () => {
    io.parity = Array.from({ length: 200 }, (_, i) => row(i));
    // Trang đầu (created_at <= mốc) trả lại chính dòng cuối 199 + 49 dòng cũ hơn: ghép xong 249.
    io.pageReply = Array.from({ length: 50 }, (_, i) => row(199 + i));
    const { result } = setup("all");
    expect(result.current.coThem).toBe(true);
    act(() => result.current.taiThem());
    await waitFor(() => expect(result.current.rows).toHaveLength(249));
    const call = io.calls.at(-1)!;
    expect(call.neq).toContainEqual(["status", "CANCELLED"]);
    expect(call.or[0]).toBe(`and(or(organization_id.eq.org-a),or(created_at.lte."${iso(199)}"))`);
    // Trang đủ 50 ⇒ còn có thể xem thêm.
    expect(result.current.coThem).toBe(true);
    expect(new Set(result.current.rows.map((r) => r.id)).size).toBe(249);
  });

  it("tab Chưa đọc: lọc PENDING ở server từ dòng mới nhất, không dùng danh sách parity", async () => {
    io.parity = Array.from({ length: 200 }, (_, i) => row(i, "READ"));
    io.pageReply = [row(5, "PENDING"), row(9, "PENDING")];
    const { result } = setup("unread");
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    const call = io.calls.at(-1)!;
    expect(call.eq).toContainEqual(["status", "PENDING"]);
    expect(call.or[0]).toBe("organization_id.eq.org-a");
    expect(result.current.coThem).toBe(false);
  });
});
