// @vitest-environment jsdom
// Màn Chốt lợi nhuận: mở khoá tháng phải qua hộp xác nhận có ô "Lý do mở khoá"
// 8–1000 ký tự (chủ chốt 25/09/2026), và lỗi chốt của máy chủ — nhất là câu 55000
// "Còn N phiếu chờ duyệt…" — hiện nguyên văn trên màn, không chỉ trong toast.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProfitCloseOrganizationScope,
  ProfitCloseState,
  ProfitCloseStateRow,
} from "@/hooks/useShareholderProfit";

const state = vi.hoisted(() => ({
  unlockCalls: [] as unknown[],
  unlockFails: false,
  closeError: null as Error | null,
  closeVariables: null as { organizationId: string; periodMonth: string } | null,
  profitState: null as unknown,
  closingStatus: [] as unknown[],
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/pages/reports/finance/ProfitHubShell", () => ({
  ProfitHubSlot: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("@/hooks/useCashbookClosing", () => ({
  useCashbookMonthlyClosingStatus: () => ({ data: state.closingStatus }),
}));
vi.mock("@/hooks/useShareholderProfit", () => ({
  useCloseProfitPeriod: () => ({
    isPending: false,
    isError: state.closeError !== null,
    error: state.closeError,
    variables: state.closeVariables,
    mutateAsync: vi.fn(),
  }),
  useResetProfitPeriod: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useUnlockProfitMonth: () => ({
    isPending: false,
    mutateAsync: async (input: unknown) => {
      state.unlockCalls.push(input);
      if (state.unlockFails) throw new Error("máy chủ từ chối");
      return { run_id: "run-1", affected_buildings: 2, idempotent_replay: false };
    },
  }),
  useProfitClosePreview: () => ({
    data: undefined,
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  useProfitCloseState: (organizationId?: string) => ({
    data: organizationId ? state.profitState : undefined,
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  useProfitTotalGroupPeers: () => ({ data: undefined }),
}));

import ProfitLockTab from "../ProfitLockTab";
import { periodOf } from "../shareholderUtils";

const ORG = "dddd0000-0000-4000-8000-000000000001";
const B1 = "bbbb0000-0000-4000-8000-000000000001";
const B2 = "bbbb0000-0000-4000-8000-000000000002";
const now = new Date();
const KY = periodOf(now.getFullYear(), now.getMonth() + 1);

const ORGS: ProfitCloseOrganizationScope[] = [
  {
    organization_id: ORG,
    organization_name: "Công ty DEMO",
    organization_slug: "demo",
    // Chỉ có quyền mở khoá: bảng dựng từ snapshot, không cần preview.
    can_lock: false,
    can_unlock: true,
  },
];

const dong = (buildingId: string, buildingName: string): ProfitCloseStateRow => ({
  id: `snap-${buildingName}`,
  building_id: buildingId,
  building_name: buildingName,
  is_virtual: false,
  building_deleted: false,
  status: "LOCKED",
  computed_profit: 1_000_000,
  adjusted_profit: 1_000_000,
  adjustment_amount: 0,
  adjustment_reason: null,
  management_salary: 0,
  distributable_profit: 1_000_000,
  shareholder_percent_total: 100,
  shareholder_allocated_amount: 1_000_000,
  unallocated_profit: 0,
  unallocated_disposition: null,
  unallocated_disposition_reason: null,
  source_revenue: 2_000_000,
  source_expense: 1_000_000,
  source_hash: "b".repeat(32),
  is_stale: false,
  stale_reason: null,
  revision_number: 1,
  locked_at: "2026-08-02T00:00:00Z",
});

const TRANG_THAI: ProfitCloseState = {
  organization_id: ORG,
  period_month: KY,
  can_lock: false,
  can_unlock: true,
  state_hash: "a".repeat(32),
  snapshot_ids: ["snap-15KV", "snap-102LVT"],
  snapshot_count: 2,
  locked_count: 2,
  draft_count: 0,
  real_building_count: 2,
  active_real_snapshot_count: 2,
  has_out_of_scope_snapshots: false,
  rows: [dong(B1, "15KV"), dong(B2, "102LVT")],
};

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { value() {} });
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", { value() { return false; } });
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { value() {} });
  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", { value() {} });
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  state.unlockCalls = [];
  state.unlockFails = false;
  state.closeError = null;
  state.closeVariables = null;
  state.profitState = TRANG_THAI;
});
afterEach(cleanup);

/** Tick đủ hai nhà (không tin vào vùng chọn tự gợi ý). */
async function chonHetNha() {
  const tatCa = await screen.findByRole("checkbox", { name: "Chọn tất cả nhà" });
  if (tatCa.getAttribute("aria-checked") !== "true") fireEvent.click(tatCa);
  await screen.findByRole("button", { name: "Mở khoá 2 nhà đã chọn" });
}

async function moHopMoKhoa() {
  render(<ProfitLockTab organizations={ORGS} />);
  await chonHetNha();
  fireEvent.click(screen.getByRole("button", { name: "Mở khoá 2 nhà đã chọn" }));
  return screen.findByRole("alertdialog");
}

describe("ProfitLockTab — mở khoá tháng có lý do", () => {
  it("chưa đủ 8 ký tự thì nút Mở khoá mờ; đủ thì gửi đúng tổ chức, kỳ, nhà và lý do", async () => {
    const hop = await moHopMoKhoa();
    expect(within(hop).getByText("15KV · 102LVT")).toBeTruthy();
    expect(within(hop).getByText(/sẽ bị\s+XOÁ/)).toBeTruthy();

    const nut = within(hop).getByRole("button", { name: "Mở khoá 2 nhà" }) as HTMLButtonElement;
    expect(nut.disabled).toBe(true);

    const oLyDo = within(hop).getByLabelText("Lý do mở khoá");
    fireEvent.change(oLyDo, { target: { value: "   1234567   " } });
    expect(nut.disabled).toBe(true);
    expect(within(hop).getByText(/7\/1000 ký tự/)).toBeTruthy();

    fireEvent.change(oLyDo, { target: { value: "Sửa phiếu PC2607001 nhập sai số tiền" } });
    expect(nut.disabled).toBe(false);
    fireEvent.click(nut);

    await waitFor(() => expect(state.unlockCalls).toHaveLength(1));
    expect(state.unlockCalls[0]).toEqual({
      organizationId: ORG,
      periodMonth: KY,
      buildingIds: [B1, B2],
      reason: "Sửa phiếu PC2607001 nhập sai số tiền",
    });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("máy chủ từ chối thì hộp vẫn mở và giữ nguyên lý do để thử lại", async () => {
    state.unlockFails = true;
    const hop = await moHopMoKhoa();
    const oLyDo = within(hop).getByLabelText("Lý do mở khoá") as HTMLTextAreaElement;
    fireEvent.change(oLyDo, { target: { value: "Sửa phiếu PC2607001 nhập sai số tiền" } });
    fireEvent.click(within(hop).getByRole("button", { name: "Mở khoá 2 nhà" }));

    await waitFor(() => expect(state.unlockCalls).toHaveLength(1));
    // Chờ lượt gọi thất bại xử lý xong rồi mới soi hộp — soi sớm là xanh giả.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(oLyDo.value).toBe("Sửa phiếu PC2607001 nhập sai số tiền");
  });
});

describe("ProfitLockTab — lỗi chốt tháng", () => {
  const CAU_55000 =
    "Còn 2 phiếu chờ duyệt trong tháng 07/2026 của toà 15KV: PC2607001, PC2607002 — duyệt hoặc huỷ trước khi chốt.";

  it("câu 55000 'Còn N phiếu chờ duyệt…' hiện nguyên văn trên màn", async () => {
    state.closeError = Object.assign(new Error(CAU_55000), { code: "55000" });
    state.closeVariables = { organizationId: ORG, periodMonth: KY };
    render(<ProfitLockTab organizations={ORGS} />);
    expect(await screen.findByText(CAU_55000)).toBeTruthy();
  });

  it("lỗi của lượt chốt tháng khác không treo sang tháng đang xem", async () => {
    state.closeError = new Error(CAU_55000);
    state.closeVariables = { organizationId: ORG, periodMonth: "2000-01-01" };
    render(<ProfitLockTab organizations={ORGS} />);
    await screen.findByRole("checkbox", { name: "Chọn tất cả nhà" });
    expect(screen.queryByText(CAU_55000)).toBeNull();
  });
});
