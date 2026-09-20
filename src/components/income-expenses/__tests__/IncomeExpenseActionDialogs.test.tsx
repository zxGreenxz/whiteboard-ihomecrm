// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type PostingDialog from "../IncomeExpensePostingDialog";
import type { IncomeExpenseActionsController } from "@/hooks/income-expenses/useIncomeExpenseActions";
const m = vi.hoisted(() => ({
  posting: null as unknown,
  supplement: null as unknown,
  adopt: vi.fn(),
  attach: vi.fn(),
  remove: vi.fn(),
  upload: vi.fn(),
}));
vi.mock("@/hooks/useAccounts", () => ({ useAccounts: () => ({ data: [] }) }));
vi.mock("@/hooks/income-expenses/financeV2Mutations", () => ({
  adoptVoucherAttachmentsAsEvidence: m.adopt,
  useAttachPostingEvidence: () => m.attach,
  useRemovePostingAttachment: () => m.remove,
  uploadFinanceEvidence: m.upload,
}));
vi.mock("../IncomeExpensePostingDialog", () => ({
  default: (props: unknown) => {
    m.posting = props;
    return <div>posting host</div>;
  },
}));
vi.mock("../IncomeExpenseQuickEditDialog", () => ({
  default: (props: unknown) => {
    m.supplement = props;
    return <div>supplement host</div>;
  },
}));
vi.mock("../AttachmentUpload", () => ({ default: () => null }));
import { IncomeExpenseActionDialogs } from "../IncomeExpenseActionDialogs";
const posting = () => m.posting as ComponentProps<typeof PostingDialog>;
function controller(action: string): IncomeExpenseActionsController {
  return {
    selected: {
      id: "v",
      action,
      key: "stable-key",
      scope: { actorId: "actor", organizationId: "org" },
      snapshot: {
        id: "v",
        code: "PC-keep",
        name: "Phiếu hiện có",
        type: "EXPENSE",
        totalAmount: 2640000,
        approvalVersion: 0,
        postingVersion: 4,
        accountId: "book",
        attachments: ["original"],
        capabilities: { requiresRealAccount: false },
      },
    },
    selectedAvailability: {
      approveAndPost: { visible: false, enabled: false, reason: null },
      [action]: { visible: true, enabled: true, reason: null },
    },
    contexts: {},
    cashbooks: {
      state: "ready",
      value: [{ id: "book", name: "Sổ thật", isVirtual: false }],
    },
    outcome: { kind: "idle", message: null },
    busy: false,
    dismissalBlocked: false,
    retryable: false,
    close: vi.fn(),
    open: vi.fn(),
    commands: {
      confirm: vi.fn().mockResolvedValue(undefined),
      reconcile: vi.fn(),
      retry: vi.fn(),
    },
  } as unknown as IncomeExpenseActionsController;
}
beforeEach(() => {
  vi.clearAllMocks();
  m.adopt.mockResolvedValue([]);
  m.attach.mockResolvedValue({ evidenceId: "evidence", url: "url" });
  m.remove.mockResolvedValue(undefined);
  m.upload.mockResolvedValue("evidence");
});
afterEach(cleanup);
it("wires the complete voucher posting contract and all four evidence callbacks", async () => {
  const c = controller("post");
  render(<IncomeExpenseActionDialogs controller={c} />);
  expect(posting()).toMatchObject({
    mode: "POST_APPROVED",
    expectedExecutionRevision: 0,
    expectedApprovalVersion: 0,
    expectedPostingVersion: 4,
    idempotencyKey: "stable-key",
    voucher: { subjectKind: "VOUCHER", subjectId: "v", approvedTotal: 2640000 },
  });
  const file = new File(["image"], "proof.png", { type: "image/png" });
  await act(async () => {
    await posting().onAdoptAttachments!("v");
    await posting().onAttachEvidence!(file);
    await posting().onRemoveAttachment!("url");
    await posting().onUploadEvidence!(file);
  });
  expect(m.adopt).toHaveBeenCalledExactlyOnceWith("v");
  expect(m.attach).toHaveBeenCalledExactlyOnceWith(file, {
    voucherId: "v",
    userId: "actor",
    organizationId: "org",
  });
  expect(m.remove).toHaveBeenCalledExactlyOnceWith("v", "url");
  expect(m.upload).toHaveBeenCalledExactlyOnceWith(file, "org");
});
it("keeps dismissal blocked through evidence upload without treating close as success", async () => {
  let finish!: () => void;
  m.upload.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const c = controller("post");
  render(<IncomeExpenseActionDialogs controller={c} />);
  let pending!: Promise<unknown>;
  act(() => {
    pending = posting().onUploadEvidence!(new File(["x"], "proof.png"));
    posting().onOpenChange(false);
  });
  expect(c.close).not.toHaveBeenCalled();
  expect(c.commands.confirm).not.toHaveBeenCalled();
  await act(async () => {
    finish();
    await pending;
  });
  act(() => posting().onOpenChange(false));
  expect(c.close).toHaveBeenCalledTimes(1);
});
it("requires a reason for request changes and passes only that draft to the controller", () => {
  const c = controller("requestChanges");
  render(<IncomeExpenseActionDialogs controller={c} />);
  const button = screen.getByRole("button", {
    name: "Yêu cầu rà soát",
  }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Lý do"), {
    target: { value: "Kiểm tra chứng từ" },
  });
  fireEvent.click(button);
  expect(c.commands.confirm).toHaveBeenCalledExactlyOnceWith({
    reason: "Kiểm tra chứng từ",
  });
});
it("resubmits the existing voucher with no money or source field in the command", () => {
  const c = controller("resubmitReview");
  render(<IncomeExpenseActionDialogs controller={c} />);
  expect(
    screen.getByText(/Giữ nguyên mã, số tiền và nguồn phiếu/),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Chuyển chờ duyệt" }));
  expect(c.commands.confirm).toHaveBeenCalledExactlyOnceWith({ reason: "" });
});
it("keeps processed refresh failures distinct and offers reconciliation without another write", () => {
  const c = controller("approveOnly");
  c.dismissalBlocked = true;
  c.outcome = {
    kind: "processed-refresh-failed",
    message: "Đã xử lý, chưa tải lại được",
  };
  render(<IncomeExpenseActionDialogs controller={c} />);
  expect(
    (screen.getByRole("button", { name: "Chỉ duyệt" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Tải lại để đối chiếu" }));
  expect(c.commands.reconcile).toHaveBeenCalledTimes(1);
  expect(c.commands.confirm).not.toHaveBeenCalled();
});
