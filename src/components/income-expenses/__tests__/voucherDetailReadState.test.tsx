// @vitest-environment jsdom
// Màn chờ chi tiết phiếu (chủ chụp 30/09/2026 11:46): khung trắng toàn màn hình,
// chữ trơn "Đang tải chi tiết phiếu..." và hai nút không kiểu dính nhau
// "Thử lạiĐóng" — đang tải bình thường mà trông như trang lỗi. Nay: đang tải thì
// giữ đúng khung tấm phiếu (tiêu đề, nút đóng, khung xương) và KHÔNG mời "Thử
// lại"; chỉ khi hỏng mới có nút Thử lại/Đóng rõ ràng. Ràng buộc đợt 28/09 giữ
// nguyên: chưa có bản đọc đầy đủ vừa tải thì không hiện dữ liệu phiếu.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";

const detail = vi.hoisted(() => ({
  data: null as unknown,
  error: null as unknown,
  isFetching: true,
  isFetchedAfterMount: false,
  isSuccess: false,
  isPlaceholderData: false,
  isPaused: false,
  refetch: vi.fn(),
}));
// Không để bài thử bắn request thật: .env của worktree trỏ Supabase production. Mọi chuỗi
// truy vấn trả { data: null, error: null }.
vi.mock("@/integrations/supabase/client", () => {
  const ketQua = Promise.resolve({ data: null, error: null });
  const chuoi: unknown = new Proxy(function () {}, {
    get: (_t, p) => (p === "then" ? ketQua.then.bind(ketQua) : chuoi),
    apply: () => chuoi,
  });
  return { supabase: chuoi };
});
vi.mock("@/hooks/income-expenses/detailRead", () => ({ useIncomeExpenseDetail: () => detail }));
vi.mock("@/hooks/useVoucherDetail", () => ({ useVoucherWithBatch: () => detail }));
vi.mock("@/hooks/useIncomeExpenses", () => ({
  useIncomeExpenseHistory: () => ({ data: [] }),
  useUpdateBatchAccount: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/useIsAdmin", () => ({ useIsAdmin: () => ({ data: false }), useIsSuperAdmin: () => ({ data: false }) }));
const quyen = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));
vi.mock("@/hooks/useMyPermissions", () => ({ useMyPermissions: () => ({ data: quyen.data }) }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ data: { id: "u" } }) }));
vi.mock("@/hooks/useAccounts", () => ({ useAccounts: () => ({ data: [] }) }));
const manHinh = vi.hoisted(() => ({ dienThoai: false }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => manHinh.dienThoai }));
vi.mock("@/hooks/useIsCompanyOwner", () => ({ useIsCompanyOwner: () => ({ data: false }) }));
vi.mock("@/hooks/useReservationSettlement", () => ({
  useReservationSettlementForVoucher: () => ({ data: null, error: null, isSuccess: true, isLoading: false }),
}));
vi.mock("@/lib/financeV2Route", () => ({ useFinanceV2Routes: () => ({ getOrg: () => null }), isCanonicalRead: () => false }));
vi.mock("@/components/income-expenses/PayViaBankAppSheet", () => {
  const Tam = ({ open }: { open: boolean }) => (open ? <div>tam-chi-qua-app</div> : null);
  return { default: Tam, PayViaBankAppSheet: Tam };
});
vi.mock("@/components/ui/storage-image", () => ({ StorageImage: ({ alt }: { alt: string }) => <span>{alt}</span> }));
// Dấu data-open phân biệt "đã gỡ hẳn" (không có dấu) với "chỉ đóng" (data-open=false).
vi.mock("@/components/deposits/ReservationSettlementDialog", () => ({
  ReservationSettlementDialog: ({ open }: { open: boolean }) => <div data-testid="hop-bo-coc" data-open={String(open)} />,
}));
vi.mock("@/components/income-expenses/QlManagerSelect", () => ({ QlManagerSelect: () => null }));
const dongThu = vi.hoisted(() => ({ data: null as unknown }));
vi.mock("@/hooks/useCollectionTenders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useCollectionTenders")>()),
  useTenderForVoucher: () => ({ data: dongThu.data }),
}));
vi.mock("@/components/invoices/ChangeCollectionMethodDialog", () => ({
  default: ({ open }: { open: boolean }) => (open ? <div>hop-doi-hinh-thuc</div> : null),
}));

