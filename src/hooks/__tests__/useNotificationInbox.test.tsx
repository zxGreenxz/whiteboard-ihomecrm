// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

interface Row { id: string; created_at: string; status: string; type: string }

interface Call { eq: Array<[string, unknown]>; neq: Array<[string, unknown]>; or: string[]; gte: Array<[string, string]>; lte: Array<[string, string]> }

const io = vi.hoisted(() => ({
  parity: [] as Row[],
  pageReply: [] as Row[],
  /** "Bảng" cho truy vấn dải hở (gte/lte): lọc theo created_at, mới trước. */
  db: [] as Row[],
  calls: [] as Call[],
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
      const call: Call = { eq: [], neq: [], or: [], gte: [], lte: [] };
      io.calls.push(call);
      const reply = () => {
        if (!call.gte.length) return io.pageReply;
        const from = Date.parse(call.gte[0]![1]);
        const to = Date.parse(call.lte[0]![1]);
        return io.db.filter((r) => Date.parse(r.created_at) >= from && Date.parse(r.created_at) <= to);
      };
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => { call.eq.push([c, v]); return q; },
        neq: (c: string, v: unknown) => { call.neq.push([c, v]); return q; },
        or: (f: string) => { call.or.push(f); return q; },
        gte: (c: string, v: string) => { call.gte.push([c, v]); return q; },
        lte: (c: string, v: string) => { call.lte.push([c, v]); return q; },
        order: () => q,
        limit: () => Promise.resolve({ data: reply(), error: null }),
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

const truyVanTrang = () => io.calls.filter((c) => !c.gte.length && c.or.some((f) => f.includes("created_at")));
const truyVanDaiHo = () => io.calls.filter((c) => c.gte.length > 0);

describe("useNotificationInbox — 200 dòng parity + Xem thêm keyset, tab Chưa đọc lọc server", () => {
  beforeEach(() => {
    io.parity = [];
    io.pageReply = [];
    io.db = [];
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

  it("thông báo mới tới sau khi đã Xem thêm: GIỮ các trang đã tải, tải bù dải hở [mốc neo, đuôi mới] rồi gộp khử trùng", async () => {
    io.parity = Array.from({ length: 200 }, (_, i) => row(i));
    io.pageReply = Array.from({ length: 50 }, (_, i) => row(199 + i));
    io.db = Array.from({ length: 260 }, (_, i) => row(i));
    const { result, rerender } = setup("all");
    act(() => result.current.taiThem());
    await waitFor(() => expect(result.current.rows).toHaveLength(249));
    expect(truyVanTrang()).toHaveLength(1);

    // Hai thông báo mới chèn lên đầu: row(198), row(199) rơi khỏi top 200, đuôi parity giờ là row(197).
    const moi = [{ ...row(0), id: "00000000-0000-4000-8000-00000000aaa1", created_at: iso(-2) }, { ...row(0), id: "00000000-0000-4000-8000-00000000aaa2", created_at: iso(-1) }];
    io.parity = [...moi, ...Array.from({ length: 198 }, (_, i) => row(i))];
    rerender();
    // Dải hở mốc neo row(199) .. đuôi row(197) phủ row(198) — trước đây mốc dời ⇒ khoá đổi ⇒ còn 250 dòng mất trang.
    await waitFor(() => expect(result.current.rows).toHaveLength(251));
    const ids = new Set(result.current.rows.map((r) => r.id));
    expect(ids.size).toBe(251);
    expect(ids.has(row(198).id)).toBe(true);
    expect(ids.has(row(248).id)).toBe(true);
    const hoi = truyVanDaiHo().at(-1)!;
    expect(hoi.gte).toEqual([["created_at", iso(199)]]);
    expect(hoi.lte).toEqual([["created_at", iso(197)]]);
    expect(hoi.neq).toContainEqual(["status", "CANCELLED"]);
    expect(hoi.or[0]).toBe("organization_id.eq.org-a");
    // Trang "Xem thêm" KHÔNG bị tải lại từ đầu (khoá giữ nguyên theo mốc neo).
    expect(truyVanTrang()).toHaveLength(1);
    // Thứ tự: mới trước, không lặp.
    expect(result.current.rows[0]!.id).toBe(moi[0]!.id);
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
