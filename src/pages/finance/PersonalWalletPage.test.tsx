// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  fireEvent,
  within,
} from "@testing-library/react";
import type { Snapshot } from "@/lib/personalFinance/contract";
import PersonalWalletPage from "./PersonalWalletPage";
import { localMonth } from "@/lib/personalFinance/selectors";
import { shiftMonth } from "@/components/personal-finance/presentation";

const nav = vi.hoisted(() => ({ type: "POP" as "POP" | "PUSH" | "REPLACE" }));
vi.mock("react-router-dom", async (original) => ({
  ...(await original<object>()),
  useNavigationType: () => nav.type,
}));
const data = vi.hoisted(() => ({
  create: false,
  controller: null as Record<string, unknown> | null,
  snapshot: {
    owner_id: "owner",
    schema_version: 1,
    wallets: [],
    categories: [],
    transactions: [],
    transfers: [],
    budgets: [],
    goals: [],
  } as unknown as Snapshot,
}));
vi.mock("@/hooks/personal-finance/usePersonalFinance", () => ({
  usePersonalFinance: () => ({ data: data.snapshot, refetch: vi.fn() }),
  usePersonalFinanceMutation: () => ({ pending: [] }),
}));
vi.mock("@/hooks/personal-finance/usePersonalFinancePermissions", () => ({
  usePersonalFinancePermissions: () => ({
    data: { create: data.create, edit: false, delete: false },
  }),
}));
vi.mock("@/hooks/quick-entry/useQuickEntryController", () => ({
  useQuickEntryController: () => data.controller ?? {},
}));
vi.mock("@/components/quick-entry/EmbeddedQuickEntry", () => ({
  QuickEntryInput: () => <textarea aria-label="Nội dung khoản chi" />,
  QuickEntryDraftFeed: () => null,
  PersonalPendingRequests: () => null,
}));
vi.mock("@/components/layout/MainLayout", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
// Dòng "Từ công ty" (D2.18): cổ đông, quyền trang Báo cáo Lợi Nhuận, sổ tổng E3 (nhánh cũ gỡ ở D3.14).
const profit = vi.hoisted(() => ({
  shareholder: null as Record<string, unknown> | null,
  perms: {} as Record<string, unknown>,
  ledger: { data: undefined as unknown, error: null as unknown },
  ledgerHook: vi.fn(),
  refetchLedger: vi.fn(),
  // Vị thế của chính mình (R2): hai con số "Lợi nhuận chưa chi" · "Tạm ứng đang có".
  position: { data: undefined as unknown, isError: false },
  positionHook: vi.fn(),
  refetchPosition: vi.fn(),
}));
vi.mock("@/hooks/useShareholders", () => ({
  useMyShareholder: () => ({ data: profit.shareholder, error: null, refetch: vi.fn() }),
}));
vi.mock("@/hooks/useMyPermissions", () => ({
  useMyPermissions: () => ({ data: profit.perms, error: null, isLoading: false, refetch: vi.fn() }),
}));
vi.mock("@/hooks/profit-ledger/useProfitLedgerQueries", () => ({
  useMyProfitLedger: (organizationId: string | null, options?: { enabled?: boolean }) => {
    profit.ledgerHook(organizationId, options);
    return options?.enabled === false
      ? { data: undefined, error: null, refetch: profit.refetchLedger }
      : { ...profit.ledger, refetch: profit.refetchLedger };
  },
  useMyShareholderPosition: (organizationId: string | null, options?: { enabled?: boolean }) => {
    profit.positionHook(organizationId, options);
    return options?.enabled === false
      ? { data: undefined, isError: false, refetch: profit.refetchPosition }
      : { ...profit.position, refetch: profit.refetchPosition };
  },
}));
vi.mock("@/components/personal-finance/CompanyFinance", () => ({
  default: ({ view }: { view: string }) => <div data-testid="company-panel">Công ty · {view}</div>,
}));
/** jsdom không có PerformanceNavigationTiming ⇒ trang lấy đường dẫn hiện tại làm nơi tài liệu được mở. */
const launchAsApp = (standalone: boolean, openedAt = "/finance/personal-wallet") => {
  window.matchMedia = ((query: string) => ({ matches: standalone && query === "(display-mode: standalone)" })) as unknown as typeof window.matchMedia;
  window.history.replaceState(null, "", openedAt);
};
let visibility: DocumentVisibilityState = "visible";
Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
const switchApp = (state: DocumentVisibilityState) => {
  visibility = state;
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(window, "matchMedia");
  window.history.replaceState(null, "", "/");
  nav.type = "POP";
  visibility = "visible";
  data.create = false;
  data.controller = null;
  profit.shareholder = null;
  profit.perms = {};
  profit.ledger = { data: undefined, error: null };
  profit.position = { data: undefined, isError: false };
  vi.clearAllMocks();
  data.snapshot = {
    owner_id: "owner",
    schema_version: 1,
    wallets: [],
    categories: [],
    transactions: [],
    transfers: [],
    budgets: [],
    goals: [],
  };
});
const personalController = () => ({
  mode: "personal",
  modes: ["personal"],
  setMode: vi.fn(),
  feed: { cards: {}, addManual: vi.fn() },
});
it("opened from the home-screen app: entry sheet is up with the cursor in the composer, overview renders behind later", () => {
  vi.useFakeTimers();
  launchAsApp(true);
  data.create = true;
  data.controller = personalController();
  render(<PersonalWalletPage />);
  const sheet = screen.getByRole("dialog", { name: "Ghi thu chi" });
  expect(document.activeElement).toBe(within(sheet).getByLabelText("Nội dung khoản chi"));
  expect(screen.queryByTestId("total-balance")).toBeNull();
  act(() => vi.advanceTimersByTime(2000));
  expect(screen.getByTestId("total-balance")).toBeTruthy();
  expect(screen.getByRole("dialog", { name: "Ghi thu chi" })).toBe(sheet);
});
it("closing the auto-opened sheet shows the overview at once", () => {
  launchAsApp(true);
  data.create = true;
  data.controller = personalController();
  render(<PersonalWalletPage />);
  const sheet = screen.getByRole("dialog", { name: "Ghi thu chi" });
  fireEvent.click(within(sheet).getByRole("button", { name: "Đóng" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByTestId("total-balance")).toBeTruthy();
});
it.each([
  ["a normal browser tab", false, true, "/finance/personal-wallet", "POP"],
  ["an app launch without create permission", true, false, "/finance/personal-wallet", "POP"],
  ["the CRM app opened at / then the wallet menu", true, true, "/", "PUSH"],
  ["a link inside the wallet app back to the wallet", true, true, "/finance/personal-wallet", "PUSH"],
] as const)("%s keeps the overview first", (_case, standalone, create, openedAt, type) => {
  launchAsApp(standalone, openedAt);
  nav.type = type;
  data.create = create;
  data.controller = personalController();
  render(<PersonalWalletPage />);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByTestId("total-balance")).toBeTruthy();
});
it("returning to the wallet app after a minute opens the entry sheet again; a quick switch does not", () => {
  vi.useFakeTimers();
  launchAsApp(true);
  data.create = true;
  data.controller = personalController();
  render(<PersonalWalletPage />);
  fireEvent.click(within(screen.getByRole("dialog", { name: "Ghi thu chi" })).getByRole("button", { name: "Đóng" }));
  switchApp("hidden");
  vi.advanceTimersByTime(20_000);
  switchApp("visible");
  expect(screen.queryByRole("dialog")).toBeNull();
  switchApp("hidden");
  vi.advanceTimersByTime(61_000);
  switchApp("visible");
  const sheet = screen.getByRole("dialog", { name: "Ghi thu chi" });
  expect(document.activeElement).toBe(within(sheet).getByLabelText("Nội dung khoản chi"));
});
it("returning to the app while another dialog is open does not cover it", () => {
  vi.useFakeTimers();
  launchAsApp(true);
  data.create = true;
  data.controller = personalController();
  render(<PersonalWalletPage />);
  fireEvent.click(within(screen.getByRole("dialog", { name: "Ghi thu chi" })).getByRole("button", { name: "Đóng" }));
  const other = document.body.appendChild(Object.assign(document.createElement("div"), { role: "dialog" }));
  other.setAttribute("role", "dialog");
  other.setAttribute("data-state", "open");
  switchApp("hidden");
  vi.advanceTimersByTime(61_000);
  switchApp("visible");
  expect(screen.queryByRole("dialog", { name: "Ghi thu chi" })).toBeNull();
  other.remove();
});
it("coming back from login (REPLACE) inside the wallet app still opens the entry sheet", () => {
  launchAsApp(true);
  nav.type = "REPLACE";
  data.create = true;
  data.controller = personalController();
  render(<PersonalWalletPage />);
  expect(screen.getByRole("dialog", { name: "Ghi thu chi" })).toBeTruthy();
});
it("reopening a saved manual company entry creates a fresh company draft", () => {
  data.create = true;
  const cards: Record<string, { status: { kind: string } }> = {};
  const addManual = vi.fn(() => {
    const id = `manual-${Object.keys(cards).length}`;
    cards[id] = { status: { kind: "draft" } };
    return id;
  });
  data.controller = {
    mode: "company",
    modes: ["company"],
    setMode: vi.fn(),
    feed: { cards, addManual },
  };
  render(<PersonalWalletPage />);
  fireEvent.click(screen.getByRole("button", { name: "Ghi thu chi" }));
  fireEvent.click(screen.getByRole("button", { name: "Nhập tay" }));
  expect(addManual).toHaveBeenCalledTimes(1);
  cards["manual-0"].status.kind = "saved";
  fireEvent.click(screen.getByRole("button", { name: "Đóng" }));
  fireEvent.click(screen.getByRole("button", { name: "Ghi thu chi" }));
  expect(addManual).toHaveBeenCalledTimes(2);
  expect(cards["manual-1"].status.kind).toBe("draft");
});
it("manual destination can switch to company and back without losing personal amount", () => {
  data.create = true;
  const cards: Record<string, { status: { kind: string } }> = {};
  const addManual = vi.fn(() => {
    cards.manual = { status: { kind: "draft" } };
    return "manual";
  });
  const setMode = vi.fn();
  data.controller = {
    mode: "personal",
    modes: ["personal", "company"],
    setMode,
    feed: { cards, addManual },
  };
  const view = render(<PersonalWalletPage />);
  fireEvent.click(screen.getByRole("button", { name: "Ghi thu chi" }));
  const sheet = within(screen.getByRole("dialog"));
  fireEvent.click(sheet.getByRole("button", { name: "Nhập tay" }));
  fireEvent.change(sheet.getByLabelText("Số tiền"), {
    target: { value: "123000" },
  });
  fireEvent.click(sheet.getByRole("button", { name: "Công ty" }));
  expect(setMode).toHaveBeenCalledWith("company");
  data.controller.mode = "company";
  view.rerender(<PersonalWalletPage />);
  expect(addManual).toHaveBeenCalledWith("company");
  expect(sheet.getByText("Sổ thu chi công ty")).toBeTruthy();
  fireEvent.click(sheet.getByRole("button", { name: "Cá nhân" }));
  data.controller.mode = "personal";
  view.rerender(<PersonalWalletPage />);
  expect(sheet.getByLabelText("Số tiền")).toHaveProperty("value", "123000");
});
it("opens recent transaction details from the overview and shows filter sheets in ledger", () => {
  data.snapshot.transactions = [
    {
      id: "recent",
      user_id: "owner",
      type: "EXPENSE",
      amount: 50000,
      txn_date: `${localMonth()}-01`,
      created_at: "2026-10-01T00:00:00Z",
      deleted_at: null,
      resolved_category_id: null,
      category: "Ăn uống",
      description: "Bữa trưa",
    },
  ] as Snapshot["transactions"];
  render(<PersonalWalletPage />);
  fireEvent.click(screen.getByRole("button", { name: "Xem Bữa trưa" }));
  expect(screen.getByRole("dialog").textContent).toContain(
    "Chi tiết giao dịch",
  );
  fireEvent.click(screen.getByRole("button", { name: "Đóng" }));
  fireEvent.click(screen.getByRole("button", { name: /Xem tất cả/ }));
  fireEvent.click(screen.getByRole("button", { name: "Lọc ví" }));
  expect(screen.getByRole("dialog").textContent).toContain("Lọc theo ví");
});
it.each(["wallet", "month", "older report month", "goal"])(
  "shows a controlled money range error for %s and recovers on corrected snapshot",
  (kind) => {
    if (kind === "wallet")
      data.snapshot.wallets = [
        { balance: Number.MAX_SAFE_INTEGER, name: "A", id: "a" },
        { balance: 1, name: "B", id: "b" },
      ] as Snapshot["wallets"];
    else if (kind === "goal")
      data.snapshot.goals = [
        { target: 1e12, saved: 0.00001 },
      ] as Snapshot["goals"];
    else
      data.snapshot.transactions = [Number.MAX_SAFE_INTEGER, 1].map(
        (amount, i) => ({
          id: String(i),
          user_id: "owner",
          type: "EXPENSE",
          amount,
          txn_date: `${kind === "month" ? localMonth() : shiftMonth(localMonth(), -1)}-01`,
          created_at: "2026-10-01T00:00:00Z",
          deleted_at: null,
          resolved_category_id: null,
          category: null,
        }),
      ) as Snapshot["transactions"];
    const { rerender } = render(<PersonalWalletPage />);
    expect(screen.getByRole("alert").textContent).toMatch(
      /biểu diễn chính xác/,
    );
    expect(screen.queryByTestId("total-balance")).toBeNull();
    expect(screen.getByRole("button", { name: "Tải lại" })).toBeTruthy();
    data.snapshot = {
      ...data.snapshot,
      wallets: [],
      transactions: [],
      goals: [],
    };
    rerender(<PersonalWalletPage />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("total-balance").textContent).toBe("0 ₫");
  },
);
it("keeps personal totals separate and puts the company filter immediately after transfers", async () => {
  data.snapshot.wallets = [{ id: "personal", name: "Ví riêng", balance: 123000, hidden: false }] as Snapshot["wallets"];
  render(<PersonalWalletPage />);
  expect(screen.getByTestId("total-balance").textContent).toBe("123.000 ₫");
  const group = within(screen.getByRole("group", { name: "Nhóm ví" }));
  fireEvent.click(group.getByRole("button", { name: "Công ty" }));
  expect((await screen.findByTestId("company-panel")).textContent).toContain("overview");
  expect(screen.queryByTestId("total-balance")).toBeNull();
  fireEvent.click(group.getByRole("button", { name: "Cá nhân" }));
  expect(screen.getByTestId("total-balance").textContent).toBe("123.000 ₫");
  fireEvent.click(screen.getByRole("button", { name: "Giao dịch" }));
  const transferChip = screen.getByRole("button", { name: "Chuyển ví" });
  expect(transferChip.nextElementSibling?.textContent).toBe("Công ty");
  fireEvent.click(screen.getByRole("button", { name: "Công ty" }));
  expect((await screen.findByTestId("company-panel")).textContent).toContain("ledger");
  expect(screen.queryByRole("button", { name: "Chuyển tiền giữa ví" })).toBeNull();
});
describe("dòng \"Từ công ty\" đọc sổ tổng (D2.18)", () => {
  const shareholder = { id: "sh-1", name: "Cổ đông 1", organization_id: "org-a" };
  const ledger = (over: Record<string, unknown> = {}) => ({
    organization_id: "org-a", route: "CANONICAL", ready: true, shareholder: { id: "sh-1", name: "Cổ đông 1" },
    balance: 1_500_000, status: "OWED", allocated: 7_000_000, paid: 2_000_000, paid_pending: 500_000,
    paid_via_salary: 3_500_000, advance_recovered: 500_000, marker: null, months: [], payouts: [], salary: [], ...over,
  });
  const line = () => document.querySelector("aside.pf-card")?.textContent ?? null;
  // Vị thế (R2): lợi nhuận chưa chi − tạm ứng đang có − tạm ứng chờ duyệt = số dư ròng.
  const myPosition = (over: Record<string, unknown> = {}) => ({
    organization_id: "org-a", route: "CANONICAL", shareholder: { id: "sh-1", name: "Cổ đông 1" },
    unpaid_profit: 2_500_000, advance_outstanding: 700_000, advance_pending: 300_000, settlement_cash_pending: 0, balance: 1_500_000,
    settled: { recognized: 0, offset: 0, cash: 0 }, last_settled_through_month: null, marker_month: null,
    needs_review: { count: 0, suggested: 0 }, settlements: [],
    components: { allocated: 0, payouts_pending: 300_000, payouts_approved: 700_000, salary_investment: 0, salary_advance_offset: 0, unpaid_profit_raw: 2_500_000, advance_outstanding_raw: 700_000, advance_overoffset: 0 },
    ...over,
  });

  it("sổ tổng đã chạy ⇒ được chia · đã nhận + chờ duyệt · qua lương (E3) · HAI số của vị thế (R2)", () => {
    profit.shareholder = shareholder;
    profit.perms = { reports_finance: { profit_distribution: true } };
    profit.ledger = { data: ledger(), error: null };
    profit.position = { data: myPosition(), isError: false };
    render(<PersonalWalletPage />);
    expect(profit.ledgerHook).toHaveBeenCalledWith("org-a", { enabled: true });
    expect(profit.positionHook).toHaveBeenCalledWith("org-a", { enabled: true });
    expect(line()).toBe("Từ công ty: Được chia 7.000.000 ₫ · Đã nhận 2.000.000 ₫ (+ chờ duyệt 500.000 ₫) · Qua lương 3.000.000 ₫ · Lợi nhuận chưa chi 2.500.000 ₫ · Tạm ứng đang có 700.000 ₫ (chờ duyệt 300.000 ₫)");
  });

  it("lợi nhuận chưa chi ÂM hiện đúng dấu; không tạm ứng chờ duyệt thì không có ngoặc", () => {
    profit.shareholder = shareholder;
    profit.perms = { reports_finance: { profit_distribution: true } };
    profit.ledger = { data: ledger({ paid_pending: 0, salary: [], paid_via_salary: 0, advance_recovered: 0 }), error: null };
    profit.position = { data: myPosition({ unpaid_profit: -800_000, advance_outstanding: 0, advance_pending: 0, balance: -800_000 }), isError: false };
    render(<PersonalWalletPage />);
    expect(line()).toBe("Từ công ty: Được chia 7.000.000 ₫ · Đã nhận 2.000.000 ₫ · Lợi nhuận chưa chi -800.000 ₫ · Tạm ứng đang có 0 ₫");
    expect(line()).not.toMatch(/Còn được nhận|Đang tạm ứng/);
  });

  it("vị thế đang tải ⇒ nói đang tải; lỗi ⇒ báo + Thử lại — không bao giờ hiện 0 thay số chưa đọc được", () => {
    profit.shareholder = shareholder;
    profit.perms = { reports_finance: { profit_distribution: true } };
    profit.ledger = { data: ledger(), error: null };
    const first = render(<PersonalWalletPage />);
    expect(line()).toMatch(/Qua lương 3\.000\.000 ₫ · đang tải lợi nhuận chưa chi và tạm ứng…$/);
    first.unmount();
    profit.position = { data: undefined, isError: true };
    render(<PersonalWalletPage />);
    expect(line()).not.toMatch(/Lợi nhuận chưa chi \d|Tạm ứng đang có \d/);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Chưa tải được lợi nhuận chưa chi và tạm ứng");
    fireEvent.click(within(alert).getByRole("button", { name: "Thử lại" }));
    expect(profit.refetchPosition).toHaveBeenCalled();
  });

  it("máy chủ nói không xem được (42501 ⇒ null) ⇒ ẩn dòng, không báo lỗi trang", () => {
    profit.shareholder = shareholder;
    profit.perms = { reports_finance: { profit_distribution: true } };
    profit.ledger = { data: null, error: null };
    render(<PersonalWalletPage />);
    expect(line()).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("sổ tổng tắt (ready=false) ⇒ một dòng báo tắt, không số nào (dòng cũ đã gỡ ở D3.14)", () => {
    profit.shareholder = shareholder;
    profit.perms = { reports_finance: { profit_distribution: true } };
    profit.ledger = { data: ledger({ route: "LEGACY", ready: false }), error: null };
    render(<PersonalWalletPage />);
    expect(line()).toBe("Từ công ty: sổ lợi nhuận đang tắt, chưa có số.");
    expect(screen.getByTestId("shareholder-ledger-off")).toBeTruthy();
    expect(screen.queryByTestId("shareholder-ledger-notice")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    // Sổ tổng tắt thì không đọc vị thế.
    expect(profit.positionHook).toHaveBeenCalledWith("org-a", { enabled: false });
  });

  it("không có trang Báo cáo Lợi Nhuận (chỉ quyền tạm ứng) ⇒ không dòng, không gọi sổ tổng", () => {
    profit.shareholder = shareholder;
    profit.perms = { shareholder_profit: { advance_own_cashbook: true } };
    profit.ledger = { data: ledger(), error: null };
    render(<PersonalWalletPage />);
    expect(line()).toBeNull();
    expect(document.body.textContent).not.toContain("phần lợi nhuận cổ đông");
    expect(profit.ledgerHook).toHaveBeenCalledWith("org-a", { enabled: false });
  });

  it("E3 lỗi ⇒ báo tại chỗ + Thử lại (không im lặng, không hiện 0)", () => {
    profit.shareholder = shareholder;
    profit.perms = { reports_finance: { profit_distribution: true } };
    profit.ledger = { data: undefined, error: { code: "XX000", message: "PROFIT_LEDGER_ENTRIES_DRIFT: lệch" } };
    render(<PersonalWalletPage />);
    expect(screen.getByRole("alert").textContent).toContain("Chưa tải được phần lợi nhuận cổ đông");
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Thử lại" }));
    expect(profit.refetchLedger).toHaveBeenCalled();
    expect(line()).toBeNull();
  });
});
