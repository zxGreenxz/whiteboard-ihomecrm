import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  getSessionUser: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useMutation: vi.fn(),
  useQuery: vi.fn(),
  useQueryClient: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: mocks.from,
    rpc: mocks.rpc,
  },
}));

vi.mock("@/lib/authSession", () => ({
  getSessionUser: mocks.getSessionUser,
}));

import { invoiceStatisticsQuery, invoicesListQuery } from "../useInvoices";

const DEFAULT_ARGS = {
  p_billing_month: undefined,
  p_view_status: "active",
  p_status: undefined,
  p_payment_status: undefined,
  p_filter_building_ids: undefined,
  p_room_ids: undefined,
  p_contract_id: undefined,
  p_issue_date_from: undefined,
  p_issue_date_to: undefined,
  p_amount_target: undefined,
  p_search: undefined,
  p_adjustment_review_status: undefined,
  p_payment_method: undefined,
  p_limit: 20,
  p_offset: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionUser.mockResolvedValue({ id: "user-1" });
});

// Màn Hoá đơn đọc qua hàm SQL dùng chung invoice_list_v1 / invoice_statistics_v3
// (migration 20261017115809). Công thức lọc nằm ở SQL (test PGlite
// src/lib/__tests__/invoiceReadSharedMigration.test.ts); ở đây đo hook gửi đúng
// tham số, giữ queryKey, không đọc bảng thẳng và không biến phản hồi hỏng thành 0.
describe("invoicesListQuery → invoice_list_v1", () => {
  it("một lời gọi RPC duy nhất, mặc định ẩn huỷ, phân trang truyền vào hàm, giữ dòng và tổng", async () => {
    const rows = [{ id: "invoice-1", active_payment_methods: ["TK", "TM"], payments: [{ id: "active", reversed_at: null }] }];
    mocks.rpc.mockResolvedValue({ data: { total_count: 41, rows }, error: null });
    const query = invoicesListQuery({}, { page: 3, pageSize: 20 });
    expect(query.queryKey).toEqual(["invoices", {}, { page: 3, pageSize: 20 }]);
    const result = await query.queryFn();
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith("invoice_list_v1", { ...DEFAULT_ARGS, p_offset: 40 });
    expect(mocks.from).not.toHaveBeenCalled();
    expect(result).toEqual({ count: 41, data: rows });
    // Tham số vắng là undefined (bị bỏ khỏi body ⇒ DEFAULT của hàm), không gửi null.
    const sent = mocks.rpc.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(Object.entries(sent).filter(([, v]) => v !== undefined).map(([k]) => k).sort())
      .toEqual(["p_limit", "p_offset", "p_view_status"]);
  });

  it("đổi đủ bộ lọc màn hình sang tham số hàm (building_ids thắng building_id, room_ids thắng room_id)", async () => {
    mocks.rpc.mockResolvedValue({ data: { total_count: 0, rows: [] }, error: null });
    await invoicesListQuery({
      building_id: "b-legacy", building_ids: ["b1", "b2"], room_id: "r-legacy", room_ids: ["r1"],
      contract_id: "c1", status: "OVERDUE", payment_status: "unpaid", view_status: "all",
      billing_month: "2026-10", date_range: { start: "2026-10-01", end: "2026-10-31" },
      amount_target: 0, search: "  Văn An ", adjustment_review_status: "pending", payment_method: "TM",
    }, { page: 1, pageSize: 15 }).queryFn();
    expect(mocks.rpc).toHaveBeenCalledWith("invoice_list_v1", {
      p_billing_month: "2026-10", p_view_status: "all", p_status: "OVERDUE", p_payment_status: "unpaid",
      p_filter_building_ids: ["b1", "b2"], p_room_ids: ["r1"], p_contract_id: "c1",
      p_issue_date_from: "2026-10-01", p_issue_date_to: "2026-10-31", p_amount_target: 0, p_search: "  Văn An ",
      p_adjustment_review_status: "pending", p_payment_method: "TM", p_limit: 15, p_offset: 0,
    });
  });

  it("building_id/room_id lẻ (màn mobile) thành mảng một phần tử; thiếu phân trang ⇒ trần 1000 như PostgREST", async () => {
    mocks.rpc.mockResolvedValue({ data: { total_count: 0, rows: [] }, error: null });
    await invoicesListQuery({ building_id: "b1", room_id: "r1" }).queryFn();
    expect(mocks.rpc).toHaveBeenCalledWith("invoice_list_v1", {
      ...DEFAULT_ARGS, p_filter_building_ids: ["b1"], p_room_ids: ["r1"], p_limit: 1000, p_offset: 0,
    });
  });

  it("lỗi RPC ném ra; phản hồi thiếu tổng hoặc thiếu dòng không thành danh sách rỗng", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: "42501", message: "denied" } });
    await expect(invoicesListQuery({}, { page: 1, pageSize: 20 }).queryFn()).rejects.toMatchObject({ code: "42501" });
    for (const data of [null, [], { rows: [] }, { total_count: 3 }, { total_count: "x", rows: [] }]) {
      mocks.rpc.mockResolvedValueOnce({ data, error: null });
      await expect(invoicesListQuery({}, { page: 1, pageSize: 20 }).queryFn()).rejects.toThrow("Chưa đọc");
    }
    consoleError.mockRestore();
  });
});