import IncomeExpenseDetailMobile from "../IncomeExpenseDetailMobile";
import { IncomeExpenseDetailDialog } from "../IncomeExpenseDetailDialog";
import { IncomeExpenseBatchDetailMobile } from "../IncomeExpenseBatchDetailMobile";
import type { IncomeExpenseBatchSummary } from "@/hooks/useIncomeExpenses";

function wrap(node: ReactNode) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>
  );
}
function setState(next: Partial<typeof detail>) {
  Object.assign(detail, { data: null, error: null, isFetching: false, isFetchedAfterMount: true, isSuccess: false, isPlaceholderData: false, isPaused: false }, next);
}
/** Phiếu chờ duyệt đầy đủ hạng mục — như dòng danh sách đã làm giàu bằng RPC chi tiết. */
const listRow = {
  id: "v", type: "EXPENSE", code: "PC-TEST", name: "Phiếu thử", total_amount: 100, user_id: "u",
  approval_status: "UNAPPROVED", attachments: [], items: [], contract_id: null, invoice_id: null,
  system_source: null, detail_read: { complete: true, expected_item_count: 0 },
};
const batch = {
  id: "batch", name: "Đợt thử", type: "EXPENSE", total_amount: 100, voucher_count: 1, building_names: [],
  attachments: [], vouchers: [{ id: "v", items: [], total_amount: 100, approval_status: "UNAPPROVED", account_id: "a" }],
  has_approved: false, all_cancelled: false,
} as unknown as IncomeExpenseBatchSummary;

afterEach(() => {
  cleanup();
  detail.refetch.mockReset();
});

