// @vitest-environment jsdom
// Hộp "Xác nhận duyệt phiếu" của Thu chi với phiếu chi theo SỔ TỔNG (chi lợi nhuận / tạm ứng / lương điều hành).
// Chủ chốt 25/11/2026: duyệt MỘT đường ở Thu chi, bỏ màn Chờ duyệt — nên việc màn đó từng làm phải có ở đây:
// người duyệt thấy số dư sổ tổng lúc lập / bây giờ, và nút duyệt khoá khi biết trước máy chủ từ chối.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoucherActions } from "@/hooks/income-expenses/useVoucherActions";

const e7 = vi.hoisted(() => ({
  state: { data: undefined as unknown, isPending: false, isError: false, error: null as unknown, refetch: () => {} },
  ids: [] as Array<string | null | undefined>,
}));
vi.mock("@/hooks/profit-ledger/useProfitLedgerQueries", () => ({
  useProfitLedgerPayoutDetail: (id: string | null | undefined) => { e7.ids.push(id); return e7.state; },
}));
// Các hộp khác của bộ thao tác không thuộc bài này — thay bằng rỗng để không kéo request / provider.
vi.mock("@/components/income-expenses/IncomeExpenseForm", () => ({ default: () => null }));
vi.mock("@/components/income-expenses/IncomeExpenseQuickEditDialog", () => ({ default: () => null }));
vi.mock("@/components/income-expenses/IncomeExpenseVerifyDialog", () => ({ default: () => null }));
vi.mock("@/components/income-expenses/IncomeExpensePostingDialog", () => ({ default: () => null }));
vi.mock("@/components/income-expenses/VoucherHistoryDialog", () => ({ default: () => null }));
vi.mock("@/components/income-expenses/AttachmentUpload", () => ({ default: () => null }));
vi.mock("@/components/income-expenses/RevisionSummary", () => ({ RevisionComparison: () => null }));
vi.mock("@/components/shareholders/ProfitPayoutCancelDialog", () => ({ ProfitPayoutCancelDialog: () => null }));

import { VoucherActionDialogs } from "../VoucherActionDialogs";

const detail = (p: { route?: string; makerKind?: string } = {}) => ({
  organization_id: "org-1",
  route: p.route ?? "CANONICAL",
  voucher: {
    id: "v-1", code: "PC-9", voucher_date: "2026-11-20", amount: 300, approval_status: "UNAPPROVED", posting_status: "UNPOSTED",
    system_source: "profit.ledger_payout", account_id: "acc-1", account_name: "Quỹ tiền mặt", is_live: true,
    created_at: "2026-11-20T09:29:00Z",
  },
  subject: { kind: "SHAREHOLDER", id: "sh-1", name: "Cổ đông mẫu", is_deleted: false, has_login: true },
  at_create: {
    balance_before: 1000, within: 0, advance: 300, warnings: [], maker_kind: p.makerKind ?? "CUSTODIAN_FOR_PAYEE",
    payout_kind: "ADVANCE", payee_is_maker: false,
  },
  now: { balance_excluding_this: 1000, within: 0, advance: 300 },
});

const voucher = (p: Record<string, unknown> = {}) => ({
  id: "v-1", type: "EXPENSE", name: "Cổ đông mẫu · ứng lợi nhuận", total_amount: 300, account_id: "acc-1",
  approval_status: "UNAPPROVED", posting_status: "UNPOSTED", posting_mode: "CASHBOOK", approval_version: 3, posting_version: 1,
  organization_id: "org-1", system_source: "profit.ledger_payout", attachments: [], user_id: "u-chu", ...p,
});

type Ledger = VoucherActions["dialogs"]["approve"]["ledger"];
const spies = { confirm: vi.fn(), openApproveAndPost: vi.fn() };

/** Bộ thao tác tối thiểu: chỉ hộp Duyệt đang mở, mọi hộp khác đóng. */
function actions(target: ReturnType<typeof voucher>, ledger: Ledger): VoucherActions {
  const closed = { target: null, close: vi.fn(), confirm: vi.fn(), pending: false, reason: "", setReason: vi.fn() };
  const dialogs = {
    authUserId: "u-xem", actionError: null, reasonError: null, setReasonError: vi.fn(), blockedVoucherId: null,
    editingVoucher: null, closeEdit: vi.fn(), copyVoucher: null, closeCopy: vi.fn(), quickEditVoucher: null, closeQuickEdit: vi.fn(),
    verifyVoucher: null, closeVerify: vi.fn(), historyVoucher: null, closeHistory: vi.fn(),
    cancel: { ...closed, posted: false, isIncome: false, gate: { canCancel: true, reason: null, mode: null } },
    profitCancel: { target: null, close: vi.fn(), onCancelled: vi.fn() },
    restore: { ...closed, needsReason: false },
    unapprove: { ...closed, needsReason: false },
    approve: {
      target, close: vi.fn(), confirm: spies.confirm, openApproveAndPost: spies.openApproveAndPost,
      v2ApproveOnly: true, v2ApproveAndPost: true, selfGate: { blocked: false, message: null }, selfChecking: false,
      historyBlocked: false, accounts: [], isShareholderPayout: false, accountId: "acc-1", setAccountId: vi.fn(),
      attachments: [], setAttachments: vi.fn(), needsReason: false, reason: "", setReason: vi.fn(), pending: false, ledger,
    },
    approveAndPost: { open: false, setOpen: vi.fn(), cashbookOptions: [], cashbookLocked: ledger.isLedger, submit: vi.fn(), pending: false },
    postApproved: { target: null, close: vi.fn(), cashbookOptions: [], cashbookLocked: false, submit: vi.fn(), pending: false },
    reverse: closed,
    cancelBatch: closed,
    posting: { custodianBooks: [], cashbookError: false, retryCashbooks: vi.fn(), attachPostingEvidence: vi.fn(), removePostingAttachment: vi.fn() },
  };
  return { dialogs } as unknown as VoucherActions;
}

