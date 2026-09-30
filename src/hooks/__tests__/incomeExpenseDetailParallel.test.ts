// @vitest-environment jsdom
// Mở chi tiết phiếu trên điện thoại chờ BA request nối đuôi nhau: đầu phiếu →
// RPC chi tiết → phần bổ sung. Đo trên production 30/09/2026: 570–1.870 ms từ
// mạng cáp, điện thoại còn lâu hơn. RPC chỉ cần mã tổ chức, phần bổ sung chỉ cần
// id — biết trước tổ chức (dòng danh sách vừa bấm) thì cả ba chạy cùng lúc.
// Quyền không đổi: vẫn đủ ba lần đọc qua RLS, đầu phiếu vẫn quyết định "còn thấy".
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

const mock = vi.hoisted(() => ({
  headerPromise: null as Promise<{ data: unknown; error: unknown }> | null,
  rpc: vi.fn(),
  supplements: vi.fn(),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: mock.rpc,
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        is: () => q,
        maybeSingle: () => mock.headerPromise,
      };
      return q;
    },
  },
}));
vi.mock("@/hooks/income-expenses/supplements", () => ({
  hydrateIncomeExpenseSupplements: mock.supplements,
}));
vi.mock("@/hooks/income-expenses/reservationCreators", () => ({
  hydrateReservationCreators: async (rows: unknown[]) => rows,
}));
import {
  loadIncomeExpenseDetail,
  useIncomeExpenseDetail,
  DetailReadTimeoutError,
  DETAIL_READ_TIMEOUT_MS,
} from "../income-expenses/detailRead";

