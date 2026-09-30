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
  refetch: vi.fn(),
}));
vi.mock("@/hooks/income-expenses/detailRead", () => ({ useIncomeExpenseDetail: () => detail }));
vi.mock("@/hooks/useVoucherDetail", () => ({ useVoucherWithBatch: () => detail }));
vi.mock("@/hooks/useIncomeExpenses", () => ({
  useIncomeExpenseHistory: () => ({ data: [] }),
  useUpdateBatchAccount: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/useIsAdmin", () => ({ useIsAdmin: () => ({ data: false }), useIsSuperAdmin: () => ({ data: false }) }));
vi.mock("@/hooks/useMyPermissions", () => ({ useMyPermissions: () => ({ data: {} }) }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ data: { id: "u" } }) }));
vi.mock("@/hooks/useAccounts", () => ({ useAccounts: () => ({ data: [] }) }));
vi.mock("@/hooks/useIsCompanyOwner", () => ({ useIsCompanyOwner: () => ({ data: false }) }));
vi.mock("@/hooks/useReservationSettlement", () => ({
  useReservationSettlementForVoucher: () => ({ data: null, error: null, isSuccess: true, isLoading: false }),
}));
vi.mock("@/lib/financeV2Route", () => ({ useFinanceV2Routes: () => ({ getOrg: () => null }), isCanonicalRead: () => false }));
vi.mock("@/components/income-expenses/PayViaBankAppSheet", () => ({ default: () => null, PayViaBankAppSheet: () => null }));
vi.mock("@/components/deposits/ReservationSettlementDialog", () => ({ ReservationSettlementDialog: () => null }));

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
  Object.assign(detail, { data: null, error: null, isFetching: false, isFetchedAfterMount: true, isSuccess: false }, next);
}
const batch = {
  id: "batch", name: "Đợt thử", type: "EXPENSE", total_amount: 100, voucher_count: 1, building_names: [],
  attachments: [], vouchers: [{ id: "v", items: [], total_amount: 100, approval_status: "UNAPPROVED", account_id: "a" }],
  has_approved: false, all_cancelled: false,
} as unknown as IncomeExpenseBatchSummary;

afterEach(() => {
  cleanup();
  detail.refetch.mockReset();
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