const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

beforeEach(() => {
  e7.state = { data: detail(), isPending: false, isError: false, error: null, refetch: () => {} };
  e7.ids = [];
  spies.confirm.mockReset();
  spies.openApproveAndPost.mockReset();
});
afterEach(cleanup);

describe("hộp Duyệt của Thu chi — phiếu chi theo sổ tổng", () => {
  it("hiện thẻ số dư sổ tổng (lúc lập / bây giờ) ngay trong hộp; không khoá ⇒ Chỉ duyệt và Duyệt và Chi… bấm được", () => {
    render(<VoucherActionDialogs actions={actions(voucher(), { isLedger: true, blocked: false, viewerReason: null })} />);
    const note = screen.getByTestId("ledger-approval-note");
    expect(note.textContent).toContain("Tạm ứng lợi nhuận · Cổ đông mẫu");
    expect(note.textContent).toMatch(/Lúc lập: .*tạm ứng 300/);
    expect(note.textContent).toMatch(/Bây giờ \(không tính phiếu này\)/);
    expect(note.textContent).toContain("Chỉ chi được từ sổ đã chọn lúc lập: Quỹ tiền mặt.");
    expect(e7.ids).toContain("v-1");
    expect(screen.queryByText(/^Không duyệt được:/)).toBeNull();
    fireEvent.click(button("Chỉ duyệt"));
    expect(spies.confirm).toHaveBeenCalledTimes(1);
    fireEvent.click(button("Duyệt và Chi…"));
    expect(spies.openApproveAndPost).toHaveBeenCalledTimes(1);
  });

  it("người xem không duyệt được (vd người lập phiếu tạm ứng) ⇒ nói rõ lý do, khoá cả hai nút duyệt", () => {
    const reason = "Phiếu tạm ứng do chính bạn lập — người lập không tự duyệt được, cần một người khác có quyền chi lợi nhuận duyệt.";
    render(<VoucherActionDialogs actions={actions(voucher(), { isLedger: true, blocked: true, viewerReason: reason })} />);
    expect(screen.getByRole("note").textContent).toBe(`Không duyệt được: ${reason}`);
    expect(button("Chỉ duyệt").disabled).toBe(true);
    expect(button("Duyệt và Chi…").disabled).toBe(true);
    expect(button("Chỉ duyệt").getAttribute("aria-describedby")).toBe("ie-ledger-approve-note");
    fireEvent.click(button("Chỉ duyệt"));
    expect(spies.confirm).not.toHaveBeenCalled();
    // Thẻ số dư vẫn hiện để người xem biết phiếu đang ở đâu.
    expect(screen.getByTestId("ledger-approval-note")).toBeTruthy();
  });

  it("sổ tổng đóng băng ⇒ thẻ số dư tự nói lý do; hộp khoá duyệt (không cần câu \"Không duyệt được\" của người xem)", () => {
    e7.state = { ...e7.state, data: detail({ route: "FROZEN" }) };
    render(<VoucherActionDialogs actions={actions(voucher(), { isLedger: true, blocked: true, viewerReason: null })} />);
    expect(screen.getByTestId("ledger-approval-block").textContent).toMatch(/Sổ tổng đang đóng băng.*\(vẫn huỷ được\)/);
    expect(screen.queryByText(/^Không duyệt được:/)).toBeNull();
    expect(button("Chỉ duyệt").disabled).toBe(true);
    expect(button("Duyệt và Chi…").disabled).toBe(true);
  });

  it("chưa tải được số dư sổ tổng ⇒ báo tại chỗ kèm Thử lại, không che bằng số 0", () => {
    e7.state = { ...e7.state, data: undefined, isError: true, error: new Error("mất mạng") };
    render(<VoucherActionDialogs actions={actions(voucher(), { isLedger: true, blocked: true, viewerReason: null })} />);
    const note = screen.getByTestId("ledger-approval-note");
    expect(note.getAttribute("role")).toBe("alert");
    expect(note.textContent).toContain("Chưa duyệt được phiếu này khi chưa thấy số dư sổ tổng.");
    expect(screen.getByRole("button", { name: "Thử lại" })).toBeTruthy();
    expect(button("Chỉ duyệt").disabled).toBe(true);
  });

  it("phiếu thường: không có thẻ sổ tổng, không đọc E7, duyệt như cũ", () => {
    const thuong = voucher({ system_source: null, name: "Chi sửa điện" });
    render(<VoucherActionDialogs actions={actions(thuong, { isLedger: false, blocked: false, viewerReason: null })} />);
    expect(screen.queryByTestId("ledger-approval-note")).toBeNull();
    expect(e7.ids).toEqual([]);
    fireEvent.click(button("Chỉ duyệt"));
    expect(spies.confirm).toHaveBeenCalledTimes(1);
  });
});
