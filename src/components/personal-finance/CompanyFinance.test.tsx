// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import CompanyFinance from "./CompanyFinance";

const state = vi.hoisted(() => ({
  snapshot: { owner_id: "owner", organization_id: "org", schema_version: 1, wallets: [] as Array<Record<string, unknown>>, transactions: [] as Array<Record<string, unknown>> },
  permissions: { __superadmin: true } as Record<string, unknown>,
  error: null as Error | null,
  accountsError: null as Error | null,
  mutateAsync: vi.fn(),
  refetch: vi.fn(),
  accounts: [
    { id: "cashbook", name: "Quỹ đang liên kết", organization_id: "org", is_virtual: false },
    { id: "available", name: "Ngân hàng công ty", organization_id: "org", is_virtual: false },
    { id: "other-org", name: "Quỹ công ty khác", organization_id: "elsewhere", is_virtual: false },
    { id: "virtual", name: "Quỹ kỹ thuật", organization_id: "org", is_virtual: true },
  ],
}));
vi.mock("@/contexts/OrganizationContext", () => ({ useOrganization: () => ({ selectedOrganizationId: "org", organization: { name: "Công ty mẫu" } }) }));
vi.mock("@/hooks/useMyPermissions", () => ({ useMyPermissions: () => ({ data: state.permissions, refetch: state.refetch }) }));
vi.mock("@/hooks/useAccounts", () => ({ useAccounts: () => ({ data: state.accounts, error: state.accountsError, refetch: state.refetch }) }));
vi.mock("@/hooks/income-expenses/financeV2Mutations", () => ({ useCustodianCashbooksV2: () => ({ data: state.accounts, refetch: state.refetch }) }));
vi.mock("@/hooks/company-wallet/useCompanyWallets", () => ({
  useCompanyWallets: () => ({ data: state.snapshot, error: state.error, refetch: state.refetch }),
  useCompanyWalletMutation: () => ({ mutateAsync: state.mutateAsync, isPending: false }),
}));
vi.mock("@/components/income-expenses/IncomeExpenseDetailDialog", () => ({ IncomeExpenseDetailDialog: ({ voucherId, onOpenChange }: { voucherId: string; onOpenChange: (open: boolean) => void }) => <div>Chi tiết {voucherId}<button onClick={() => onOpenChange(false)}>Đóng chi tiết phiếu</button></div> }));
function wallet(overrides: Record<string, unknown> = {}) { return { id: "wallet", user_id: "owner", organization_id: "org", name: "Ví công ty", icon: "🏦", kind: "bank", account_id: "cashbook", account_name: "Quỹ đang liên kết", is_preferred: false, hidden: false, version: 1, balance: 900000, balance_visible: true, can_use: true, ...overrides }; }
function transaction(id: string, overrides: Record<string, unknown> = {}) { return { id, wallet_id: "wallet", user_id: "owner", organization_id: "org", type: "EXPENSE", name: `Khoản ${id}`, total_amount: 100000, voucher_date: "2026-10-08", approval_status: "APPROVED", posting_status: "POSTED", review_state: "RESOLVED", attachments: [], created_at: "2026-10-08T00:00:00Z", deleted_at: null, code: id, ...overrides }; }
const props = { month: "2026-10", onMonth: vi.fn() };
beforeEach(() => {
  state.snapshot = { owner_id: "owner", organization_id: "org", schema_version: 1, wallets: [wallet()], transactions: [] };
  state.permissions = { __superadmin: true }; state.error = null; state.accountsError = null;
  state.mutateAsync.mockReset().mockResolvedValue({}); state.refetch.mockReset();
});
afterEach(cleanup);

it("sums only posted origin rows belonging to the actor and active organization", () => {
  state.snapshot.transactions = [
    transaction("posted"), transaction("pending", { approval_status: "UNAPPROVED", posting_status: "UNPOSTED" }),
    transaction("cancelled", { approval_status: "CANCELLED" }), transaction("reversed", { posting_status: "REVERSED" }),
    transaction("foreign", { organization_id: "elsewhere" }), transaction("another-actor", { user_id: "someone-else" }),
  ];
  render(<CompanyFinance {...props} view="ledger" />);
  expect(screen.getByTestId("company-month-totals").textContent).toBe("Đã thu 0 ₫ · Đã chi 100.000 ₫");
  expect(screen.getByText("4 phiếu công ty")).toBeTruthy();
  expect(screen.queryByText("Khoản foreign")).toBeNull();
  expect(screen.queryByText("Khoản another-actor")).toBeNull();
  fireEvent.change(screen.getByLabelText("Trạng thái phiếu"), { target: { value: "pending" } });
  expect(screen.getByText("Khoản pending")).toBeTruthy();
  expect(screen.queryByText("Khoản posted")).toBeNull();
  expect(screen.getByTestId("company-month-totals").textContent).toBe("Đã thu 0 ₫ · Đã chi 0 ₫");
});

it("does not replace inaccessible linked balances with zero or a partial total", () => {
  state.snapshot.wallets.push(wallet({ id: "hidden-balance", name: "Ví hạn chế", balance: null, balance_visible: false }));
  render(<CompanyFinance {...props} view="overview" />);
  expect(screen.getByTestId("company-total-balance").textContent).toBe("Chưa đủ quyền xem");
  expect(screen.getByText("Không có quyền xem")).toBeTruthy();
  expect(screen.getByText("900.000 ₫")).toBeTruthy();
});