describe("invoiceStatisticsQuery → invoice_statistics_v3", () => {
  const row = {
    total_amount: 10, total_paid: 4, total_remaining: 6, total_refunded: 0, total_count: 2, rent_amount: 8,
    electric_amount: 1, water_amount: 1, pdv_amount: 0, total_collected: 4, payment_tm: 4, payment_tk: 0,
    payment_tt: 0, payment_ct: 0, change_amount: 0, deposit_collected: 0,
  };

  it("giữ queryKey; building_id ∩ building_ids như v2; một phòng ⇒ mảng; đọc dòng đầu của TABLE", async () => {
    mocks.rpc.mockResolvedValue({ data: [row], error: null });
    const filters = { building_id: "b2", building_ids: ["b1", "b2"], room_id: "r1", status: "CANCELLED" as const,
      start_date: "2026-10-01", end_date: "2026-10-31", billing_month: "2026-10", payment_status: "paid" as const };
    const query = invoiceStatisticsQuery(filters);
    expect(query.queryKey).toEqual(["invoice-statistics", filters]);
    await expect(query.queryFn()).resolves.toEqual(row);
    expect(mocks.rpc).toHaveBeenCalledWith("invoice_statistics_v3", {
      p_billing_month: "2026-10", p_status: "CANCELLED", p_payment_status: "paid", p_filter_building_ids: ["b2"],
      p_room_ids: ["r1"], p_issue_date_from: "2026-10-01", p_issue_date_to: "2026-10-31",
    });
  });

  it("không bộ lọc ⇒ không gửi tham số (DEFAULT NULL); building_id ngoài building_ids ⇒ mảng rỗng (không có toà nào, như AND của v2)", async () => {
    mocks.rpc.mockResolvedValue({ data: [row], error: null });
    await invoiceStatisticsQuery().queryFn();
    expect(mocks.rpc).toHaveBeenLastCalledWith("invoice_statistics_v3", {
      p_billing_month: undefined, p_status: undefined, p_payment_status: undefined, p_filter_building_ids: undefined,
      p_room_ids: undefined, p_issue_date_from: undefined, p_issue_date_to: undefined,
    });
    await invoiceStatisticsQuery({ building_id: "b9", building_ids: ["b1"] }).queryFn();
    expect(mocks.rpc).toHaveBeenLastCalledWith("invoice_statistics_v3", expect.objectContaining({ p_filter_building_ids: [] }));
  });

  it("TABLE rỗng hoặc số hỏng ⇒ ném, không hiện 0đ giả", async () => {
    for (const data of [[], [{ ...row, total_paid: null }]]) {
      mocks.rpc.mockResolvedValueOnce({ data, error: null });
      await expect(invoiceStatisticsQuery().queryFn()).rejects.toThrow("Chưa đọc");
    }
  });
});