// Chủ chốt 30/09/2026: bấm phiếu là hiện NGAY từ dòng danh sách; nút thao tác khoá
// tới khi bản đọc mới về; bản mới báo hết quyền hoặc lỗi thì ẩn nội dung.
describe("chi tiết phiếu hiện ngay từ dòng danh sách", () => {
  const open = (onApprove = vi.fn()) =>
    wrap(<IncomeExpenseDetailMobile voucherId="v" onClose={() => {}} onApprove={onApprove} />);

  it("có bản xem trước: nội dung hiện ngay, nút thao tác khoá, báo đang cập nhật", () => {
    setState({ data: listRow, isPlaceholderData: true, isSuccess: true, isFetching: true, isFetchedAfterMount: false });
    render(open());
    expect(screen.getByText("PC-TEST")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Duyệt" }).matches(":disabled")).toBe(true);
    expect(screen.getByText(/Đang cập nhật/)).toBeTruthy();
    expect(screen.queryByText("Thử lại")).toBeNull();
  });

  it("bản xem trước KHÔNG BAO GIỜ mở khoá nút — kể cả khi các cờ khác báo đã tải xong", () => {
    // Nút duyệt/chi chỉ mở theo bản đọc mới. Cờ isPlaceholderData là hàng rào cuối,
    // không dựa vào việc thư viện luôn kèm isFetching=true cho bản xem trước.
    setState({ data: listRow, isPlaceholderData: true, isSuccess: true, isFetching: false, isFetchedAfterMount: true });
    render(open());
    expect(screen.getByText("PC-TEST")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Duyệt" }).matches(":disabled")).toBe(true);
    expect(screen.getByText(/Đang cập nhật/)).toBeTruthy();
  });

  it("bản đọc mới về: mở khoá nút, hết dòng đang cập nhật", () => {
    setState({ data: listRow, isPlaceholderData: true, isSuccess: true, isFetching: true, isFetchedAfterMount: false });
    const onApprove = vi.fn();
    const view = render(open(onApprove));
    setState({ data: listRow, isSuccess: true, isFetching: false, isFetchedAfterMount: true });
    view.rerender(open(onApprove));
    const approve = screen.getByRole("button", { name: "Duyệt" });
    expect(approve.matches(":disabled")).toBe(false);
    expect(screen.queryByText(/Đang cập nhật/)).toBeNull();
    fireEvent.click(approve);
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("bản đọc mới báo hết quyền: ẩn nội dung đang xem trước", () => {
    setState({ data: listRow, isPlaceholderData: true, isSuccess: true, isFetching: true, isFetchedAfterMount: false });
    const view = render(open());
    setState({ data: null, isSuccess: true, isFetching: false, isFetchedAfterMount: true });
    view.rerender(open());
    expect(screen.queryByText("PC-TEST")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("không còn quyền xem");
  });

  it("làm mới ngầm (realtime) sau khi đã có bản mới: vẫn hiện nội dung, khoá nút tới khi xong", () => {
    setState({ data: listRow, isSuccess: true, isFetching: true, isFetchedAfterMount: true });
    render(open());
    expect(screen.getByText("PC-TEST")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Duyệt" }).matches(":disabled")).toBe(true);
  });

  it("làm mới hỏng: không giữ nội dung cũ, báo lỗi kèm Thử lại", () => {
    setState({ data: listRow, isSuccess: false, isFetching: false, isFetchedAfterMount: true, error: new Error("x") });
    render(open());
    expect(screen.queryByText("PC-TEST")).toBeNull();
    expect(screen.getByRole("button", { name: "Thử lại" })).toBeTruthy();
  });

  it("máy tính: bản xem trước hiện ngay, nút Duyệt khoá tới khi bản mới về", () => {
    setState({ data: listRow, isPlaceholderData: true, isSuccess: true, isFetching: true, isFetchedAfterMount: false });
    render(wrap(<IncomeExpenseDetailDialog open voucherId="v" voucher={null} onOpenChange={() => {}} onApprove={() => {}} />));
    expect(screen.getByText("PC-TEST")).toBeTruthy();
    expect(screen.getByTitle("Duyệt phiếu").matches(":disabled")).toBe(true);
    // Các khối vẫn cách nhau như khi là con trực tiếp của lưới DialogContent (gap-4).
    expect(document.querySelector("fieldset")?.className).toMatch(/(^|\s)grid(\s|$)/);
    expect(document.querySelector("fieldset")?.className).toMatch(/(^|\s)gap-4(\s|$)/);
  });

  // Phiếu chi đã duyệt, có số TK nhận và ảnh — hiện đủ nút thao tác, nút chi qua app, ô ảnh.
  const payable = {
    ...listRow, approval_status: "APPROVED", receive_bank_account: "0123456789", receive_bank_name: "MB",
    attachments: ["https://kho.test/a.png"],
  };
  const openAll = () =>
    wrap(<IncomeExpenseDetailMobile voucherId="v" onClose={() => {}} onApprove={vi.fn()} onEdit={vi.fn()}
      onQuickEdit={vi.fn()} onCancel={vi.fn()} onRestore={vi.fn()} onCopy={vi.fn()} onPostApproved={vi.fn()}
      onReversePosting={vi.fn()} />);

  it("đang khoá: MỌI nút thao tác khoá; chỉ nút Đóng và ô ảnh đính kèm (chỉ để xem) còn bấm được", () => {
    setState({ data: payable, isPlaceholderData: true, isSuccess: true, isFetching: true, isFetchedAfterMount: false });
    render(openAll());
    const nut = Array.from(document.querySelectorAll<HTMLButtonElement>(".sheet button"));
    const chiDeXem = (b: HTMLButtonElement) => b.classList.contains("sheet-x") || b.classList.contains("vd-att");
    expect(nut.filter(chiDeXem).length).toBeGreaterThanOrEqual(2); // Đóng + 1 ô ảnh
    expect(nut.filter(chiDeXem).every((b) => !b.matches(":disabled"))).toBe(true);
    const thaoTac = nut.filter((b) => !chiDeXem(b));
    expect(thaoTac.some((b) => /Chi tiền qua app/.test(b.textContent ?? ""))).toBe(true);
    expect(thaoTac.filter((b) => !b.matches(":disabled")).map((b) => b.textContent || b.title)).toEqual([]);
  });

  it("đang khoá: nút Xử lý bỏ cọc (nằm sau phần ảnh, vùng khoá riêng) cũng khoá", () => {
    quyen.data = { __superadmin: true }; // đủ quyền bỏ cọc + duyệt
    try {
      const coc = {
        ...listRow, type: "INCOME", approval_status: "APPROVED", contract_id: null,
        items: [{ id: "i1", type_name: "Cọc giữ phòng", amount: 1000000, is_deposit: true }],
        detail_read: { complete: true, expected_item_count: 1 },
      };
      setState({ data: coc, isPlaceholderData: true, isSuccess: true, isFetching: true, isFetchedAfterMount: false });
      render(openAll());
      expect(screen.getByRole("button", { name: "Xử lý bỏ cọc" }).matches(":disabled")).toBe(true);
    } finally {
      quyen.data = {};
    }
  });

  it("đang mở tấm chi qua app mà phiếu đọc lại: tấm đóng, bản mới về cũng không tự mở lại", () => {
    setState({ data: payable, isSuccess: true, isFetching: false, isFetchedAfterMount: true });
    const view = render(openAll());
    fireEvent.click(screen.getByRole("button", { name: /Chi tiền qua app/ }));
    expect(screen.getByText("tam-chi-qua-app")).toBeTruthy();
    // Realtime báo có đổi ⇒ đọc lại: QR không được đứng trên số liệu có thể vừa đổi.
    setState({ data: payable, isSuccess: true, isFetching: true, isFetchedAfterMount: true });
    view.rerender(openAll());
    expect(screen.queryByText("tam-chi-qua-app")).toBeNull();
    setState({ data: payable, isSuccess: true, isFetching: false, isFetchedAfterMount: true });
    view.rerender(openAll());
    expect(screen.queryByText("tam-chi-qua-app")).toBeNull();
  });

  it("hộp chi tiết (bố cục điện thoại): đang mở tấm chi qua app mà phiếu đọc lại thì tấm đóng", () => {
    manHinh.dienThoai = true; // nút chi qua app của hộp này chỉ hiện ở bố cục điện thoại
    try {
      setState({ data: payable, isSuccess: true, isFetching: false, isFetchedAfterMount: true });
      const dlg = () => wrap(<IncomeExpenseDetailDialog open voucherId="v" voucher={null} onOpenChange={() => {}} />);
      const view = render(dlg());
      fireEvent.click(screen.getByRole("button", { name: /Chi tiền qua app/ }));
      expect(screen.getByText("tam-chi-qua-app")).toBeTruthy();
      setState({ data: payable, isSuccess: true, isFetching: true, isFetchedAfterMount: true });
      view.rerender(dlg());
      expect(screen.queryByText("tam-chi-qua-app")).toBeNull();
    } finally {
      manHinh.dienThoai = false;
    }
  });

  it("đọc lại bị tạm dừng vì mất mạng: nội dung vẫn hiện, nút vẫn khoá (dữ liệu có thể đã cũ)", () => {
    setState({ data: listRow, isSuccess: true, isFetching: false, isFetchedAfterMount: true, isPaused: true });
    render(open());
    expect(screen.getByText("PC-TEST")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Duyệt" }).matches(":disabled")).toBe(true);
  });
});

// Hộp con render qua portal nên fieldset không khoá được: tấm phiếu phải truyền `locked`
// xuống / tự đóng khi phiếu đọc lại. Chạy cho cả tấm phiếu điện thoại và hộp chi tiết.
describe.each([
  ["tấm phiếu điện thoại", false],
  ["hộp chi tiết", true],
])("%s: hộp con đóng khi phiếu đọc lại", (_ten, hopChiTiet) => {
  const ve = () => (hopChiTiet
    ? wrap(<IncomeExpenseDetailDialog open voucherId="v" voucher={null} onOpenChange={() => {}} />)
    : wrap(<IncomeExpenseDetailMobile voucherId="v" onClose={() => {}} />));
  const banMoi = (data: unknown) => setState({ data, isSuccess: true, isFetching: false, isFetchedAfterMount: true });
  const docLai = (data: unknown) => setState({ data, isSuccess: true, isFetching: true, isFetchedAfterMount: true });

  it("Gán QL nhận hoa hồng", () => {
    const hoaHong = {
      ...listRow, organization_id: "o1", approval_version: 1, posting_status: "UNPOSTED",
      items: [{ id: "i1", type_name: "Hoa hồng 303/44TL", category: "HOA HỒNG", amount: 100 }],
      detail_read: { complete: true, expected_item_count: 1 },
    };
    banMoi(hoaHong);
    const view = render(ve());
    fireEvent.click(screen.getByTestId("ie-assign-commission-manager"));
    expect(screen.getByText("Gán quản lý nhận hoa hồng")).toBeTruthy();
    docLai(hoaHong);
    view.rerender(ve());
    expect(screen.queryByText("Gán quản lý nhận hoa hồng")).toBeNull();
  });

  it("Đổi hình thức thu", () => {
    dongThu.data = {
      id: "t1", collection_id: "c1", organization_id: "o1", line_index: 0, payment_method: "TK", account_id: "a1",
      account_name: "MBHIEP", gross_amount: 100, change_amount: 0, rounding_amount: 0, voucher_id: "v",
      collector_name: "NATHAN", building_id: "b1", building_name: "102LVT",
      collection: { id: "c1", invoice_id: "i1", status: "ACTIVE", actor_id: "u", created_at: "2026-09-25T08:00:00Z", collection_date: "2026-09-25" },
    };
    try {
      const thu = { ...listRow, type: "INCOME", invoice_id: "i1", approval_status: "APPROVED", organization_id: "o1" };
      banMoi(thu);
      const view = render(ve());
      fireEvent.click(screen.getByTestId("ie-change-collection-method"));
      expect(screen.getByText("hop-doi-hinh-thuc")).toBeTruthy();
      docLai(thu);
      view.rerender(ve());
      expect(screen.queryByText("hop-doi-hinh-thuc")).toBeNull();
    } finally {
      dongThu.data = null;
    }
  });

  it("Xử lý bỏ cọc: đọc lại thì hộp bị GỠ HẲN (như main), bản mới về không tự mở lại", () => {
    quyen.data = { __superadmin: true };
    try {
      const coc = {
        ...listRow, type: "INCOME", approval_status: "APPROVED", contract_id: null,
        items: [{ id: "i1", type_name: "Cọc giữ phòng", amount: 1000000, is_deposit: true }],
        detail_read: { complete: true, expected_item_count: 1 },
      };
      banMoi(coc);
      const view = render(ve());
      fireEvent.click(screen.getByRole("button", { name: "Xử lý bỏ cọc" }));
      expect(screen.getByTestId("hop-bo-coc").dataset.open).toBe("true");
      docLai(coc);
      view.rerender(ve());
      expect(screen.queryByTestId("hop-bo-coc")).toBeNull(); // gỡ hẳn — lần tải dở không ghi vào hộp
      banMoi(coc);
      view.rerender(ve());
      expect(screen.getByTestId("hop-bo-coc").dataset.open).toBe("false");
    } finally {
      quyen.data = {};
    }
  });
});

describe("chi tiết phiếu trên điện thoại — trạng thái đọc", () => {
  it("đang tải: giữ khung tấm phiếu có nút đóng, không có nút Thử lại", () => {
    setState({ isFetching: true, isFetchedAfterMount: false });
    const onClose = vi.fn();
    const { container } = render(wrap(<IncomeExpenseDetailMobile voucherId="v" onClose={onClose} />));
    expect(container.querySelector(".sheet")).not.toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Đang tải chi tiết phiếu…");
    expect(screen.queryByText("Thử lại")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Đóng" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("tải hỏng: Thử lại là nút rõ ràng và gọi tải lại", () => {
    setState({ isSuccess: false });
    render(wrap(<IncomeExpenseDetailMobile voucherId="v" onClose={() => {}} />));
    expect(screen.getByRole("status").textContent).toContain("Không tải được đầy đủ chi tiết phiếu.");
    const retry = screen.getByRole("button", { name: "Thử lại" });
    expect(retry.className).toContain("invbtn");
    fireEvent.click(retry);
    expect(detail.refetch).toHaveBeenCalledTimes(1);
  });

  it("đọc quá hạn: nói rõ là mạng chậm và mời Thử lại", () => {
    const timeout = Object.assign(new Error("Mạng chậm — quá 30 giây chưa tải xong. Kiểm tra mạng rồi bấm Thử lại."), { name: "DetailReadTimeoutError" });
    setState({ isSuccess: false, error: timeout } as Partial<typeof detail>);
    render(wrap(<IncomeExpenseDetailMobile voucherId="v" onClose={() => {}} />));
    expect(screen.getByRole("status").textContent).toContain("Mạng chậm");
    expect(screen.getByRole("button", { name: "Thử lại" })).toBeTruthy();
  });

  it("lỗi đọc có phân loại: hết quyền, trang cũ hơn máy chủ, mất mạng — không gộp thành một câu chung", () => {
    // Query chi tiết im toast chung (meta.silent) nên câu tại chỗ phải tự nói được
    // điều toast từng nói: có đáng thử lại không, hay phải tải lại trang.
    setState({ isSuccess: false, error: { code: "42703", message: "column does not exist" } } as Partial<typeof detail>);
    const view = render(wrap(<IncomeExpenseDetailMobile voucherId="v" onClose={() => {}} />));
    expect(screen.getByRole("status").textContent).toMatch(/tải lại trang/i);
    setState({ isSuccess: false, error: new TypeError("Load failed") } as Partial<typeof detail>);
    view.rerender(wrap(<IncomeExpenseDetailMobile voucherId="v" onClose={() => {}} />));
    expect(screen.getByRole("status").textContent).toMatch(/kết nối/i);
    setState({ isSuccess: false, error: new Error("Không tải đủ chi tiết phiếu. Vui lòng thử lại.") } as Partial<typeof detail>);
    view.rerender(wrap(<IncomeExpenseDetailMobile voucherId="v" onClose={() => {}} />));
    expect(screen.getByRole("status").textContent).toContain("Không tải được đầy đủ chi tiết phiếu.");
  });

  it("đang tải: chạm nền không đóng (tránh chạm đúp vào dòng phiếu đóng luôn tấm vừa mở); hỏng rồi thì chạm nền đóng", () => {
    setState({ isFetching: true, isFetchedAfterMount: false });
    const onClose = vi.fn();
    const view = render(wrap(<IncomeExpenseDetailMobile voucherId="v" onClose={onClose} />));
    fireEvent.click(view.container.querySelector(".sheet-ov")!);
    expect(onClose).not.toHaveBeenCalled();
    setState({ isSuccess: false });
    view.rerender(wrap(<IncomeExpenseDetailMobile voucherId="v" onClose={onClose} />));
    fireEvent.click(view.container.querySelector(".sheet-ov")!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("hết quyền xem: nói rõ lý do, vẫn trong khung tấm phiếu", () => {
    setState({ isSuccess: true, data: null });
    const { container } = render(wrap(<IncomeExpenseDetailMobile voucherId="v" onClose={() => {}} />));
    expect(container.querySelector(".sheet")).not.toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Phiếu không còn khả dụng hoặc bạn không còn quyền xem.");
  });

  it("khung chờ trượt lên một lần; nội dung về thì hiện tại chỗ, không bật về đáy trượt lại", () => {
    // Đo WebKit khung iPhone 30/09/2026: khung chờ trượt 302→75 px, nội dung về thì
    // tấm mới bắt đầu lại ở 666 px (đáy) và trượt lên lần nữa — giật hai lần.
    setState({ isFetching: true, isFetchedAfterMount: false });
    const view = render(wrap(<IncomeExpenseDetailMobile voucherId="v" onClose={() => {}} />));
    expect(view.container.querySelector(".sheet-ov")?.classList.contains("sheet-still")).toBe(false);
    setState({
      isSuccess: true,
      data: {
        id: "v", type: "EXPENSE", code: "PC-TEST", name: "Phiếu thử", total_amount: 100, user_id: "u",
        approval_status: "UNAPPROVED", attachments: [], items: [], contract_id: null, invoice_id: null,
        system_source: null, detail_read: { complete: true, expected_item_count: 0 },
      },
    });
    view.rerender(wrap(<IncomeExpenseDetailMobile voucherId="v" onClose={() => {}} />));
    expect(screen.getByText("PC-TEST")).toBeTruthy();
    expect(view.container.querySelector(".sheet-ov")?.classList.contains("sheet-still")).toBe(true);
  });

  it("chi tiết đợt đang tải: cũng không mời Thử lại", () => {
    setState({ isFetching: true, isFetchedAfterMount: false });
    render(wrap(<IncomeExpenseBatchDetailMobile batch={batch} onClose={() => {}} />));
    expect(screen.getByRole("status").textContent).toContain("Đang tải chi tiết đợt…");
    expect(screen.queryByText("Thử lại")).toBeNull();
    expect(screen.queryByText("Đợt thử")).toBeNull();
  });
});

describe("chi tiết phiếu trên máy tính — trạng thái đọc", () => {
  it("đang tải: không mời Thử lại", () => {
    setState({ isFetching: true, isFetchedAfterMount: false });
    render(wrap(<IncomeExpenseDetailDialog open voucherId="v" voucher={null} onOpenChange={() => {}} />));
    expect(screen.getByRole("status").textContent).toContain("Đang tải chi tiết phiếu…");
    expect(screen.queryByText("Thử lại")).toBeNull();
  });

  it("tải hỏng: vẫn có Thử lại", () => {
    setState({ isSuccess: false });
    render(wrap(<IncomeExpenseDetailDialog open voucherId="v" voucher={null} onOpenChange={() => {}} />));
    fireEvent.click(screen.getByRole("button", { name: "Thử lại" }));
    expect(detail.refetch).toHaveBeenCalledTimes(1);
  });
});