it("filters by date and text, opens evidence detail and refreshes changed company money when closed", async () => {
  state.snapshot.transactions = [transaction("first", { voucher_date: "2026-10-02" }), transaction("bill", { attachments: ["https://example.test/bill.jpg"], name: "Bill tiền điện" })];
  const view = render(<CompanyFinance {...props} view="ledger" />);
  fireEvent.change(screen.getByLabelText("Từ ngày"), { target: { value: "2026-10-05" } });
  expect(screen.queryByText("Khoản first")).toBeNull();
  expect(screen.getByText(/1 chứng từ/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Xem phiếu bill" }));
  expect(await screen.findByText("Chi tiết bill")).toBeTruthy();
  expect(state.refetch).not.toHaveBeenCalled();
  state.refetch.mockImplementationOnce(() => {
    state.snapshot.transactions = state.snapshot.transactions.map(row => row.id === "bill" ? { ...row, posting_status: "REVERSED" } : row);
    state.snapshot.wallets = [wallet({ balance: 1000000 })];
  });
  fireEvent.click(screen.getByRole("button", { name: "Đóng chi tiết phiếu" }));
  expect(state.refetch).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("Chi tiết bill")).toBeNull();
  expect(screen.getByText(/Đã hoàn tác/, { selector: "small" })).toBeTruthy();
  expect(screen.getByTestId("company-month-totals").textContent).toBe("Đã thu 0 ₫ · Đã chi 0 ₫");
  view.rerender(<CompanyFinance {...props} view="overview" />);
  expect(screen.getByTestId("company-total-balance").textContent).toBe("1.000.000 ₫");
  view.rerender(<CompanyFinance {...props} view="ledger" search="không tồn tại" />);
  expect(screen.getByText("Chưa có phiếu công ty phù hợp.")).toBeTruthy();
});

it("shows no settings mutation or company voucher detail action without permission", () => {
  state.permissions = {};
  const view = render(<CompanyFinance {...props} view="settings" onCreateCashbook={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "Thêm ví công ty" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Tạo sổ quỹ mới" })).toBeNull();
  state.snapshot.transactions = [transaction("read")];
  view.rerender(<CompanyFinance {...props} view="ledger" />);
  expect(screen.getByText("Khoản read")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Xem phiếu read" })).toBeNull();
});

it("creates a preferred SP wallet using only an unlinked real cashbook from this company", async () => {
  render(<CompanyFinance {...props} view="settings" />);
  fireEvent.click(screen.getByRole("button", { name: "Thêm ví công ty" }));
  const account = screen.getByLabelText("Sổ quỹ liên kết");
  expect(Array.from((account as HTMLSelectElement).options).map(option => option.value)).toEqual(["", "available"]);
  fireEvent.change(screen.getByLabelText("Tên ví công ty"), { target: { value: "Thẻ SP công ty" } });
  fireEvent.change(screen.getByLabelText("Loại ví công ty"), { target: { value: "sp_card" } });
  fireEvent.click(screen.getByRole("button", { name: "Biểu tượng 💳" }));
  expect(screen.getByRole("button", { name: "Biểu tượng 💳" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.change(account, { target: { value: "available" } });
  fireEvent.click(screen.getByLabelText("Ưu tiên ví này khi nhận diện cùng loại thanh toán"));
  fireEvent.click(screen.getByRole("button", { name: "Lưu ví công ty" }));
  await waitFor(() => expect(state.mutateAsync).toHaveBeenCalledTimes(1));
  expect(state.mutateAsync.mock.calls[0][0]).toMatchObject({ action: "create", data: { name: "Thẻ SP công ty", kind: "sp_card", icon: "💳", account_id: "available", is_preferred: true } });
});

it("locks an uncertain settings mutation and replays exactly the same request", async () => {
  state.mutateAsync.mockRejectedValueOnce(Object.assign(new Error("Chưa xác nhận kết quả"), { outcomeUnknown: true })).mockResolvedValueOnce({});
  render(<CompanyFinance {...props} view="settings" />);
  fireEvent.click(screen.getByRole("button", { name: "Sửa ví công ty Ví công ty" }));
  fireEvent.change(screen.getByLabelText("Tên ví công ty"), { target: { value: "Tên mới" } });
  fireEvent.click(screen.getByRole("button", { name: "Lưu ví công ty" }));
  await screen.findByText("Chưa xác nhận kết quả");
  expect(screen.getByRole("button", { name: "Xóa ví công ty" })).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "Quay lại" })).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: "Gửi lại y nguyên" }));
  await waitFor(() => expect(state.mutateAsync).toHaveBeenCalledTimes(2));
  expect(state.mutateAsync.mock.calls[1][0]).toBe(state.mutateAsync.mock.calls[0][0]);
});

it("reports a cashbook read failure instead of treating it as an empty usable list", () => {
  state.accountsError = new Error("network");
  render(<CompanyFinance {...props} view="settings" />);
  fireEvent.click(screen.getByRole("button", { name: "Thêm ví công ty" }));
  expect(screen.getByRole("alert").textContent).toContain("Chưa tải được sổ quỹ");
  expect(screen.getByRole("button", { name: "Lưu ví công ty" })).toHaveProperty("disabled", true);
});
