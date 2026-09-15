// @vitest-environment jsdom
//
// D2 — quyền của giao diện phải hỏi ĐÚNG MỘT công ty.
//
// LỖ ĐANG VÁ
//   `get_my_permissions()` không nhận tham số công ty và cache key là
//   `['my-permissions']` trống trơn. Chủ có membership ở cả công ty THẬT lẫn
//   DEMO nhận HỢP của hai tập quyền; đổi công ty trên thanh chọn cũng KHÔNG
//   làm quyền nạp lại, vì cache key không đổi.
//
// KIỂM Ở ĐÂY
//   1. cache key kèm công ty đang chọn ⇒ đổi công ty là đổi khoá.
//   2. gọi `get_my_permissions_v2` với `p_org` đúng công ty đang chọn.
//   3. chưa chốt công ty ⇒ KHÔNG gọi RPC, và KHÔNG được báo "đã tải xong,
//      không có quyền" (đó là đá người dùng ra khỏi trang).
//   4. bản v2 chưa có trên máy chủ (PGRST202) ⇒ rơi về v1 chứ không khoá sạch
//      giao diện — frontend và migration không gộp cùng lúc.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const rpc = vi.hoisted(() => vi.fn());
const orgState = vi.hoisted(() => ({
  selectedOrganizationId: null as string | null,
  isLoading: false,
}));

vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc } }));
vi.mock("@/contexts/OrganizationContext", () => ({
  useOrganization: () => orgState,
}));

import { useMyPermissions } from "../useMyPermissions";

const ORG_THAT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_DEMO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const duoi = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
};

beforeEach(() => {
  rpc.mockReset();
  orgState.selectedOrganizationId = null;
  orgState.isLoading = false;
});

describe("useMyPermissions — phạm vi công ty", () => {
  it("gọi get_my_permissions_v2 với p_org = công ty đang chọn", async () => {
    orgState.selectedOrganizationId = ORG_THAT;
    rpc.mockResolvedValue({
      data: { invoices: { view: { org_wide: true, building_ids: [], cashbook_ids: [] } } },
      error: null,
    });

    const { client, wrapper } = duoi();
    const { result, unmount } = renderHook(() => useMyPermissions(), { wrapper });

    await waitFor(() => expect(result.current.data).toBeTruthy());
    expect(rpc).toHaveBeenCalledWith("get_my_permissions_v2", { p_org: ORG_THAT });
    unmount();
    client.clear();
  });

  it("cache key kèm công ty: đổi công ty là hỏi lại, không dùng lại tập quyền cũ", async () => {
    orgState.selectedOrganizationId = ORG_THAT;
    rpc.mockResolvedValue({ data: { invoices: { view: true } }, error: null });

    const { client, wrapper } = duoi();
    const { result, rerender, unmount } = renderHook(() => useMyPermissions(), { wrapper });
    await waitFor(() => expect(result.current.data).toBeTruthy());

    orgState.selectedOrganizationId = ORG_DEMO;
    rerender();
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));

    expect(client.getQueryData(["my-permissions", ORG_THAT])).toBeTruthy();
    expect(rpc).toHaveBeenLastCalledWith("get_my_permissions_v2", { p_org: ORG_DEMO });
    unmount();
    client.clear();
  });

  it("chưa chốt công ty: KHÔNG gọi RPC và vẫn ở trạng thái đang tải", async () => {
    // Trả `{}` ở đây là nói dối: "đã biết rồi, bạn không có quyền gì" — route
    // guard sẽ đá người dùng về `/` trong lúc danh bạ công ty còn đang nạp.
    orgState.selectedOrganizationId = null;
    orgState.isLoading = true;

    const { client, wrapper } = duoi();
    const { result, unmount } = renderHook(() => useMyPermissions(), { wrapper });

    expect(rpc).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
    expect(result.current.isLoading).toBe(true);
    unmount();
    client.clear();
  });

  it("máy chủ chưa có bản v2 (PGRST202): rơi về v1 thay vì khoá sạch giao diện", async () => {
    orgState.selectedOrganizationId = ORG_THAT;
    rpc.mockImplementation((ten: string) =>
      Promise.resolve(
        ten === "get_my_permissions_v2"
          ? { data: null, error: { code: "PGRST202", message: "function not found" } }
          : { data: { invoices: { view: true } }, error: null },
      ),
    );

    const { client, wrapper } = duoi();
    const { result, unmount } = renderHook(() => useMyPermissions(), { wrapper });

    await waitFor(() => expect(result.current.data).toEqual({ invoices: { view: true } }));
    expect(rpc).toHaveBeenCalledWith("get_my_permissions");
    unmount();
    client.clear();
  });
});

describe("useMyPermissions — chú thích đã lỗi thời", () => {
  it("không còn câu 'record_payment ... không có hậu kiểm DB'", async () => {
    // `record_invoice_payment_v4` ĐÃ hậu kiểm. Giữ câu này lại là dạy người đọc
    // sau tin rằng đường tiền chỉ được gác ở giao diện.
    // Đường dẫn tương đối gốc repo: file test này chạy môi trường jsdom nên
    // `import.meta.url` là URL http, `new URL(..., import.meta.url)` sẽ ném.
    const { readFileSync } = await import("node:fs");
    const nguon = readFileSync("src/hooks/useMyPermissions.ts", "utf8");
    expect(nguon).not.toMatch(/không có hậu kiểm DB/);
    expect(nguon).not.toMatch(/record_payment` là action mới/);
  });
});
