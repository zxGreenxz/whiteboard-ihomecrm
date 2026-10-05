// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { RowActions, Reports, Ledger, Management } from "./FinanceViews";
import { emptyFilters } from "./presentation";
import { LAUNCHER_SECTIONS } from "@/pages/home/launcherTiles";
import type { Snapshot } from "@/lib/personalFinance/contract";
import { FinanceEditor } from "./FinanceEditor";
import { PersonalFinanceError } from "@/lib/personalFinance/service";
import { Budgets } from "./FinanceViews";
const writer = vi.hoisted(() => ({
  isPending: false,
  prepare: vi.fn(),
  mutateAsync: vi.fn(),
}));
vi.mock("@/hooks/personal-finance/usePersonalFinance", () => ({
  usePersonalFinanceMutation: () => writer,
}));
afterEach(() => {
  writer.prepare.mockReset();
  writer.mutateAsync.mockReset();
});
afterEach(cleanup);
it("unknown update locks deletion and retries exactly the held update", async () => {
  const snapshot = {
    wallets: [],
    categories: [],
    transactions: [],
    transfers: [],
    budgets: [],
    goals: [],
  } as unknown as Snapshot;
  writer.prepare.mockImplementation((payload) => ({
    requestKey: "11111111-1111-4111-8111-111111111111",
    ownerId: "owner",
    payload,
  }));
  writer.mutateAsync
    .mockRejectedValueOnce(
      new PersonalFinanceError(
        "network",
        "Chưa xác nhận cập nhật",
        undefined,
        true,
      ),
    )
    .mockResolvedValueOnce({});
  render(
    <FinanceEditor
      embedded
      editor={{
        entity: "budget",
        record: {
          id: "22222222-2222-4222-8222-222222222222",
          version: 1,
          amount: 100,
          category_id: null,
        },
      }}
      snapshot={snapshot}
      permissions={{ create: true, edit: true, delete: true }}
      onClose={vi.fn()}
    />,
  );
  fireEvent.change(screen.getByLabelText("Hạn mức mỗi tháng"), {
    target: { value: "150" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Lưu thay đổi" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain(
      "Chưa xác nhận cập nhật",
    ),
  );
  expect(screen.getByRole("button", { name: "Xóa hạn mức" })).toHaveProperty(
    "disabled",
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "Xóa hạn mức" }));
  expect(screen.queryByRole("button", { name: "Xác nhận xóa" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Gửi lại y nguyên" }));
  await waitFor(() => expect(writer.mutateAsync).toHaveBeenCalledTimes(2));
  expect(writer.mutateAsync.mock.calls[1][0]).toBe(
    writer.mutateAsync.mock.calls[0][0],
  );
  expect(writer.mutateAsync.mock.calls[1][0].payload.action).toBe(
    "budget.update",
  );
});
it("delete-only users can open wallet and budget details with form editing disabled", () => {
  const wallet = {
    id: "wallet",
    name: "Ví phụ",
    icon: "👛",
    kind: "cash",
    hidden: false,
    balance: 0,
    opening_balance: 0,
  };
  const budget = {
    id: "budget",
    version: 1,
    amount: 100,
    category_id: "category",
  };
  const snapshot = {
    owner_id: "owner",
    schema_version: 1,
    wallets: [wallet],
    categories: [
      { id: "category", name: "Ăn uống", type: "EXPENSE", icon: "🍜" },
    ],
    transactions: [],
    transfers: [],
    budgets: [budget],
    goals: [],
  } as unknown as Snapshot;
  const edit = vi.fn(),
    permissions = { create: false, edit: false, delete: true };
  const { rerender } = render(
    <Management
      kind="wallet"
      snapshot={snapshot}
      permissions={permissions}
      edit={edit}
      onWallet={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Chi tiết ví Ví phụ" }));
  expect(edit).toHaveBeenCalledWith(
    expect.objectContaining({ entity: "wallet", record: wallet }),
  );
  rerender(
    <Budgets
      snapshot={snapshot}
      permissions={permissions}
      edit={edit}
      month="2026-10"
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Xem hạn mức Ăn uống" }));
  expect(edit).toHaveBeenCalledWith(
    expect.objectContaining({
      entity: "budget",
      record: expect.objectContaining({ id: "budget" }),
    }),
  );
  rerender(
    <FinanceEditor
      embedded
      editor={{ entity: "wallet", record: wallet }}
      snapshot={snapshot}
      permissions={permissions}
      onClose={vi.fn()}
    />,
  );
  expect(
    (screen.getByLabelText("Tên ví") as HTMLInputElement).closest("fieldset"),
  ).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "Xóa ví" })).toHaveProperty(
    "disabled",
    false,
  );
});
it("readonly category detail uses a view label and opens the record without an edit promise", () => {
  const edit = vi.fn();
  render(
    <Management
      kind="category"
      snapshot={
        {
          wallets: [],
          categories: [
            {
              id: "category",
              name: "Ăn uống",
              icon: "🍜",
              type: "EXPENSE",
              hidden: false,
            },
          ],
          transactions: [],
          transfers: [],
          budgets: [],
          goals: [],
        } as unknown as Snapshot
      }
      permissions={{ create: false, edit: false, delete: false }}
      edit={edit}
    />,
  );
  expect(
    screen.queryByRole("button", { name: "Sửa danh mục Ăn uống" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Xem danh mục Ăn uống" }));
  expect(edit).toHaveBeenCalledWith(
    expect.objectContaining({
      entity: "category",
      record: expect.objectContaining({ id: "category" }),
    }),
  );
});
it("monthly report insight computes real net and largest expense independently of chart direction", () => {
  const s = {
    owner_id: "owner",
    schema_version: 1,
    wallets: [],
    categories: [],
    transfers: [],
    budgets: [],
    goals: [],
    transactions: [
      ["EXPENSE", 20, "Nhỏ"],
      ["EXPENSE", 80, "Lớn"],
      ["INCOME", 150, "Lương"],
    ].map(([type, amount, category], i) => ({
      id: String(i),
      user_id: "owner",
      type,
      amount,
      txn_date: "2026-10-01",
      created_at: "2026-10-01T00:00:00Z",
      deleted_at: null,
      resolved_category_id: null,
      category,
    })),
  } as unknown as Snapshot;
  render(
    <Reports
      snapshot={s}
      month="2026-10"
      onMonth={vi.fn()}
      onDrill={vi.fn()}
    />,
  );
  expect(screen.getByTestId("monthly-insight").textContent).toContain(
    "còn 50 ₫",
  );
  expect(screen.getByTestId("monthly-insight").textContent).toContain("Lớn");
  fireEvent.click(screen.getByRole("button", { name: "Thu" }));
  expect(screen.getByTestId("monthly-insight").textContent).toContain("Lớn");
});
it("ledger summary and amount search follow the filtered rows with precise totals", () => {
  const s = {
    owner_id: "owner",
    schema_version: 1,
    wallets: [],
    categories: [],
    transfers: [],
    budgets: [],
    goals: [],
    transactions: [0.1, 0.2, 50].map((amount, i) => ({
      id: String(i),
      user_id: "owner",
      type: "EXPENSE",
      amount,
      txn_date: "2026-10-01",
      created_at: "2026-10-01T00:00:00Z",
      deleted_at: null,
      resolved_wallet_id: i < 2 ? "chosen" : "other",
      resolved_category_id: null,
      category: "legacy",
    })),
  } as unknown as Snapshot;
  const props = {
    snapshot: s,
    permissions: { create: false, edit: false, delete: false },
    edit: vi.fn(),
    month: "2026-10",
    onFilters: vi.fn(),
    manage: vi.fn(),
    categories: vi.fn(),
  };
  const { rerender } = render(
    <Ledger {...props} filters={{ ...emptyFilters, wallet: "chosen" }} />,
  );
  expect(screen.getByText("Thu 0 ₫ · Chi 0,3 ₫")).toBeTruthy();
  rerender(<Ledger {...props} filters={{ ...emptyFilters, search: "50" }} />);
  expect(screen.getByRole("button", { name: "Xem legacy" })).toBeTruthy();
  expect(screen.getByText("Thu 0 ₫ · Chi 50 ₫")).toBeTruthy();
});
it("reports a precise decimal total across independent category buckets", () => {
  const s = {
    owner_id: "owner",
    schema_version: 1,
    wallets: [],
    categories: [],
    transfers: [],
    budgets: [],
    goals: [],
    transactions: [0.1, 0.2].map((amount, i) => ({
      id: String(i),
      user_id: "owner",
      type: "EXPENSE",
      amount,
      txn_date: "2026-10-01",
      created_at: "2026-10-01T00:00:00Z",
      deleted_at: null,
      resolved_category_id: null,
      category: `legacy-${i}`,
    })),
  } as unknown as Snapshot;
  render(
    <Reports
      snapshot={s}
      month="2026-10"
      onMonth={vi.fn()}
      onDrill={vi.fn()}
    />,
  );
  expect(screen.getByRole("img", { name: "Chi 0,3 ₫" })).toBeTruthy();
  expect(screen.queryByText(/0,30000000000000004/)).toBeNull();
});
const snapshot = {
  transactions: [],
  transfers: [],
  goals: [],
  wallets: [],
  categories: [],
  budgets: [],
} as unknown as Snapshot;
it.each([
  [{ create: false, edit: false, delete: false }, 0, 0],
  [{ create: true, edit: false, delete: false }, 0, 0],
  [{ create: false, edit: true, delete: false }, 1, 0],
  [{ create: false, edit: false, delete: true }, 0, 1],
] as const)(
  "uses distinct edit and delete permissions %j",
  (permissions, editCount, deleteCount) => {
    render(
      <RowActions
        entity="transaction"
        row={{ id: "row", description: "Tiền ăn" }}
        snapshot={snapshot}
        permissions={permissions}
        edit={vi.fn()}
      />,
    );
    expect(
      screen.queryAllByRole("button", { name: "Sửa giao dịch Tiền ăn" }),
    ).toHaveLength(editCount);
    expect(
      screen.queryAllByRole("button", { name: "Xóa giao dịch Tiền ăn" }),
    ).toHaveLength(deleteCount);
  },
);
it("keeps goal contribution edits unavailable even for writers", () => {
  render(
    <RowActions
      entity="transfer"
      row={{ id: "row", goal_id: "goal" }}
      snapshot={snapshot}
      permissions={{ create: true, edit: true, delete: true }}
      edit={vi.fn()}
    />,
  );
  expect(screen.queryByRole("button", { name: /Sửa/ })).toBeNull();
  expect(screen.getByRole("button", { name: /Xóa/ }).title).toContain(
    "giữ nguyên",
  );
});
it("puts the personal wallet in the personal launcher section with its own view permission", () => {
  const tile = LAUNCHER_SECTIONS.find((s) => s.label === "Cá nhân")?.items.find(
    (t) => t.href === "/finance/personal-wallet",
  );
  expect(tile).toMatchObject({
    module: "personal_finance",
    action: "view",
    title: "Ví cá nhân",
  });
});
