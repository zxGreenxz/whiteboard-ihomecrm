// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RefundForfeitRow } from "@/hooks/useDepositDashboard";

type QueryState<T> = {
  data: T | undefined;
  status: "pending" | "success" | "error";
  fetchStatus: "idle" | "fetching" | "paused";
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => unknown;
};
type ScopeBuilding = { id: string; organization_id: string };

const state = vi.hoisted(() => ({
  organizationId: "org-a" as string | null,
  organizationLoading: false,
  organizationError: false,
  refunds: {} as QueryState<RefundForfeitRow[]>,
  buildings: {} as QueryState<ScopeBuilding[]>,
  readRefunds: vi.fn(),
  readBuildings: vi.fn(),
  refetchRefunds: vi.fn(),
  refetchBuildings: vi.fn(),
  refetchOrganizations: vi.fn(),
}));
vi.mock("@/contexts/OrganizationContext", () => ({
  useOrganization: () => ({
    selectedOrganizationId: state.organizationId,
    isLoading: state.organizationLoading,
    isError: state.organizationError,
    refetchOrganizations: state.refetchOrganizations,
  }),
}));
vi.mock("@/hooks/useBuildings", () => ({
  useBuildings: (options: unknown) => { state.readBuildings(options); return state.buildings; },
}));
vi.mock("@/hooks/useDepositDashboard", () => ({
  useDepositRefundsForfeits: () => { state.readRefunds(); return state.refunds; },
}));
import { DepositRefundMobilePanel } from "../DepositRefundMobilePanel";

function ready<T>(data: T, refetch: () => unknown): QueryState<T> {
  return { data, status: "success", fetchStatus: "idle", isLoading: false, isError: false, error: null, refetch };
}
function row(id: string, overrides: Partial<RefundForfeitRow> = {}): RefundForfeitRow {
  return {
    id, contract_id: `contract-${id}`, contract_number: `HĐ-${id}`,
    building_id: "building-a", building_name: "Tòa A", room_name: id, customer_name: "Khách",
    termination_date: "2026-11-01", termination_type: "NORMAL", kind: "REFUND", status: "COMPLETED",
    total_deposit: 2_000_000, total_deductions: 500_000, settlement_net: 1_500_000,
    posted_refund: 0, posted_refund_count: 0, posted_refund_codes: [], refund_done: false, refund_drift: 1_500_000,
    ...overrides,
  };
}
function mount() {
  return render(<MemoryRouter><DepositRefundMobilePanel /></MemoryRouter>);
}
function openLedger() {
  fireEvent.click(screen.getByRole("button", { name: "Hoàn / Bỏ cọc" }));
}
function card(id: string) {
  const node = screen.getByRole("link", { name: `HĐ-${id} · Khách` }).closest("li");
  if (!node) throw new Error("Không tìm thấy thẻ hợp đồng");
  return within(node);
}
beforeEach(() => {
  vi.clearAllMocks();
  state.organizationId = "org-a";
  state.organizationLoading = false;
  state.organizationError = false;
  state.refunds = ready([], state.refetchRefunds);
  state.buildings = ready([{ id: "building-a", organization_id: "org-a" }], state.refetchBuildings);
});
afterEach(cleanup);

