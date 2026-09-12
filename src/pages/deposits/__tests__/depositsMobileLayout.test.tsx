/** @vitest-environment jsdom */
// Khung màn app của Sổ cọc trên điện thoại.
//
// `.cm-stage` là `display:flex; justify-content:center` (src/styles/mobileApp.css),
// còn `.cm-app` là `width:100%; max-width:432px` — tức một flex item CO ĐƯỢC.
// Đặt thêm bất kỳ phần tử nào làm anh em của `.cm-app` bên trong `.cm-stage` sẽ
// biến khung điện thoại thành một cột của layout hai cột: `.cm-app` bị bóp lại
// dưới 432px, tiêu đề bị cắt, dải KPI ba ô dính vào nhau.
//
// Test này chốt bất biến đó ở mức cấu trúc thay vì đi đo pixel: trong `.cm-stage`
// chỉ được có `.cm-app`. Mọi nội dung khác phải nằm trong vùng cuộn `.mbody`.
// Dialog Radix không tính — khi đóng chúng render null, khi mở chúng đi portal.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useCopilotPageContext", () => ({
  useCopilotPageContext: () => {},
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children, ...rest }: { children?: unknown }) =>
    createElement("a", rest as Record<string, unknown>, children as never),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@/hooks/usePersistedState", () => ({
  // Mặc định "work"; test đổi view bằng cách render lại với giá trị khác không
  // cần thiết ở đây — khung app phải đúng ở MỌI view.
  usePersistedState: (_key: string, initial: unknown) => [initial, vi.fn()],
}));

vi.mock("@/hooks/useMyPermissions", () => ({
  useMyPermissions: () => ({ data: {} }),
}));

vi.mock("@/lib/permissionPages", () => ({
  canUse: () => true,
}));

vi.mock("@/hooks/income-expenses/statusMutations", () => ({
  useApproveVoucher: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/useDepositDashboard", () => ({
  useHeldDeposits: () => ({ data: [], isLoading: false }),
  useHeldDepositSummary: () => ({ data: [] }),
  useRefundForfeitSummary: () => ({ data: { orphanCount: 0, orphanTotal: 0 } }),
  useReservationDepositSettlementSummary: () => ({
    data: { retainedAmount: 0, refundPendingAmount: 0, refundPaidAmount: 0 },
  }),
}));

vi.mock("@/hooks/useDeposits", () => ({
  useReservationDeposits: () => ({ data: [], isLoading: false }),
}));

vi.mock("@/hooks/useReservationHoldDeadlines", () => ({
  useReservationHoldDeadlines: () => ({ data: {} }),
}));

vi.mock("@/components/deposits/CreateDepositDialog", () => ({
  CreateDepositDialog: () => null,
}));

vi.mock("@/components/deposits/HoldDeadlineDialog", () => ({
  HoldDeadlineDialog: () => null,
}));

vi.mock("@/components/contracts/ContractFormDialog", () => ({
  ContractFormDialog: () => null,
}));

vi.mock("@/components/deposits/ReservationSettlementDialog", () => ({
  ReservationSettlementDialog: () => null,
}));

vi.mock("@/components/deposits/ReservationPendingRefundList", () => ({
  ReservationPendingRefundList: () =>
    createElement("section", { "data-probe": "pending-refund" }),
}));

const { default: DepositsMobilePage } = await import("../DepositsMobilePage");

function dungKhung() {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(createElement(DepositsMobilePage));
  const stage = host.querySelector(".cm-stage");
  if (!stage) throw new Error("không dựng được .cm-stage");
  return { host, stage };
}

describe("DepositsMobilePage · khung app", () => {
  it("trong .cm-stage chỉ có .cm-app, không có anh em nào bóp khung", () => {
    const { stage } = dungKhung();
    const lac = Array.from(stage.children).filter(
      (el) => !el.classList.contains("cm-app"),
    );
    expect(lac.map((el) => el.outerHTML.slice(0, 120))).toEqual([]);
  });

  it('danh sách "Chờ hoàn cọc" nằm trong vùng cuộn .mbody', () => {
    const { host } = dungKhung();
    const probe = host.querySelector('[data-probe="pending-refund"]');
    expect(probe, "không render ReservationPendingRefundList").toBeTruthy();
    expect(probe?.closest(".mbody"), "nằm ngoài .mbody").toBeTruthy();
  });
});
