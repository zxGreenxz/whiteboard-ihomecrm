// @vitest-environment jsdom
// Hộp chi tiết máy tính và tấm chi tiết điện thoại: đủ nút như nhau, hiện theo MỘT bảng luật
// (src/lib/voucherActionRules.ts) — chủ chốt 28/10/2026 "đừng để phân mảnh mất sự thống nhất".
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";

const detail = vi.hoisted(() => ({
  data: null as unknown, error: null, isFetching: false, isFetchedAfterMount: true, isSuccess: true,
  isPlaceholderData: false, isPaused: false, refetch: () => {},
}));
const env = vi.hoisted(() => ({
  perms: {} as Record<string, unknown>,
  isAdmin: false,
  canonical: true,
}));
// Không bắn request thật: mọi chuỗi truy vấn trả { data: null, error: null }.
vi.mock("@/integrations/supabase/client", () => {
  const ketQua = Promise.resolve({ data: null, error: null });
  const chuoi: unknown = new Proxy(function () {}, {
    get: (_t, p) => (p === "then" ? ketQua.then.bind(ketQua) : chuoi),
    apply: () => chuoi,
  });
  return { supabase: chuoi };
});
vi.mock("@/hooks/income-expenses/detailRead", () => ({ useIncomeExpenseDetail: () => detail }));
vi.mock("@/hooks/useIncomeExpenses", () => ({ useIncomeExpenseHistory: () => ({ data: [] }) }));
vi.mock("@/hooks/useIsAdmin", () => ({
  useIsAdmin: () => ({ data: env.isAdmin }), useIsSuperAdmin: () => ({ data: env.isAdmin }),
}));
vi.mock("@/hooks/useMyPermissions", () => ({ useMyPermissions: () => ({ data: env.perms }) }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ data: { id: "u-xem" } }) }));
vi.mock("@/hooks/useAccounts", () => ({ useAccounts: () => ({ data: [] }) }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@/hooks/useIsCompanyOwner", () => ({ useIsCompanyOwner: () => ({ data: false }) }));
vi.mock("@/hooks/useReservationSettlement", () => ({
  useReservationSettlementForVoucher: () => ({ data: null, error: null, isSuccess: true, isLoading: false }),
}));
vi.mock("@/lib/financeV2Route", async (orig) => {
  const thatSu = await orig<typeof import("@/lib/financeV2Route")>();
  const canonical = { readSemantics: "CANONICAL", workflow: "CANONICAL", posting: "CANONICAL", access: "CANONICAL", accountingStandardStrict: false };
  return { ...thatSu, useFinanceV2Routes: () => ({ getOrg: () => (env.canonical ? canonical : thatSu.LEGACY_ROUTES), isLoading: false }) };
});
vi.mock("@/components/income-expenses/PayViaBankAppSheet", () => ({ default: () => null, PayViaBankAppSheet: () => null }));
vi.mock("@/components/ui/storage-image", () => ({ StorageImage: ({ alt }: { alt: string }) => <span>{alt}</span> }));
vi.mock("@/components/deposits/ReservationSettlementDialog", () => ({ ReservationSettlementDialog: () => null }));
vi.mock("@/components/income-expenses/QlManagerSelect", () => ({ QlManagerSelect: () => null }));

import IncomeExpenseDetailMobile from "../IncomeExpenseDetailMobile";
import { IncomeExpenseDetailDialog } from "../IncomeExpenseDetailDialog";

const scoped = (...actions: string[]) => ({
  income_expenses: Object.fromEntries(actions.map((a) => [a, { org_wide: false, building_ids: ["b1"] }])),
});
const phieu = (p: Record<string, unknown> = {}) => ({
  id: "v", type: "EXPENSE", code: "PC-TEST", name: "Phiếu thử", total_amount: 100, user_id: "u-lap",
  approval_status: "UNAPPROVED", posting_status: "UNPOSTED", attachments: [], items: [], contract_id: null,
  invoice_id: null, system_source: null, building_id: "b1", organization_id: "o1", repeat_cycle: "NONE",
  repeat_parent_id: null, verified_at: null, detail_read: { complete: true, expected_item_count: 0 }, ...p,
});
function wrap(node: ReactNode) {
  return <QueryClientProvider client={new QueryClient()}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>;
}
const handlers = () => ({
  onApprove: vi.fn(), onCancel: vi.fn(), onUnapprove: vi.fn(), onPostApproved: vi.fn(), onReversePosting: vi.fn(),
  onVerify: vi.fn(), onHistory: vi.fn(), onStopRecurring: vi.fn(),
});
const desktop = (h: Partial<ReturnType<typeof handlers>>, extra: Record<string, unknown> = {}) =>
  wrap(<IncomeExpenseDetailDialog open voucher={null} voucherId="v" onOpenChange={() => {}} {...h} {...extra} />);
const mobile = (h: Partial<ReturnType<typeof handlers>>, extra: Record<string, unknown> = {}) =>
  wrap(<IncomeExpenseDetailMobile voucherId="v" onClose={() => {}} {...h} {...extra} />);

beforeEach(() => { env.perms = {}; env.isAdmin = false; env.canonical = true; });
afterEach(cleanup);

describe("hộp chi tiết máy tính — chỗ cắm mới", () => {
  it("màn không truyền chỗ cắm mới (vd hộp phiếu tổng) ⇒ y như trước, không có nút mới", () => {
    detail.data = phieu({ approval_status: "APPROVED", posting_status: "POSTED", repeat_cycle: "MONTH" });
    env.perms = scoped("reverse", "edit");
    render(desktop({ onCancel: vi.fn() }));
    for (const title of [/^Mở lại/, /^Chi tiền từ sổ/, /lịch sử phiếu/, /Dừng lặp/, /kiểm tra/]) {
      expect(screen.queryByTitle(title)).toBeNull();
    }
  });

  it("phiếu đã duyệt chưa chi ⇒ Chi tiền từ sổ; bấm ⇒ gọi đúng phiếu", () => {
    detail.data = phieu({ approval_status: "APPROVED" });
    const h = handlers();
    render(desktop(h));
    fireEvent.click(screen.getByTitle("Chi tiền từ sổ (phiếu đã duyệt)"));
    expect(h.onPostApproved).toHaveBeenCalledWith(expect.objectContaining({ id: "v" }));
  });

  it("phiếu đã chi: Mở lại chỉ khi có quyền hoàn tác ở toà; tổ chức chưa ghi sổ kiểu mới thì không", () => {
    detail.data = phieu({ approval_status: "APPROVED", posting_status: "POSTED" });
    render(desktop(handlers()));
    expect(screen.queryByTitle(/^Mở lại/)).toBeNull();
    cleanup();
    env.perms = scoped("reverse");
    render(desktop(handlers()));
    expect(screen.getByTitle("Mở lại (tiền về sổ, rồi chi lại hoặc huỷ)")).toBeTruthy();
    cleanup();
    env.canonical = false;
    render(desktop(handlers()));
    expect(screen.queryByTitle(/^Mở lại/)).toBeNull();
  });

  it("Duyệt theo quyền duyệt ở ĐÚNG toà của phiếu", () => {
    detail.data = phieu();
    render(desktop(handlers()));
    expect(screen.queryByTitle("Duyệt phiếu")).toBeNull();
    cleanup();
    env.perms = scoped("approve");
    render(desktop(handlers()));
    expect(screen.getByTitle("Duyệt phiếu")).toBeTruthy();
  });

  it("Huỷ theo máy chủ: không có quyền ⇒ ẩn; tháng đã chốt ⇒ vẫn bấm được để hộp xác nhận nói lý do; người tạo được huỷ ⇒ hiện", () => {
    detail.data = phieu();
    env.perms = scoped("cancel");
    render(desktop(handlers(), { cancelEligibility: { v: { id: "v", eligible: false, reason_code: "NO_PERMISSION" } } }));
    expect(screen.queryByTitle(/^Huỷ phiếu/)).toBeNull();
    cleanup();
    const h = handlers();
    render(desktop(h, { cancelEligibility: { v: { id: "v", eligible: false, reason_code: "PROFIT_LOCKED" } } }));
    // nút mờ không đọc được lý do (máy tính: không hiện tooltip; điện thoại: không có hover) ⇒ cho bấm,
    // hộp xác nhận chung hiện "Không huỷ được: …" và khoá nút xác nhận
    const khoa = screen.getByTitle(/^Huỷ phiếu — Tháng đã chốt lợi nhuận/);
    expect(khoa.matches(":disabled")).toBe(false);
    fireEvent.click(khoa);
    expect(h.onCancel).toHaveBeenCalledWith("v", "EXPENSE");
    cleanup();
    env.perms = {};
    render(desktop(handlers(), { cancelEligibility: { v: { id: "v", eligible: true, reason_code: null } } }));
    expect(screen.getByTitle("Huỷ phiếu").matches(":disabled")).toBe(false);
  });

  it("Đánh dấu đã kiểm / Lịch sử / Dừng lặp (phiếu gốc đang lặp + quyền sửa ở toà)", () => {
    detail.data = phieu({ approval_status: "APPROVED", posting_status: "POSTED", repeat_cycle: "MONTH" });
    env.perms = scoped("edit");
    const h = handlers();
    render(desktop(h));
    fireEvent.click(screen.getByTitle("Đánh dấu đã kiểm tra"));
    expect(h.onVerify).toHaveBeenCalled();
    cleanup();
    render(desktop(h));
    fireEvent.click(screen.getByTitle("Xem lịch sử phiếu (mốc lập/duyệt/huỷ + thay đổi)"));
    expect(h.onHistory).toHaveBeenCalled();
    cleanup();
    render(desktop(h));
    fireEvent.click(screen.getByTitle("Dừng lặp lại (giữ phiếu + các phiếu đã sinh)"));
    expect(h.onStopRecurring).toHaveBeenCalledWith("v");
  });
});

describe("tấm chi tiết điện thoại — đủ nút như máy tính", () => {
  it("Huỷ duyệt cho super admin trên phiếu đã duyệt (trước đây điện thoại không có)", () => {
    detail.data = phieu({ approval_status: "APPROVED", posting_status: "POSTED" });
    env.isAdmin = true;
    const h = handlers();
    render(mobile(h));
    fireEvent.click(screen.getByRole("button", { name: "Huỷ duyệt" }));
    expect(h.onUnapprove).toHaveBeenCalledWith("v");
  });

  it("không phải super admin ⇒ không có Huỷ duyệt", () => {
    detail.data = phieu({ approval_status: "APPROVED", posting_status: "POSTED" });
    render(mobile(handlers()));
    expect(screen.queryByRole("button", { name: "Huỷ duyệt" })).toBeNull();
  });

  it("Đánh dấu đã kiểm, Lịch sử, Dừng lặp có trên điện thoại", () => {
    detail.data = phieu({ approval_status: "APPROVED", posting_status: "POSTED", repeat_cycle: "MONTH" });
    env.perms = scoped("edit");
    render(mobile(handlers()));
    for (const name of ["Đánh dấu đã kiểm tra", "Xem lịch sử phiếu", "Dừng lặp lại"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
  });

  it("Huỷ bị máy chủ chặn vì khoá sổ: tấm điện thoại vẫn cho chạm (không có tooltip để đọc lý do)", () => {
    detail.data = phieu();
    env.perms = scoped("cancel");
    const h = handlers();
    render(mobile(h, { cancelEligibility: { v: { id: "v", eligible: false, reason_code: "CASHBOOK_CLOSED" } } }));
    const huy = screen.getByRole("button", { name: "Huỷ" });
    expect(huy.matches(":disabled")).toBe(false);
    fireEvent.click(huy);
    expect(h.onCancel).toHaveBeenCalledWith("v", "EXPENSE");
  });

  it("Duyệt / Huỷ cùng luật với máy tính", () => {
    detail.data = phieu();
    render(mobile(handlers()));
    expect(screen.queryByRole("button", { name: "Duyệt" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Huỷ" })).toBeNull();
    cleanup();
    env.perms = scoped("approve", "cancel");
    render(mobile(handlers()));
    expect(screen.getByRole("button", { name: "Duyệt" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Huỷ" })).toBeTruthy();
  });
});