describe("Hoàn / Bỏ cọc hợp đồng trên điện thoại", () => {
  it("cảnh báo thiếu ngay khi đóng, phân biệt đã hoàn, khách nợ và bỏ cọc khi mở", () => {
    state.refunds.data = [
      row("missing"),
      row("paid", { posted_refund: 1_500_000, posted_refund_count: 1, posted_refund_codes: ["PC-1"], refund_done: true, refund_drift: 0 }),
      row("negative", { settlement_net: -200_000, refund_drift: 0 }),
      row("zero", { settlement_net: 0, refund_drift: 0 }),
      row("forfeit", { kind: "FORFEIT", termination_type: "FORFEIT", settlement_net: 0, refund_drift: 0 }),
    ];
    mount();
    expect(screen.getByRole("alert").textContent).toContain("1 hồ sơ chưa có phiếu hoàn");
    expect(screen.queryByRole("link")).toBeNull();
    openLedger();
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    expect(card("missing").getByRole("alert").textContent).toContain("Chưa có phiếu hoàn");
    expect(card("paid").getByText(/^Đã hoàn /)).toBeTruthy();
    expect(card("paid").getByText("Phiếu đã vào sổ: PC-1")).toBeTruthy();
    expect(card("negative").getByText(/^Khách còn nợ /)).toBeTruthy();
    expect(card("negative").queryByRole("alert")).toBeNull();
    expect(card("zero").getByText("Không phát sinh hoàn")).toBeTruthy();
    expect(card("zero").queryByRole("alert")).toBeNull();
    expect(card("forfeit").getByText("Cọc thành doanh thu")).toBeTruthy();
    expect(card("forfeit").queryByText(/Chưa có phiếu hoàn/)).toBeNull();
    expect(card("missing").getByRole("link").getAttribute("href")).toBe("/contracts/contract-missing");
  });

  it.each(["REFUND", "FORFEIT"] as const)("báo hai phiếu ngay cả khi tổng khớp và loại là %s", kind => {
    state.refunds.data = [row("duplicate", {
      kind, posted_refund: 1_500_000, posted_refund_count: 2, posted_refund_codes: ["PC-1", "PC-2"],
      refund_done: true, refund_drift: 0,
    })];
    mount();
    expect(screen.getByRole("alert").textContent).toContain("1 hồ sơ có nhiều phiếu hoàn");
    openLedger();
    expect(card("duplicate").getByRole("alert").textContent).toContain("Có 2 phiếu hoàn đã vào sổ");
    expect(card("duplicate").getByText("Phiếu đã vào sổ: PC-1, PC-2")).toBeTruthy();
    expect(card("duplicate").queryByText(/Lệch hồ sơ/)).toBeNull();
  });

  it("giữ cảnh báo lệch của reader khi một phiếu đã vào sổ chưa khớp hồ sơ", () => {
    state.refunds.data = [row("drift", { posted_refund: 1_000_000, posted_refund_count: 1, refund_done: true, refund_drift: 500_000 })];
    mount();
    expect(screen.getByRole("alert").textContent).toContain("1 hồ sơ lệch số tiền hoàn");
    openLedger();
    expect(card("drift").getByRole("alert").textContent).toContain("Lệch hồ sơ");
  });

  it.each(["refunds", "buildings"] as const)("lỗi %s không dùng cache để kết luận thiếu phiếu hoặc số 0", source => {
    state.refunds.data = [row("missing")];
    const view = mount();
    openLedger();
    expect(card("missing").getByRole("alert").textContent).toContain("Chưa có phiếu hoàn");
    Object.assign(state[source], { status: "error", isError: true, error: new Error("Network request failed") });
    view.rerender(<MemoryRouter><DepositRefundMobilePanel /></MemoryRouter>);
    expect(screen.getByRole("alert").textContent).toContain("Chưa tải được hoàn / bỏ cọc hợp đồng");
    expect(screen.queryByText(/hồ sơ chưa có phiếu hoàn/)).toBeNull();
    expect(screen.queryByText(/Chưa có hồ sơ thanh lý/)).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("chưa tải xong phiếu không thành danh sách rỗng hoặc cảnh báo thiếu", () => {
    Object.assign(state.refunds, { data: undefined, status: "pending", fetchStatus: "fetching", isLoading: true });
    mount();
    openLedger();
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByText(/hồ sơ thanh lý thuộc/)).toBeNull();
    expect(screen.queryByText(/Chưa có hồ sơ thanh lý/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("chỉ hiện tòa xem được thuộc công ty đã chọn, đổi công ty không giữ thẻ cũ", () => {
    state.buildings.data = [
      { id: "building-a", organization_id: "org-a" },
      { id: "building-b", organization_id: "org-b" },
    ];
    state.refunds.data = [row("a"), row("b", { building_id: "building-b" }), row("hidden", { building_id: "unavailable" })];
    const view = mount();
    openLedger();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(card("a").getByRole("link")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /HĐ-b/ })).toBeNull();
    state.organizationId = "org-b";
    view.rerender(<MemoryRouter><DepositRefundMobilePanel /></MemoryRouter>);
    openLedger();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(card("b").getByRole("link")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /HĐ-a|HĐ-hidden/ })).toBeNull();
  });

  it("công ty không có tòa xem được không rơi về mọi hồ sơ RLS", () => {
    state.buildings.data = [{ id: "building-b", organization_id: "org-b" }];
    state.refunds.data = [row("a"), row("b", { building_id: "building-b" })];
    mount();
    openLedger();
    expect(screen.getByText("Chưa có hồ sơ thanh lý trong phạm vi đang xem.")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("chưa chọn công ty không khởi chạy nguồn tòa hoặc hoàn cọc", () => {
    state.organizationId = null;
    mount();
    expect(screen.getByRole("status").textContent).toContain("Chọn công ty");
    expect(state.readRefunds).not.toHaveBeenCalled();
    expect(state.readBuildings).not.toHaveBeenCalled();
  });

  it("lỗi danh bạ công ty có thông báo và đường tải lại, không đọc hoàn cọc", () => {
    state.organizationError = true;
    mount();
    expect(screen.getByRole("alert").textContent).toContain("Chưa xác định được công ty");
    fireEvent.click(screen.getByRole("button", { name: "Tải lại công ty" }));
    expect(state.refetchOrganizations).toHaveBeenCalledOnce();
    expect(state.readRefunds).not.toHaveBeenCalled();
  });
});
