// @vitest-environment jsdom
// Màn Chốt lợi nhuận: mở khoá tháng phải qua hộp xác nhận có ô "Lý do mở khoá"
// 8–1000 ký tự (chủ chốt 25/09/2026), và lỗi chốt của máy chủ — nhất là câu 55000
// "Còn N phiếu chờ duyệt…" — hiện nguyên văn trên màn, không chỉ trong toast.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProfitCloseOrganizationScope,
  ProfitClosePreview,
  ProfitCloseState,
  ProfitCloseStateRow,
} from "@/hooks/useShareholderProfit";
import {
  FIXED_FEE_KINDS,
  computeProfitReportChecks,
  type ProfitReportChecksResult,
} from "@/lib/profitReportChecks";
import { UNALLOCATED_REASON_SYSTEM_MESSAGE, UNLOCK_REASON_SYSTEM_MESSAGE } from "@/lib/profitClose";

const state = vi.hoisted(() => ({
  unlockCalls: [] as unknown[],
  unlockFails: false,
  closeError: null as Error | null,
  closeVariables: null as { organizationId: string; periodMonth: string } | null,
  profitState: null as unknown,
  closingStatus: [] as unknown[],
  preview: undefined as ProfitClosePreview | undefined,
  closeCalls: [] as unknown[],
  lockChecks: {
    checks: null as ProfitReportChecksResult | null,
    isLoading: false,
    isError: false,
    operatedBuildingIds: new Set<string>() as ReadonlySet<string>,
  },
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
    mutateAsync: async (input: unknown) => { state.closeCalls.push(input); },
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
    data: state.preview,
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
  useProfitTotalGroupPeers: () => ({ data: {}, status: "success", fetchStatus: "idle", isLoading: false, isError: false, error: null, refetch: vi.fn() }),
}));
// Bộ dò chi cố định + toà vận hành (rà 21/10 F20/F07) — mock gọn một chỗ.
vi.mock("@/hooks/useProfitLockChecks", () => ({
  useProfitLockChecks: () => state.lockChecks,
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
  state.preview = undefined;
  state.closeCalls = [];
  // Mặc định: đã dò, không có khoản thiếu/trùng nào.
  state.lockChecks = {
    checks: computeProfitReportChecks({ rows: [], buildings: [], today: "2026-10-22" }),
    isLoading: false,
    isError: false,
    operatedBuildingIds: new Set<string>(),
  };
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
  it("lý do thiếu thì đỏ và focus, đủ thì gửi đúng tổ chức, kỳ, nhà và lý do", async () => {
    const hop = await moHopMoKhoa();
    expect(within(hop).getByText("15KV · 102LVT")).toBeTruthy();
    expect(within(hop).getByText(/sẽ bị\s+XOÁ/)).toBeTruthy();

    const nut = within(hop).getByRole("button", { name: "Mở khoá 2 nhà" }) as HTMLButtonElement;
    expect(nut.disabled).toBe(false);
    fireEvent.click(nut);
    const oLyDo = within(hop).getByLabelText("Lý do mở khoá");
    await waitFor(()=>expect(document.activeElement).toBe(oLyDo));
    expect(oLyDo.getAttribute('aria-invalid')).toBe('true');
    expect(state.unlockCalls).toHaveLength(0);
    fireEvent.change(oLyDo, { target: { value: "   1234567   " } });
    fireEvent.click(nut);
    expect(state.unlockCalls).toHaveLength(0);
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

describe("ProfitLockTab — tháng chốt kiểu cũ (N-A3-01)", () => {
  it("lúc xem hiện 'Giữ lại (chốt kiểu cũ)', không gắn đỏ 'Chưa chọn'", async () => {
    const cu = {
      ...dong(B1, "15KV"),
      unallocated_profit: 100_000,
      shareholder_percent_total: 90,
      shareholder_allocated_amount: 900_000,
      unallocated_disposition: "LEGACY_RETAINED_UNALLOCATED",
      unallocated_disposition_reason: "Chốt trước V3",
    } as unknown as ProfitCloseStateRow;
    state.profitState = { ...TRANG_THAI, rows: [cu], snapshot_ids: ["snap-15KV"], snapshot_count: 1, locked_count: 1, real_building_count: 1, active_real_snapshot_count: 1 };
    render(<ProfitLockTab organizations={ORGS} />);
    expect((await screen.findAllByText(/Giữ lại \(chốt kiểu cũ\)/)).length).toBeGreaterThan(0);
    expect(screen.queryByText("Chưa chọn")).toBeNull();
  });
});

const CLOSE_ORGS = [{ ...ORGS[0], can_lock: true }];
const previewRow = (): ProfitClosePreview['rows'][number] => ({
 building_id: B1, building_name: '15KV', revenue: 2000000, expense: 1000000, computed_profit: 1000000, adjustment_amount: 0,
 management_salary: 0, distributable_profit: 1000000, shareholder_percent_total: 100, shareholder_allocated_amount: 1000000, unallocated_profit: 0, unallocated_disposition: null, unallocated_disposition_reason: null,
 source_hash: 'a'.repeat(32), is_stale: false, stale_reason: null, delta_profit: 0, shareholder_allocations: [], manager_allocations: [], current_snapshot: null,
});
async function mountClose(rowPatch: Partial<ProfitClosePreview['rows'][number]> = {}, sourceHash='a'.repeat(32)) {
 state.preview = { organization_id: ORG, period_month: KY, source_hash: sourceHash, is_locked: false, is_stale: false, rows: [{ ...previewRow(), ...rowPatch }] };
 state.profitState = { ...TRANG_THAI, rows: [], snapshot_ids: [], snapshot_count: 0, locked_count: 0, can_lock: true };
 render(<ProfitLockTab organizations={CLOSE_ORGS} />);
 const all = await screen.findByRole('checkbox', { name: 'Chọn tất cả nhà' });
 if (all.getAttribute('aria-checked') !== 'true') fireEvent.click(all);
 const button = await screen.findByRole('button', { name: 'Chốt 1 nhà đã chọn' });
 await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
 return button;
}
it('vùng chọn trống hiện đỏ/focus checkbox, không disable toast-only', async () => {
 await mountClose(); const all = screen.getByRole('checkbox', { name: 'Chọn tất cả nhà' }); fireEvent.click(all);
 const button = screen.getByRole('button', { name: 'Chốt 0 nhà đã chọn' }) as HTMLButtonElement; expect(button.disabled).toBe(false); fireEvent.click(button);
 await waitFor(() => expect(document.activeElement).toBe(all)); expect(all.getAttribute('aria-invalid')).toBe('true'); expect(screen.getByRole('alert').textContent).toMatch(/Chọn ít nhất một nhà/); expect(state.closeCalls).toHaveLength(0);
});
it.each(['abc', '-', '1.234'])('điều chỉnh draft %s giữ raw/đỏ/focus và không ghi giá trị cũ', async raw => {
 const button = await mountClose(); const amount = screen.getByLabelText('Điều chỉnh lợi nhuận 15KV') as HTMLInputElement;
 fireEvent.focus(amount); fireEvent.change(amount, { target: { value: raw } }); fireEvent.blur(amount); fireEvent.click(button);
 await waitFor(() => expect(document.activeElement).toBe(amount)); expect(amount.value).toBe(raw); expect(amount.getAttribute('aria-invalid')).toBe('true'); expect(state.closeCalls).toHaveLength(0); expect(screen.queryByRole('alertdialog')).toBeNull();
});
it('lý do điều chỉnh focus đúng ô dòng nhà, giữ số đã nhập', async () => {
 const button = await mountClose(); const amount = screen.getByLabelText('Điều chỉnh lợi nhuận 15KV') as HTMLInputElement; const reason = screen.getByLabelText('Lý do điều chỉnh 15KV');
 fireEvent.focus(amount); fireEvent.change(amount, { target: { value: '-123' } }); fireEvent.blur(amount); await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(button);
 await waitFor(() => expect(document.activeElement).toBe(reason)); expect(reason.getAttribute('aria-invalid')).toBe('true'); expect(amount.value).toBe('-123'); expect(state.closeCalls).toHaveLength(0);
});
it('thiếu cách xử lý residual vẫn bấm validation và focus select của đúng nhà', async () => {
 const button = await mountClose({ unallocated_profit: 100000, shareholder_percent_total: 90, shareholder_allocated_amount: 900000 }); expect((button as HTMLButtonElement).disabled).toBe(false); fireEvent.click(button);
 const select = screen.getByRole('combobox', { name: 'Cách xử lý phần chưa phân bổ 15KV' }); await waitFor(() => expect(document.activeElement).toBe(select)); expect(select.getAttribute('aria-invalid')).toBe('true');expect(document.getElementById(select.getAttribute('aria-describedby')??'')?.getAttribute('role')).toBe('alert'); expect(state.closeCalls).toHaveLength(0);
});
it('có disposition nhưng thiếu lý do residual focus đúng ô reason', async () => {
 const button = await mountClose({ unallocated_profit: 100000, unallocated_disposition: 'RETAINED_EARNINGS', shareholder_percent_total: 90, shareholder_allocated_amount: 900000 }); expect((button as HTMLButtonElement).disabled).toBe(false); fireEvent.click(button);
 const reason = screen.getByLabelText('Lý do xử lý phần chưa phân bổ 15KV'); await waitFor(() => expect(document.activeElement).toBe(reason)); expect(reason.getAttribute('aria-invalid')).toBe('true');expect(document.getElementById(reason.getAttribute('aria-describedby')??'')?.getAttribute('role')).toBe('alert'); expect(state.closeCalls).toHaveLength(0);
});

describe("ProfitLockTab — rà 21/10 (F20 dò chi cố định, F07 nhãn, F60 lý do)", () => {
  const ALL_KEYS = FIXED_FEE_KINDS.map((k) => k.key);
  // 15KV chỉ bật Tiền nhà, mức giả 10tr/kỳ, tháng chưa có phiếu nào ⇒ THIẾU.
  const thieuTienNha = () =>
    computeProfitReportChecks({
      rows: [],
      buildings: [{ id: B1, name: "15KV", is_virtual: false, has_elevator: false, hidden_fixed_expenses: ALL_KEYS.filter((k) => k !== "tien_nha"), status: "ACTIVE" }],
      feeRates: [{ buildingId: B1, feeCategory: "tien_nha", defaultAmount: 10_000_000 }],
      expenseTypes: [],
      scopeBuildingIds: [B1],
      today: "2026-10-22",
    });

  it("còn khoản thiếu: hộp chốt liệt kê và chỉ chốt được sau khi tick 'đã xem'", async () => {
    state.lockChecks = { ...state.lockChecks, checks: thieuTienNha() };
    const button = await mountClose();
    fireEvent.click(button);
    const hop = await screen.findByRole("alertdialog");
    expect(within(hop).getByText(/Còn 1 khoản chi cố định thiếu hoặc có thể trùng/)).toBeTruthy();
    expect(within(hop).getByText("Tiền nhà")).toBeTruthy();
    const chot = within(hop).getByRole("button", { name: "Chốt 1 nhà" }) as HTMLButtonElement;
    expect(chot.disabled).toBe(true);
    fireEvent.click(chot);
    expect(state.closeCalls).toHaveLength(0);

    fireEvent.click(within(hop).getByRole("checkbox", { name: "Đã xem cảnh báo chi cố định" }));
    await waitFor(() => expect(chot.disabled).toBe(false));
    fireEvent.click(chot);
    await waitFor(() => expect(state.closeCalls).toHaveLength(1));
  });

  it("không có khoản thiếu: không bắt tick, chốt được ngay", async () => {
    const button = await mountClose();
    fireEvent.click(button);
    const hop = await screen.findByRole("alertdialog");
    expect(within(hop).queryByRole("checkbox", { name: "Đã xem cảnh báo chi cố định" })).toBeNull();
    const chot = within(hop).getByRole("button", { name: "Chốt 1 nhà" }) as HTMLButtonElement;
    expect(chot.disabled).toBe(false);
    fireEvent.click(chot);
    await waitFor(() => expect(state.closeCalls).toHaveLength(1));
  });

  it("đang dò thì chờ; dò lỗi thì phải tick (không chặn cứng)", async () => {
    state.lockChecks = { ...state.lockChecks, checks: null, isLoading: true };
    const button = await mountClose();
    fireEvent.click(button);
    const hop = await screen.findByRole("alertdialog");
    expect(within(hop).getByText(/Đang dò chi cố định/)).toBeTruthy();
    expect((within(hop).getByRole("button", { name: "Chốt 1 nhà" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();

    state.lockChecks = { ...state.lockChecks, checks: null, isLoading: false, isError: true };
    const button2 = await mountClose();
    fireEvent.click(button2);
    const hop2 = await screen.findByRole("alertdialog");
    expect(within(hop2).getByText(/Chưa dò được chi cố định/)).toBeTruthy();
    const chot2 = within(hop2).getByRole("button", { name: "Chốt 1 nhà" }) as HTMLButtonElement;
    expect(chot2.disabled).toBe(true);
    fireEvent.click(within(hop2).getByRole("checkbox", { name: "Đã xem cảnh báo chi cố định" }));
    await waitFor(() => expect(chot2.disabled).toBe(false));
  });

  it("toà vận hành cho chủ nhà có nhãn; lỗi/không quyền (tập rỗng) thì không nhãn", async () => {
    state.lockChecks = { ...state.lockChecks, operatedBuildingIds: new Set([B1]) };
    render(<ProfitLockTab organizations={ORGS} />);
    const nhan = await screen.findAllByTestId("landlord-operated-label");
    expect(nhan).toHaveLength(1);
    expect(nhan[0]?.textContent).toMatch(/Vận hành cho chủ nhà — LN chốt là của cả toà, chưa trừ phần chủ nhà/);
    cleanup();

    state.lockChecks = { ...state.lockChecks, operatedBuildingIds: new Set<string>() };
    render(<ProfitLockTab organizations={ORGS} />);
    await screen.findByRole("checkbox", { name: "Chọn tất cả nhà" });
    expect(screen.queryByTestId("landlord-operated-label")).toBeNull();
  });

  it("lý do mở khoá là nguyên câu báo lỗi ⇒ không gửi, báo đúng lỗi", async () => {
    const hop = await moHopMoKhoa();
    const oLyDo = within(hop).getByLabelText("Lý do mở khoá");
    fireEvent.change(oLyDo, { target: { value: "Lý do mở khoá phải có 8–1000 ký tự" } });
    fireEvent.click(within(hop).getByRole("button", { name: "Mở khoá 2 nhà" }));
    expect(await within(hop).findByText(UNLOCK_REASON_SYSTEM_MESSAGE)).toBeTruthy();
    expect(state.unlockCalls).toHaveLength(0);
  });

  it("lý do giữ lại là nguyên câu báo lỗi (dữ liệu T7) ⇒ không mở hộp chốt, báo tại ô", async () => {
    const button = await mountClose({
      unallocated_profit: 100000,
      unallocated_disposition: "RETAINED_EARNINGS",
      unallocated_disposition_reason: "Lý do xử lý phải có 8–500 ký tự",
      shareholder_percent_total: 90,
      shareholder_allocated_amount: 900000,
    });
    fireEvent.click(button);
    const reason = screen.getByLabelText("Lý do xử lý phần chưa phân bổ 15KV");
    await waitFor(() => expect(document.activeElement).toBe(reason));
    expect(document.getElementById(reason.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      UNALLOCATED_REASON_SYSTEM_MESSAGE,
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(state.closeCalls).toHaveLength(0);
  });
});

it('preview thiếu source hash hiện inline reload, giữ điều chỉnh và không mở xác nhận',async()=>{const button=await mountClose({},'');fireEvent.click(button);const alert=(await screen.findByText('Chưa xác nhận được dữ liệu nguồn. Tải lại số liệu trước khi chốt.')).closest('[role="alert"]') as HTMLElement;expect(alert).toBeTruthy();expect(within(alert).getByRole('button',{name:'Tải lại số liệu'})).toBeTruthy();expect(screen.queryByRole('alertdialog')).toBeNull();expect(state.closeCalls).toHaveLength(0);});
