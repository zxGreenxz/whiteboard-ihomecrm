// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ reply: vi.fn(), calls: [] as unknown[][], org: "org-a" as string | null }));
vi.mock("@/contexts/OrganizationContext", () => ({ useOrganization: () => ({ selectedOrganizationId: m.org }) }));
// .env của worktree trỏ production ⇒ client luôn giả, không bao giờ gọi mạng thật.
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      const b = {
        select: (cols: string) => (m.calls.push([table, "select", cols]), b),
        eq: (k: string, v: unknown) => (m.calls.push([table, "eq", k, v]), b),
        order: (k: string) => (m.calls.push([table, "order", k]), b),
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve().then(() => m.reply()).then(res, rej),
      };
      return b;
    },
  },
}));
import { groupCommonNames, useBuildingCommonNames } from "../useBuildingCommonNames";

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);
beforeEach(() => {
  vi.clearAllMocks();
  m.calls = [];
  m.org = "org-a";
});
afterEach(cleanup);

it("gom tên theo toà, giữ thứ tự thêm", () => {
  const g = groupCommonNames([
    { building_id: "b1", name: "Lê Văn Thọ" },
    { building_id: "b2", name: "Quang Trung" },
    { building_id: "b1", name: "một lẻ hai Lê Văn Thọ" },
  ]);
  expect(g.get("b1")).toEqual(["Lê Văn Thọ", "một lẻ hai Lê Văn Thọ"]);
  expect(g.get("b2")).toEqual(["Quang Trung"]);
  expect(groupCommonNames([]).size).toBe(0);
});

it.each([null, {}, [{ building_id: "b1" }], [{ building_id: 1, name: "x" }]])("dữ liệu hỏng %j ⇒ lỗi, không coi như rỗng", (rows) => {
  expect(() => groupCommonNames(rows)).toThrow();
});

it("đọc đúng bảng, lọc công ty đang chọn, sắp theo lúc thêm", async () => {
  m.reply.mockResolvedValue({ data: [{ building_id: "b1", name: "Lê Văn Thọ" }], error: null });
  const h = renderHook(() => useBuildingCommonNames({ enabled: true }), { wrapper });
  await waitFor(() => expect(h.result.current.isSuccess).toBe(true));
  expect(h.result.current.data?.get("b1")).toEqual(["Lê Văn Thọ"]);
  expect(m.calls).toContainEqual(["building_common_names", "select", "building_id, name"]);
  expect(m.calls).toContainEqual(["building_common_names", "eq", "organization_id", "org-a"]);
  expect(m.calls).toContainEqual(["building_common_names", "order", "created_at"]);
});

it("lỗi máy chủ / dữ liệu null ⇒ isError (người gọi tự bỏ qua, trang không chặn)", async () => {
  m.reply.mockResolvedValue({ data: null, error: { message: "boom" } });
  const a = renderHook(() => useBuildingCommonNames({ enabled: true }), { wrapper });
  await waitFor(() => expect(a.result.current.isError).toBe(true));
  m.reply.mockResolvedValue({ data: null, error: null });
  const b = renderHook(() => useBuildingCommonNames({ enabled: true }), { wrapper });
  await waitFor(() => expect(b.result.current.isError).toBe(true));
});

it("tắt (không có quyền chi công ty) hoặc chưa chọn công ty ⇒ không truy vấn", async () => {
  renderHook(() => useBuildingCommonNames({ enabled: false }), { wrapper });
  m.org = null;
  renderHook(() => useBuildingCommonNames({ enabled: true }), { wrapper });
  await new Promise((r) => setTimeout(r, 20));
  expect(m.calls).toEqual([]);
});
