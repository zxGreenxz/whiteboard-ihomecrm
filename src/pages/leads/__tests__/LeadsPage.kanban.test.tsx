// @vitest-environment jsdom
//
// Kanban Khách hẹn: mỗi cột chỉ dựng một trang thẻ (phân trang cột), nút
// "Xem thêm" nạp trang kế; số đếm ở tiêu đề cột và thẻ thống kê vẫn là tổng
// thật của cột. Tìm kiếm và mở chi tiết vẫn như cũ.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Fragment, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LeadWithRelations } from "@/hooks/useLeads";

const fx = vi.hoisted(() => ({ leads: [] as unknown[] }));

vi.mock("@/hooks/useCopilotPageContext", () => ({ useCopilotPageContext: () => {} }));
vi.mock("@/components/layout/MainLayout", () => ({
  default: ({ children }: { children: ReactNode }) => <Fragment>{children}</Fragment>,
}));
vi.mock("@/hooks/useMyPermissions", () => ({ useMyPermissions: () => ({ data: {} }) }));
vi.mock("@/lib/permissionPages", () => ({ canUse: () => true }));
vi.mock("@/hooks/usePersistedState", () => ({
  usePersistedState: <T,>(_key: string, initial: T | (() => T)) =>
    useState<T>(typeof initial === "function" ? (initial as () => T)() : initial),
}));
vi.mock("@/hooks/useLeads", () => ({
  useLeads: () => ({ data: fx.leads, isLoading: false }),
  useDeleteLead: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/components/leads/LeadCard", () => ({
  LeadCard: ({ lead, onViewDetail }: { lead: LeadWithRelations; onViewDetail: (l: LeadWithRelations) => void }) => (
    <div data-testid="lead-card" onClick={() => onViewDetail(lead)}>
      {lead.customer_name}
    </div>
  ),
}));
vi.mock("@/components/leads/CreateLeadDialog", () => ({ CreateLeadDialog: () => null }));
vi.mock("@/components/leads/EditLeadDialog", () => ({ EditLeadDialog: () => null }));
vi.mock("@/components/leads/ConvertLeadDialog", () => ({ ConvertLeadDialog: () => null }));
vi.mock("@/components/leads/LeadDetailDialog", () => ({
  LeadDetailDialog: ({ open, lead }: { open: boolean; lead: { customer_name: string } }) =>
    open ? <div data-testid="detail-dialog">{lead.customer_name}</div> : null,
}));
vi.mock("@/components/import-export/ExportExcelDialog", () => ({ default: () => null }));

const { default: LeadsPage } = await import("../LeadsPage");

function khach(i: number, status = "B1_LEAD") {
  return {
    id: `kh-${i}`,
    customer_name: `Khách ${i}`,
    phone: `09${String(i).padStart(8, "0")}`,
    email: null,
    status,
  };
}

afterEach(() => cleanup());

describe("LeadsPage · kanban phân trang cột", () => {
  it("200 khách cùng cột → chỉ dựng một trang thẻ, tiêu đề cột vẫn đếm 200", () => {
    fx.leads = Array.from({ length: 200 }, (_, i) => khach(i));
    render(<LeadsPage />);
    const soThe = screen.getAllByTestId("lead-card").length;
    // eslint-disable-next-line no-console
    console.log(`[đo DOM] LeadsPage 200 khách một cột → ${soThe} thẻ trong DOM`);
    expect(soThe, `cột đang dựng ${soThe} thẻ`).toBeLessThan(50);
    expect(screen.getByText("Mới (200)")).toBeTruthy();
    // Thẻ thống kê "Mới" cũng đếm 200.
    expect(screen.getAllByText("200").length).toBeGreaterThan(0);
  });

  it("bấm Xem thêm nạp trang kế của đúng cột", () => {
    fx.leads = Array.from({ length: 200 }, (_, i) => khach(i));
    render(<LeadsPage />);
    const truoc = screen.getAllByTestId("lead-card").length;
    fireEvent.click(screen.getByRole("button", { name: /Xem thêm/ }));
    const sau = screen.getAllByTestId("lead-card").length;
    expect(sau).toBeGreaterThan(truoc);
    expect(sau).toBeLessThanOrEqual(truoc * 2);
  });

  it("tìm kiếm lọc trên toàn bộ danh sách, không chỉ trang đang dựng", () => {
    fx.leads = Array.from({ length: 200 }, (_, i) => khach(i));
    render(<LeadsPage />);
    fireEvent.change(screen.getByPlaceholderText(/Tìm kiếm theo tên/), { target: { value: "Khách 19" } });
    // "Khách 19", "Khách 190".."Khách 199" → 11 khách, tất cả nằm ngoài trang đầu (index 19 nằm trong, 190+ nằm ngoài).
    expect(screen.getAllByTestId("lead-card")).toHaveLength(11);
    expect(screen.getByText("Mới (11)")).toBeTruthy();
  });

  it("bấm thẻ mở chi tiết đúng khách", () => {
    fx.leads = Array.from({ length: 200 }, (_, i) => khach(i));
    render(<LeadsPage />);
    fireEvent.click(screen.getAllByTestId("lead-card")[3]!);
    expect(screen.getByTestId("detail-dialog").textContent).toBe("Khách 3");
  });

  it("cột ít hơn một trang → không có nút Xem thêm", () => {
    fx.leads = Array.from({ length: 5 }, (_, i) => khach(i));
    render(<LeadsPage />);
    expect(screen.getAllByTestId("lead-card")).toHaveLength(5);
    expect(screen.queryByRole("button", { name: /Xem thêm/ })).toBeNull();
  });
});
