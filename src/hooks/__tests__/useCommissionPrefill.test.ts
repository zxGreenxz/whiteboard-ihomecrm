// @vitest-environment jsdom
//
// Prefill phiếu hoa hồng — ba điều bài này giữ, tất cả đều là NGUYÊN NHÂN của
// bug 15/09/2026 "tạo HĐ xong mở phiếu hoa hồng, đang điền thì form tự xoá rồi
// kẹt 'Đang tải thông tin hợp đồng...'":
//
//   1. queryFn PHẢI ném khi PostgREST trả {error}. Bản cũ `return null` với
//      trạng thái success ⇒ modal đọc ra "chưa có data" và hiện dòng "Đang tải"
//      VĨNH VIỄN: không retry (thành công rồi), không nút thử lại, nút Tạo phiếu
//      disable. Một lỗi mạng thoáng qua giữa cơn bão invalidate là đủ để kẹt.
//   2. Prefill chỉ được đọc contracts — KHÔNG kèm một round-trip accounts tuần
//      tự phía sau. Sổ quỹ mặc định suy từ useAccounts đã có sẵn trong modal.
//   3. Descriptor realtime của income_expenses KHÔNG được mang
//      ["commission-prefill"]: prefill không đọc bảng đó, mà tạo HĐ thì ghi vào
//      nó ⇒ hub invalidate prefill 0,8–2,4 s sau khi modal vừa mở.
//
// `supabase.rpc`/PostgREST không bao giờ ném — lỗi về dưới dạng {error} trên một
// promise ĐÃ fulfil. Nên bài này mock {error}, không mockRejectedValue.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";

const db = vi.hoisted(() => ({
  tables: [] as string[],
  contract: null as unknown,
  contractError: null as unknown,
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

vi.mock("@/integrations/supabase/client", () => {
  const chain = () => {
    const self: Record<string, unknown> = {};
    for (const m of ["select", "eq", "ilike", "is", "in", "order", "neq"]) {
      self[m] = () => self;
    }
    self.single = async () => ({ data: db.contract, error: db.contractError });
    self.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(resolve);
    return self;
  };
  return { supabase: { from: (t: string) => { db.tables.push(t); return chain(); } } };
});

import { useCommissionPrefill } from "@/hooks/useCommissionVoucher";
import { FINANCE_SYNC_ENTRIES } from "@/hooks/realtime/finance";

const CONTRACT = {
  id: "c1",
  contract_number: "HD-001",
  signed_date: "2026-09-15",
  start_date: "2026-09-15",
  end_date: "2027-09-14",
  rent_price: 5_000_000,
  room: { id: "r1", name: "P101", building_id: "b1", building: { id: "b1", name: "Toà A", commission_tiers: [] } },
  contract_customers: [{ customer_id: "k1", is_representative: true, customer: { id: "k1", full_name: "Khách A" } }],
};

function harness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  return { client, wrapper };
}

beforeEach(() => { db.tables = []; db.contract = CONTRACT; db.contractError = null; });
afterEach(() => vi.clearAllMocks());

it("ném lỗi khi PostgREST trả {error} thay vì trả null trong trạng thái success", async () => {
  db.contract = null;
  db.contractError = { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" };
  const { client, wrapper } = harness();

  const { result, unmount } = renderHook(() => useCommissionPrefill("c1"), { wrapper });

  await waitFor(() => expect(result.current.isError).toBe(true));
  // Chốt đúng cái đã hỏng: KHÔNG được là "thành công với data rỗng".
  expect(result.current.isSuccess).toBe(false);
  expect(result.current.data).toBeUndefined();
  unmount();
  client.clear();
});

it("đọc đúng MỘT bảng: không còn round-trip accounts tuần tự sau contracts", async () => {
  const { client, wrapper } = harness();

  const { result, unmount } = renderHook(() => useCommissionPrefill("c1"), { wrapper });

  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(db.tables).toEqual(["contracts"]);
  unmount();
  client.clear();
});

it("giữ prefill không tự cũ: staleTime vô hạn, gcTime 5 phút", async () => {
  const { client, wrapper } = harness();

  const { result, unmount } = renderHook(() => useCommissionPrefill("c1"), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));

  const query = client.getQueryCache().find({ queryKey: ["commission-prefill", "c1"] });
  // `staleTime` là tuỳ chọn của OBSERVER, không nằm trong QueryOptions của cache
  // — đọc nhầm chỗ thì trả undefined và bài test xanh giả.
  expect(query?.observers[0]?.options.staleTime).toBe(Infinity);
  expect(query?.options.gcTime).toBe(5 * 60_000);
  unmount();
  client.clear();
});

it("descriptor income_expenses không còn invalidate ['commission-prefill']", () => {
  const ie = FINANCE_SYNC_ENTRIES.find((e) => e.table === "income_expenses");
  expect(ie, "descriptor income_expenses phải tồn tại").toBeTruthy();
  const keys = FINANCE_SYNC_ENTRIES.flatMap((e) => e.keys.map((k) => k[0]));
  expect(keys).not.toContain("commission-prefill");
  // Sàn chống rỗng: nếu bộ đọc descriptor hỏng thì câu trên đúng mà vô nghĩa.
  expect(keys.length).toBeGreaterThan(50);
});