const id = "00000000-0000-4000-8000-000000000001";
const org = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherOrg = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const rpcRow = {
  header: {
    posting_mode: null, posting_status: null, review_state: null, tenant_id: null,
    approved_by: null, approved_at: null, notes: null, payer_name: null, account_id: null,
    system_source: null, shareholder_id: null, contract_id: null, invoice_id: null,
    commission_kind: null, attachments: [], business_result_accounting: null,
    counts_in_business_result: true, receive_bank_name: null, receive_bank_account: null,
    creator_name: null, repeat_cycle: null, repeat_infinity: false, repeat_count: 0,
    repeat_remaining: 0, repeat_next_date: null, repeat_parent_id: null, verified_at: null,
    verified_by: null, verified_by_name: null, verified_note: null,
    reversal_of_income_expense_id: null, id, organization_id: org, user_id: id,
    building_id: id, code: "PC2609006", type: "EXPENSE", name: "Hoa hồng 303/44TL",
    voucher_date: "2026-09-04", total_amount: "2160000", kqkd_amount: "2160000",
    approval_status: "APPROVED", approval_version: 2, posting_version: 1,
    created_at: "2026-09-04T00:00:00Z", updated_at: "2026-09-30T05:07:51Z", room_id: null,
  },
  items: [],
  building_name: "44TL",
  expected_item_count: 0,
  items_complete: true,
  issues: [],
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

function setup() {
  const header = deferred<{ data: unknown; error: unknown }>();
  mock.headerPromise = header.promise;
  mock.rpc.mockReset();
  mock.rpc.mockImplementation(async (_name: string, args: { p_organization_id: string }) =>
    args.p_organization_id === org
      ? { data: { rows: [rpcRow] }, error: null }
      : { data: null, error: { message: "organization mismatch", code: "42501" } });
  mock.supplements.mockReset();
  mock.supplements.mockImplementation(async (rows: { id: string }[]) =>
    rows.map((r) => ({ ...r, supplements: [{ id: "sup-1" }] })));
  return header;
}
const visibleHeader = { data: { organization_id: org, room: null, tenant: null, account: null }, error: null };

afterEach(cleanup);

describe("tải chi tiết phiếu song song", () => {
  it("biết tổ chức của dòng vừa bấm: RPC chi tiết và phần bổ sung chạy ngay, không đợi đầu phiếu", async () => {
    const header = setup();
    const pending = loadIncomeExpenseDetail(id, org);
    await flush();
    expect(mock.rpc).toHaveBeenCalledTimes(1);
    expect(mock.supplements).toHaveBeenCalledTimes(1);
    header.resolve(visibleHeader);
    const v = await pending;
    expect(v?.code).toBe("PC2609006");
    expect(v?.building_name).toBe("44TL");
    expect(v?.supplements).toEqual([{ id: "sup-1" }]);
  });

  it("tổ chức gợi ý sai: đọc lại theo tổ chức thật của phiếu, không dùng kết quả đọc sai", async () => {
    const header = setup();
    // Lần đọc theo tổ chức gợi ý trả dữ liệu HỢP LỆ của tổ chức đó — bản sửa sai kiểu
    // "RPC song song có dữ liệu là dùng" sẽ lộ tên này ra thay vì tên phiếu thật.
    mock.rpc.mockImplementation(async (_name: string, args: { p_organization_id: string }) => ({
      data: {
        rows: [
          args.p_organization_id === org
            ? rpcRow
            : { ...rpcRow, header: { ...rpcRow.header, organization_id: otherOrg, name: "Dữ liệu tổ chức khác" } },
        ],
      },
      error: null,
    }));
    const pending = loadIncomeExpenseDetail(id, otherOrg);
    header.resolve(visibleHeader);
    const v = await pending;
    expect(mock.rpc).toHaveBeenCalledTimes(2);
    expect(mock.rpc.mock.calls[1][1]).toMatchObject({ p_organization_id: org });
    expect(v?.name).toBe("Hoa hồng 303/44TL");
    expect(v?.organization_id).toBe(org);
  });

  it("đầu phiếu lỗi: báo đúng lỗi đầu phiếu, không bị lỗi RPC song song che mất", async () => {
    const header = setup();
    mock.rpc.mockImplementation(async () => ({ data: null, error: { message: "rpc lỗi song song", code: "XX000" } }));
    const pending = loadIncomeExpenseDetail(id, org);
    header.resolve({ data: null, error: { message: "đầu phiếu lỗi", code: "57014" } });
    await expect(pending).rejects.toMatchObject({ message: "đầu phiếu lỗi" });
  });

  it("đầu phiếu thấy được mà RPC song song lỗi: báo lỗi, KHÔNG trả null như hết quyền", async () => {
    const header = setup();
    mock.rpc.mockImplementation(async () => ({ data: null, error: { message: "rpc hỏng", code: "XX000" } }));
    const pending = loadIncomeExpenseDetail(id, org);
    header.resolve(visibleHeader);
    await expect(pending).rejects.toBeTruthy();
  });

  it("đầu phiếu không còn thấy: trả null (hết quyền) dù RPC chạy song song đã lỗi", async () => {
    const header = setup();
    mock.rpc.mockImplementation(async () => ({ data: null, error: { message: "denied", code: "42501" } }));
    const pending = loadIncomeExpenseDetail(id, org);
    header.resolve({ data: null, error: null });
    await expect(pending).resolves.toBeNull();
  });

  it("không có gợi ý tổ chức: phần bổ sung vẫn chạy song song, RPC đợi đầu phiếu", async () => {
    const header = setup();
    const pending = loadIncomeExpenseDetail(id);
    await flush();
    expect(mock.supplements).toHaveBeenCalledTimes(1);
    expect(mock.rpc).not.toHaveBeenCalled();
    header.resolve(visibleHeader);
    expect((await pending)?.code).toBe("PC2609006");
  });

  it("đọc bị kẹt: quá hạn thì hook báo lỗi (để có nút Thử lại), không quay mãi", async () => {
    // Màn chờ không mời "Thử lại"; đóng mở lại cũng dính vào đúng lần đọc đang treo
    // (queryFn không huỷ được) — nên lần đọc PHẢI tự kết thúc bằng lỗi.
    setup(); // đầu phiếu không bao giờ trả lời
    vi.useFakeTimers();
    try {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client }, children);
      const { result } = renderHook(() => useIncomeExpenseDetail(id, true, org), { wrapper });
      await vi.advanceTimersByTimeAsync(DETAIL_READ_TIMEOUT_MS + 50);
      expect(result.current.isError).toBe(true);
      expect(result.current.error).toBeInstanceOf(DetailReadTimeoutError);
      expect(result.current.isFetching).toBe(false);
      // Mọi màn dùng query này tự hiện lỗi + Thử lại tại chỗ; toast chung của
      // QueryProvider (in cả queryKey) đè lên nút Thử lại trên điện thoại — im nó.
      expect(client.getQueryCache().find({ queryKey: ["income-expense", "detail", id] })?.meta).toMatchObject({ silent: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("hook nhận gợi ý tổ chức và chuyển xuống bộ tải", async () => {
    const header = setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    const { result } = renderHook(() => useIncomeExpenseDetail(id, true, org), { wrapper });
    await waitFor(() => expect(mock.rpc).toHaveBeenCalledTimes(1));
    header.resolve(visibleHeader);
    await waitFor(() => expect(result.current.data?.code).toBe("PC2609006"));
  });
});
