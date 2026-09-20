// @vitest-environment jsdom
import { act, renderHook, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
const m = vi.hoisted(() => ({
  approve: vi.fn(),
  legacy: vi.fn(),
  unapprove: vi.fn(),
  post: vi.fn(),
  atomic: vi.fn(),
  reverse: vi.fn(),
  cancel: vi.fn(),
  flex: vi.fn(),
  income: vi.fn(),
  review: vi.fn(),
  resubmit: vi.fn(),
  supplement: vi.fn(),
  quick: vi.fn(),
  bookRefresh: vi.fn(),
  cancelRead: vi.fn(),
  refresh: vi.fn(),
  read: vi.fn(),
  invalidate: vi.fn(),
  batch: null as unknown,
  books: [] as unknown[],
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: m.invalidate }),
}));
vi.mock("./useIncomeExpenseActionSnapshots", () => ({
  useIncomeExpenseActionSnapshots: () => ({
    readiness: { state: "ready", value: m.batch },
    refresh: m.refresh,
  }),
  readIncomeExpenseActionSnapshotPage: m.read,
}));
vi.mock("./usePostingCashbooks", () => ({
  usePostingCashbooks: () => ({
    readiness: { state: "ready", value: m.books },
    refresh: m.bookRefresh,
  }),
}));
vi.mock("./useIncomeExpenseCancellation", () => ({
  useIncomeExpenseCancellation: () => ({
    readiness: { state: "ready", value: { income: {}, flex: {} } },
    refresh: async () => ({ income: {}, flex: {} }),
  }),
  readIncomeExpenseCancellation: m.cancelRead,
}));
vi.mock("./financeV2Mutations", () => ({
  useApproveIncomeExpenseV2: () => ({ mutateAsync: m.approve }),
  usePostApprovedIncomeExpenseV2: () => ({ mutateAsync: m.post }),
  useApproveAndPostIncomeExpenseV2: () => ({ mutateAsync: m.atomic }),
  useReversePostingV2: () => ({ mutateAsync: m.reverse }),
}));
vi.mock("./statusMutations", () => ({
  useApproveVoucher: () => ({ mutateAsync: m.legacy }),
  useUnapproveVoucher: () => ({ mutateAsync: m.unapprove }),
  useCancelIncomeExpense: () => ({ mutateAsync: m.cancel }),
}));
vi.mock("./flexMutations", () => ({
  useCancelVoucherFlex: () => ({ mutateAsync: m.flex }),
}));
vi.mock("./incomeVoucherCancel", () => ({
  useCancelIncomeVoucher: () => ({ mutateAsync: m.income }),
}));
vi.mock("./reviewMutations", () => ({
  useRequestIncomeExpenseChanges: () => ({ mutateAsync: m.review }),
  useResubmitIncomeExpenseReview: () => ({ mutateAsync: m.resubmit }),
}));
vi.mock("./supplements", () => ({
  useAppendIncomeExpenseSupplement: () => ({ mutateAsync: m.supplement }),
}));
vi.mock("./mutations", () => ({
  useQuickUpdateIncomeExpense: () => ({ mutateAsync: m.quick }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { useIncomeExpenseActions } from "./useIncomeExpenseActions";
import type {
  ActionSnapshotBatch,
  IncomeExpenseActionSnapshot,
} from "@/lib/incomeExpenseActionSnapshot";
const id = "10000000-0000-4000-8000-000000000001",
  actor = "20000000-0000-4000-8000-000000000001",
  org = "30000000-0000-4000-8000-000000000001";
let row: IncomeExpenseActionSnapshot, batch: ActionSnapshotBatch;
const scope = { actorId: actor, organizationId: org };
beforeEach(() => {
  vi.clearAllMocks();
  row = {
    id,
    organizationId: org,
    buildingId: id,
    type: "EXPENSE",
    userId: actor,
    makerUserId: actor,
    approvalStatus: "UNAPPROVED",
    postingStatus: "UNPOSTED",
    postingMode: "CASHBOOK",
    reviewState: "PENDING",
    activePostingId: null,
    accountId: null,
    approvalVersion: 3,
    postingVersion: 4,
    reviewVersion: 5,
    code: "PC-original",
    name: "Phiếu",
    totalAmount: 2640000,
    roomId: null,
    contractId: null,
    tenantId: null,
    payerName: null,
    receiveBankName: null,
    receiveBankAccount: null,
    notes: null,
    attachments: [],
    voucherDate: "2026-09-21",
    reviewReason: null,
    systemSource: "contract.commission",
    flowKind: "CANONICAL_INCOME_EXPENSE",
    birthState: "COMMITTED",
    capabilities: {
      forfeitPair: false,
      forfeitAllowed: false,
      engineBlocked: false,
      manual: false,
      legacyCancelAllowed: true,
      compatCancelOwner: true,
      birthPrior: true,
      requiresRealAccount: false,
      reservationMoneyBlocked: false,
      reservationRefundReverseAllowed: false,
    },
    permissions: { approve: true, edit: true, cancel: true, reverse: true },
  };
  batch = {
    ...scope,
    isAdmin: true,
    authorizationVersion: 1,
    routes: {
      readSemantics: "CANONICAL",
      workflow: "CANONICAL",
      posting: "CANONICAL",
      access: "CANONICAL",
      accountingStandardStrict: false,
    },
    rows: { [id]: row },
    unavailable: {},
  };
  m.batch = batch;
  m.books = [];
  m.bookRefresh.mockImplementation(async () => m.books);
  m.cancelRead.mockResolvedValue({ income: {}, flex: {} });
  m.read.mockImplementation(async () => ({ ...batch, rows: [row] }));
  m.refresh.mockImplementation(async () => batch);
  m.invalidate.mockResolvedValue(undefined);
  m.approve.mockResolvedValue({});
  m.resubmit.mockResolvedValue({});
});
afterEach(cleanup);
function setup() {
  return renderHook(() => useIncomeExpenseActions({ scope, voucherIds: [id] }));
}
async function open(
  h: ReturnType<typeof setup>,
  action: Parameters<ReturnType<typeof useIncomeExpenseActions>["open"]>[0],
) {
  act(() => {
    h.result.current.open(action, id);
  });
  await waitFor(() => expect(h.result.current.selected?.snapshot).toBeTruthy());
}
describe("shared controller executes reviewed snapshots", () => {
  it("pins canonical CAS/key and keeps busy through refresh, synchronously rejects double submit", async () => {
    let resolve!: () => void;
    m.invalidate.mockImplementation(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    const h = setup();
    await open(h, "approveOnly");
    let first!: Promise<void>;
    act(() => {
      first = h.result.current.commands.confirm();
      void h.result.current.commands.confirm().catch(() => {});
    });
    await waitFor(() => expect(m.approve).toHaveBeenCalledTimes(1));
    expect(m.approve).toHaveBeenCalledWith(
      expect.objectContaining({
        voucherId: id,
        expectedApprovalVersion: 3,
        idempotencyKey: expect.any(String),
      }),
    );
    expect(h.result.current.busy).toBe(true);
    // All invalidations share this test promise; finish them together below.
    m.invalidate.mockReset();
    m.invalidate.mockResolvedValue(undefined);
    // use a single invalidation promise in this fixture (controller batches namespaces).
    await act(async () => {
      resolve();
      await first;
    });
    expect(h.result.current.busy).toBe(false);
  });
  it("returns changes requested to pending on same ID with no create/approve/post", async () => {
    row.reviewState = "CHANGES_REQUESTED";
    const h = setup();
    await open(h, "resubmitReview");
    await act(async () => {
      await h.result.current.commands.confirm();
    });
    expect(m.resubmit).toHaveBeenCalledWith({
      voucherId: id,
      expectedReviewVersion: 5,
      idempotencyKey: expect.any(String),
    });
    expect(m.approve).not.toHaveBeenCalled();
    expect(m.post).not.toHaveBeenCalled();
    expect(m.legacy).not.toHaveBeenCalled();
  });
  it("rejects same-ID version drift without substituting latest CAS", async () => {
    const h = setup();
    await open(h, "approveOnly");
    m.read.mockResolvedValue({
      ...batch,
      rows: [{ ...row, approvalVersion: 4 }],
    });
    await act(async () => {
      await expect(h.result.current.commands.confirm()).rejects.toThrow();
    });
    expect(m.approve).not.toHaveBeenCalled();
  });
  it("marks write-success refresh-failure as processed and blocks dismissal", async () => {
    const h = setup();
    await open(h, "approveOnly");
    m.invalidate.mockRejectedValue(new Error("refresh failed"));
    await act(async () => {
      await expect(h.result.current.commands.confirm()).rejects.toThrow();
    });
    expect(h.result.current.outcome.kind).toBe("processed-refresh-failed");
    act(() => h.result.current.close());
    expect(h.result.current.selected).not.toBeNull();
  });
  it("uses explicit legacy command without canonical-error fallback", async () => {
    batch.routes.workflow = "LEGACY";
    batch.routes.posting = "LEGACY";
    row.flowKind = null;
    row.capabilities.manual = true;
    const h = setup();
    await open(h, "legacyApprove");
    await act(async () => {
      await h.result.current.commands.confirm();
    });
    expect(m.legacy).toHaveBeenCalledWith(id);
    expect(m.approve).not.toHaveBeenCalled();
  });
  it("does not write after canonical route changed to legacy", async () => {
    const h = setup();
    await open(h, "approveOnly");
    m.read.mockResolvedValue({
      ...batch,
      routes: { ...batch.routes, workflow: "LEGACY" },
      rows: [row],
    });
    await act(async () => {
      await expect(h.result.current.commands.confirm()).rejects.toThrow();
    });
    expect(m.approve).not.toHaveBeenCalled();
    expect(m.legacy).not.toHaveBeenCalled();
  });
});

describe("command uncertainty and independent readiness", () => {
  it("does not make review depend on custody or cancellation transport", async () => {
    row.reviewState = "CHANGES_REQUESTED";
    m.bookRefresh.mockRejectedValue(new Error("books unavailable"));
    m.cancelRead.mockRejectedValue(new Error("cancel unavailable"));
    const h = setup();
    await open(h, "resubmitReview");
    await act(async () => {
      await h.result.current.commands.confirm().catch(() => {});
    });
    expect(m.resubmit).toHaveBeenCalledTimes(1);
  });
  it("retains an unknown request key and exact payload on explicit retry", async () => {
    m.review
      .mockRejectedValueOnce(new TypeError("network timeout"))
      .mockResolvedValueOnce({});
    const h = setup();
    await open(h, "requestChanges");
    await act(async () => {
      await expect(
        h.result.current.commands.confirm({ reason: "Cần kiểm tra ảnh" }),
      ).rejects.toThrow();
    });
    expect(h.result.current.outcome.kind).toBe("unknown");
    const first = m.review.mock.calls[0][0];
    act(() => h.result.current.close());
    expect(h.result.current.selected).not.toBeNull();
    await act(async () => {
      await h.result.current.commands.retry();
    });
    expect(m.review.mock.calls[1][0]).toEqual(first);
  });
  it("unknown replay remains blocked when permission was revoked", async () => {
    m.approve.mockRejectedValueOnce(new TypeError("network timeout"));
    const h = setup();
    await open(h, "approveOnly");
    await act(async () => {
      await h.result.current.commands.confirm().catch(() => {});
    });
    m.read.mockResolvedValue({
      ...batch,
      rows: [{ ...row, permissions: { ...row.permissions, approve: false } }],
    });
    await act(async () => {
      await h.result.current.commands.retry().catch(() => {});
    });
    expect(m.approve).toHaveBeenCalledTimes(1);
    expect(h.result.current.outcome.kind).toBe("unknown");
  });
  it("never blindly retries a keyless legacy request", async () => {
    batch.routes.workflow = "LEGACY";
    batch.routes.posting = "LEGACY";
    row.flowKind = null;
    m.legacy.mockRejectedValueOnce(new TypeError("timeout"));
    const h = setup();
    await open(h, "legacyApprove");
    await act(async () => {
      await h.result.current.commands.confirm().catch(() => {});
    });
    expect(h.result.current.retryable).toBe(false);
    await expect(h.result.current.commands.retry()).rejects.toThrow();
    expect(m.legacy).toHaveBeenCalledTimes(1);
  });
  it("reconciles already-observed approval without sending another money request", async () => {
    m.approve.mockRejectedValueOnce(new TypeError("timeout"));
    const h = setup();
    await open(h, "approveOnly");
    await act(async () => {
      await h.result.current.commands.confirm().catch(() => {});
    });
    m.refresh.mockResolvedValue({
      ...batch,
      rows: {
        [id]: { ...row, approvalStatus: "APPROVED", approvalVersion: 4 },
      },
    });
    await act(async () => {
      await h.result.current.commands.reconcile();
    });
    expect(h.result.current.selected).toBeNull();
    expect(m.approve).toHaveBeenCalledTimes(1);
  });
});

describe("shared dispatcher coverage", () => {
  it("awaits financial timeline facts before marking a successful action complete", async () => {
    let release!: () => void;
    m.invalidate.mockImplementation(({ predicate }: { predicate: (query: { queryKey: string[] }) => boolean }) => predicate({ queryKey: ['settlement-financial-context', 'actor', 'org'] })
      ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve());
    const h = setup();
    await open(h, 'approveOnly');
    let pending!: Promise<void>;
    act(() => { pending = h.result.current.commands.confirm(); });
    await waitFor(() => expect(release).toBeTypeOf('function'));
    expect(h.result.current.busy).toBe(true);
    await act(async () => { release(); await pending; });
    expect(h.result.current.busy).toBe(false);
  });
  const book = "40000000-0000-4000-8000-000000000001",
    evidenceId = "50000000-0000-4000-8000-000000000001";
  it.each(["post", "approveAndPost"] as const)(
    "sends %s exact evidence/book/date/revision/versions without amount",
    async (action) => {
      if (action === "post") {
        row.approvalStatus = "APPROVED";
        row.reviewState = "RESOLVED";
        row.permissions.approve = false;
      }
      m.books = [{ id: book, name: "Sổ thật", organizationId: org }];
      const h = setup();
      await open(h, action);
      const posting = {
        subjectKind: "VOUCHER" as const,
        subjectId: id,
        cashbookId: book,
        postedOn: "2026-09-21",
        evidenceIds: [evidenceId],
        expectedExecutionRevision: 0,
        expectedApprovalVersion: 3,
        expectedPostingVersion: 4,
        idempotencyKey: h.result.current.selected!.key,
      };
      await act(async () => {
        await h.result.current.commands.confirm({ posting });
      });
      expect(action === "post" ? m.post : m.atomic).toHaveBeenCalledWith(
        posting,
      );
      expect(m.approve).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["changed amount", { amount: 999 }],
    ["missing evidence", { evidenceIds: [] }],
    ["different key", { idempotencyKey: "another-key" }],
    ["different CAS", { expectedApprovalVersion: 99 }],
    ["different execution revision", { expectedExecutionRevision: 9 }],
    ["different subject", { subjectId: "another-voucher" }],
  ])("rejects %s before posting", async (_label, invalid) => {
    row.approvalStatus = "APPROVED";
    m.books = [{ id: book, name: "Sổ", organizationId: org }];
    const h = setup();
    await open(h, "post");
    const posting = {
      subjectKind: "VOUCHER" as const,
      subjectId: id,
      cashbookId: book,
      postedOn: "2026-09-21",
      evidenceIds: [evidenceId],
      expectedExecutionRevision: 0,
      expectedApprovalVersion: 3,
      expectedPostingVersion: 4,
      idempotencyKey: h.result.current.selected!.key,
      ...(typeof invalid === 'object' ? invalid : {}),
    };
    await act(async () => {
      await h.result.current.commands.confirm({ posting }).catch(() => {});
    });
    expect(m.post).not.toHaveBeenCalled();
    expect(h.result.current.outcome.kind).toBe("error");
  });
  it("blocks reservation settlement review from a fresh source capability even without a source label", async () => {
    row.systemSource = null;
    row.reviewState = 'CHANGES_REQUESTED';
    const h = setup(); await open(h, 'resubmitReview');
    m.read.mockResolvedValue({ ...batch, rows: [{ ...row, capabilities: { ...row.capabilities, reservationMoneyBlocked: true } }] });
    await act(async () => { await h.result.current.commands.confirm().catch(() => {}); });
    expect(m.resubmit).not.toHaveBeenCalled(); expect(h.result.current.outcome.kind).toBe('error');
  });
  it("reverses with exact account and stable caller key", async () => {
    Object.assign(row, {
      approvalStatus: "APPROVED",
      postingStatus: "POSTED",
      activePostingId: evidenceId,
      accountId: book,
    });
    m.books = [{ id: book, name: "Sổ", organizationId: org }];
    const h = setup();
    await open(h, "reverse");
    await act(async () => {
      await h.result.current.commands.confirm({ reason: "Nhập nhầm sổ quỹ" });
    });
    expect(m.reverse).toHaveBeenCalledWith({
      voucherId: id,
      cashbookId: book,
      reason: "Nhập nhầm sổ quỹ",
      idempotencyKey: expect.any(String),
      postedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
  });
  it("unapproves a supported legacy row with actual CAS", async () => {
    Object.assign(row, {
      flowKind: null,
      approvalStatus: "APPROVED",
      systemSource: null,
    });
    const h = setup();
    await open(h, "unapprove");
    await act(async () => {
      await h.result.current.commands.confirm();
    });
    expect(m.unapprove).toHaveBeenCalledWith({
      id,
      expectedApprovalVersion: 3,
    });
  });
  it("keeps owned refund approval in the shared V2 dispatcher", async () => {
    row.flowKind = "TERMINATION_REFUND";
    row.birthState = "UNVERIFIED";
    const h = setup();
    await open(h, "approveOnly");
    await act(async () => {
      await h.result.current.commands.confirm();
    });
    expect(m.approve).toHaveBeenCalledWith({
      voucherId: id,
      expectedApprovalVersion: 3,
      idempotencyKey: expect.any(String),
    });
    expect(m.legacy).not.toHaveBeenCalled();
  });
  it.each(["income", "flex", "legacy"] as const)(
    "chooses the %s cancellation dispatcher from fresh eligibility",
    async (writer) => {
      row.flowKind = null;
      row.systemSource = null;
      row.capabilities.manual = true;
      if (writer === "income") row.type = "INCOME";
      m.cancelRead.mockResolvedValue({
        income:
          writer === "income"
            ? {
                [id]: {
                  id,
                  eligible: true,
                  mode: "MANUAL",
                  reason_code: null,
                  blocking_voucher_code: null,
                },
              }
            : {},
        flex: {
          [id]: {
            id,
            eligible: writer === "flex",
            reason_code: writer === "flex" ? null : "STRICT_MODE",
          },
        },
      });
      const h = setup();
      await open(h, "cancel");
      await act(async () => {
        await h.result.current.commands.confirm({ reason: "Hủy do nhập nhầm" });
      });
      if (writer === "income")
        expect(m.income).toHaveBeenCalledWith({
          voucherId: id,
          reason: "Hủy do nhập nhầm",
        });
      if (writer === "flex")
        expect(m.flex).toHaveBeenCalledWith({
          voucherId: id,
          reason: "Hủy do nhập nhầm",
          expectedApprovalVersion: 3,
          expectedPostingVersion: 4,
        });
      if (writer === "legacy")
        expect(m.cancel).toHaveBeenCalledWith(
          expect.objectContaining({
            id,
            reason: "Hủy do nhập nhầm",
            expectedApprovalVersion: 3,
            expectedPostingVersion: 4,
            idempotencyKey: expect.any(String),
          }),
        );
    },
  );
  it("appends supplements on cancelled legacy vouchers without any lifecycle write", async () => {
    row.approvalStatus = "CANCELLED";
    row.flowKind = null;
    batch.routes.workflow = "LEGACY";
    const h = setup();
    await open(h, "supplement");
    await act(async () => {
      await h.result.current.commands.confirm({
        supplement: { note: "Chứng từ thêm", attachments: ["receipt.png"] },
      });
    });
    expect(m.supplement).toHaveBeenCalledWith({
      voucherId: id,
      note: "Chứng từ thêm",
      attachments: ["receipt.png"],
      idempotencyKey: expect.any(String),
    });
    expect(m.approve).not.toHaveBeenCalled();
    expect(m.cancel).not.toHaveBeenCalled();
  });
  it("closing an idle confirmation has no write or success outcome", async () => {
    const h = setup();
    await open(h, "approveOnly");
    act(() => h.result.current.close());
    expect(h.result.current.selected).toBeNull();
    expect(h.result.current.outcome.kind).toBe("idle");
    expect(m.approve).not.toHaveBeenCalled();
  });
});
