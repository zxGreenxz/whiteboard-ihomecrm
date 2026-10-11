// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
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
vi.mock("@/hooks/useShareholders", () => ({
  useMyShareholder: () => ({ data: null }),
}));
vi.mock("@/hooks/useShareholderProfit", () => ({
  useProfitAllocations: () => ({}),
  useShareholderDistributions: () => ({}),
  computeShareholderSummary: vi.fn(),
}));
vi.mock("@/components/personal-finance/CompanyFinance", () => ({
  default: ({ view }: { view: string }) => <div data-testid="company-panel">Công ty · {view}</div>,
}));
const launchAsApp = (standalone: boolean) => {
  window.matchMedia = ((query: string) => ({ matches: standalone && query === "(display-mode: standalone)" })) as unknown as typeof window.matchMedia;
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(window, "matchMedia");
  data.create = false;
  data.controller = null;
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
  ["a normal browser tab", false, true],
  ["an app launch without create permission", true, false],
])("%s keeps the overview first", (_case, standalone, create) => {
  launchAsApp(standalone);
  data.create = create;
  data.controller = personalController();
  render(<PersonalWalletPage />);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByTestId("total-balance")).toBeTruthy();
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
