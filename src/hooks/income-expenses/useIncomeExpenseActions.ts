import { executeReservationRefundAction, type ReservationRefundActionInput } from '@/lib/reservationRefundRepository';
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { todayISO } from "@/lib/collect";
import { buildIncomeExpenseActionContext } from "@/lib/incomeExpenseActionContext";
import {
  decideIncomeExpenseActions,
  type IncomeExpenseAction,
  type IncomeExpenseActionContext,
  type ActionReadiness,
} from "@/lib/incomeExpenseActionPolicy";
import {
  readActionSnapshotBatches,
  type ActionSnapshotScope,
  type IncomeExpenseActionSnapshot,
  type ActionSnapshotBatch,
} from "@/lib/incomeExpenseActionSnapshot";
import {
  validatePostFinanceExecutionInput,
  type PostFinanceExecutionInput,
} from "@/lib/incomeExpensePostingValidation";
import {
  useIncomeExpenseActionSnapshots,
  readIncomeExpenseActionSnapshotPage,
} from "./useIncomeExpenseActionSnapshots";
import { usePostingCashbooks } from "./usePostingCashbooks";
import {
  useIncomeExpenseCancellation,
  readIncomeExpenseCancellation,
} from "./useIncomeExpenseCancellation";
import {
  useApproveIncomeExpenseV2,
  useApproveAndPostIncomeExpenseV2,
  usePostApprovedIncomeExpenseV2,
  useReversePostingV2,
} from "./financeV2Mutations";
import {
  isIncomeExpensePartialCommitError,
  useApproveVoucher,
  useUnapproveVoucher,
  useCancelIncomeExpense,
} from "./statusMutations";
import { useCancelVoucherFlex } from "./flexMutations";
import { useCancelIncomeVoucher } from "./incomeVoucherCancel";
import {
  useRequestIncomeExpenseChanges,
  useResubmitIncomeExpenseReview,
} from "./reviewMutations";
import { useAppendIncomeExpenseSupplement } from "./supplements";
import { useQuickUpdateIncomeExpense } from "./mutations";
import { useUpdateIncomeExpenseRecipient } from './recipientMutations';
import { buildRecipientPatch, type VoucherRecipient } from '@/lib/incomeExpenseRecipient';

export const incomeExpenseActionRefreshKeys = [
  "income-expenses",
  "income-expense-stats",
  "income-expense",
  "income-expense-batches",
  "voucher-with-batch",
  "contract-settlement",
  "contract-settlement-events",
  "period-commission-overview",
  "room-cash-lifecycle",
  "settlement-financial-context",
  "accounts-with-balance",
  "cash-book",
  "cash-book-summary",
  "cashbook-balance-as-of",
  "cash-flow-by-day",
  "ie-history",
  "voucher-change-log",
  "voucher-cancellation",
  "income-expense-supplements",
  "income-cancel-eligibility",
  "flex-cancel-eligibility",
  "invoices",
  "invoices-legacy",
  "invoice",
  "invoice-history",
  "invoice-vouchers",
  "invoice-statistics",
  "invoice-totals-by-ids",
  "first-invoice-details",
  "invoice-collectors",
  "unpaid-invoices",
  "ie-related-invoice",
  "room-latest-invoice",
  "payments",
  "payments-summary",
  "invoice-payments-summary",
  "dashboard-summary",
  "dashboard-alerts",
  "recent-activities",
  "deposit-dashboard",
  "settlement-report",
  "financial-analysis",
  "reports",
  "monthly-building-profit",
  "profit-verification",
  "contracts",
  "contract-termination-info",
  "termination-refund-preview",
  "reservation-settlements", "reservation-settlement-summary", "reservation-settlement-audit", "reservation-deposits", "orphan-deposit-vouchers",
  "reservation-refund-workflow",
  "reservation-settlement-by-voucher",
  "reservation-settlement-preview",
  "reservation-refund-evidence",
  "tt-deposit-ledger",
  "finance-v2-routes",
] as const;
export interface IncomeExpenseActionPayload {
  reason?: string;
  posting?: PostFinanceExecutionInput;
  legacy?: { accountId: string | null; attachments: string[] };
  supplement?: { note: string; attachments: string[] };
  recipient?: VoucherRecipient;
}
export type ActionOutcome = {
  kind: "idle" | "error" | "unknown" | "partial-committed" | "processed-refresh-failed" | "success";
  message: string | null;
};
export interface SelectedIncomeExpenseAction {
  id: string;
  action: IncomeExpenseAction;
  scope: ActionSnapshotScope;
  snapshot: IncomeExpenseActionSnapshot | null;
  routes: ActionSnapshotBatch["routes"] | null;
  key: string;
  payload?: IncomeExpenseActionPayload;
  postedOn: string;
  resolveApproval?: boolean;
}
const ready = <T>(value: T) => ({ state: "ready" as const, value });
const readiness = <T>(request: Promise<T>): Promise<ActionReadiness<T>> =>
  request.then(ready, () => ({
    state: "error",
    reason: "Chưa tải được điều kiện thao tác.",
  }));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const cas = (v: number | null) => {
  if (v === null || !Number.isSafeInteger(v) || v < 0)
    throw new Error("Chưa tải phiên bản phiếu.");
  return v;
};
const fingerprint = (v: IncomeExpenseActionSnapshot) =>
  JSON.stringify([
    v.id,
    v.organizationId,
    v.buildingId,
    v.roomId,
    v.contractId,
    v.tenantId,
    v.code,
    v.totalAmount,
    v.type,
    v.systemSource,
    v.flowKind,
    v.accountId,
    v.approvalStatus,
    v.reviewState,
    v.postingStatus,
    v.activePostingId,
    v.approvalVersion,
    v.postingVersion,
    v.reviewVersion,
    v.payerName,
    v.receiveBankName,
    v.receiveBankAccount,
  ]);
const sameScope = (a: ActionSnapshotScope, b: ActionSnapshotScope) =>
  a.actorId === b.actorId && a.organizationId === b.organizationId;
const errorText = (e: unknown) =>
  e && typeof e === "object" && "message" in e
    ? String(e.message)
    : "Không thể xử lý phiếu.";
const definitive = (e: unknown) =>
  e &&
  typeof e === "object" &&
  (("code" in e &&
    ["42501", "40001", "55000", "22023", "23505", "P0001", "P0002"].includes(
      String(e.code),
    )) ||
    ("kind" in e && e.kind !== "unconfirmed"));
const allHandlers: IncomeExpenseActionContext["handlers"] = {
  approveOnly: true,
  legacyApprove: true,
  approveAndPost: true,
  post: true,
  reverse: true,
  unapprove: true,
  cancel: true,
  supplement: true,
  requestChanges: true,
  resubmitReview: true,
  editRecipient: true,
};
/** The same controller owns every shared surface. Display rows never supply versions or route fallbacks. */
export function useIncomeExpenseActions(args: {
  scope: ActionSnapshotScope;
  voucherIds: readonly string[];
  onEdit?: (id: string) => void;
  refreshRequired?: () => Promise<void>;
  canonicalOnly?: boolean;
}) {
  const client = useQueryClient(),
    [selected, setSelected] = useState<SelectedIncomeExpenseAction | null>(
      null,
    ),
    [phase, setPhase] = useState<
      "idle" | "preflight" | "writing" | "refreshing"
    >("idle");
  const [outcome, setOutcomeValue] = useState<ActionOutcome>({
    kind: "idle",
    message: null,
  });
  const outcomeRef = useRef(outcome);
  const setOutcome = (next: ActionOutcome) => {
    outcomeRef.current = next;
    setOutcomeValue(next);
  };
  const inFlight = useRef(false),
    selection = useRef(selected),
    current = useRef(args);
  selection.current = selected;
  current.current = args;
  const ids = [
    ...new Set([...args.voucherIds, ...(selected ? [selected.id] : [])]),
  ];
  const snapshots = useIncomeExpenseActionSnapshots(args.scope, ids),
    books = usePostingCashbooks(args.scope);
  const eligibleIds =
    snapshots.readiness.state === "ready"
      ? Object.keys(snapshots.readiness.value.rows)
      : [];
  const cancelEligibility = useIncomeExpenseCancellation(
    args.scope,
    eligibleIds,
    snapshots.readiness.state === "ready",
  );
  const handlers = { ...allHandlers, edit: !!args.onEdit };
  const contexts: Record<string, IncomeExpenseActionContext> = {};
  for (const id of ids)
    contexts[id] = buildIncomeExpenseActionContext({
      id,
      snapshot: snapshots.readiness,
      cashbooks: books.readiness,
      cancellation: cancelEligibility.readiness,
      handlers,
      canonicalOnly: args.canonicalOnly,
    });
  const approve = useApproveIncomeExpenseV2({ managed: true }),
    atomic = useApproveAndPostIncomeExpenseV2({ managed: true }),
    post = usePostApprovedIncomeExpenseV2({ managed: true }),
    reverse = useReversePostingV2({ managed: true });
  const legacy = useApproveVoucher({ managed: true }),
    unapprove = useUnapproveVoucher({ managed: true }),
    cancel = useCancelIncomeExpense({ managed: true }),
    flex = useCancelVoucherFlex({ managed: true }),
    income = useCancelIncomeVoucher({ managed: true });
  const request = useRequestIncomeExpenseChanges(),
    resubmit = useResubmitIncomeExpenseReview(),
    supplement = useAppendIncomeExpenseSupplement({ managed: true }),
    quick = useQuickUpdateIncomeExpense({ managed: true }),
    recipient = useUpdateIncomeExpenseRecipient();
  useEffect(() => {
    if (
      selected &&
      !selected.snapshot &&
      snapshots.readiness.state === "ready"
    ) {
      if (current.current.canonicalOnly && (snapshots.readiness.value.routes.workflow !== "CANONICAL" || snapshots.readiness.value.routes.posting !== "CANONICAL")) {
        setOutcome({ kind: "error", message: "Khu Hợp đồng & quyết toán cần quy trình thu chi chuẩn." });
        setSelected(null);
        return;
      }
      const v = snapshots.readiness.value.rows[selected.id];
      if (v)
        setSelected({
          ...selected,
          action:
            selected.resolveApproval &&
            snapshots.readiness.value.routes.workflow !== "CANONICAL"
              ? "legacyApprove"
              : selected.action,
          resolveApproval: false,
          snapshot: clone(v),
          routes: clone(snapshots.readiness.value.routes),
        });
    }
  }, [selected, snapshots.readiness]);
  const busy = phase !== "idle",
    dismissalBlocked =
      busy ||
      outcome.kind === "unknown" ||
      outcome.kind === "partial-committed" ||
      outcome.kind === "processed-refresh-failed";
  function open(
    action: IncomeExpenseAction,
    id: string,
    resolveApproval = false,
  ) {
    if (
      inFlight.current ||
      ["unknown", "partial-committed", "processed-refresh-failed"].includes(outcomeRef.current.kind)
    )
      return;
    const b =
      snapshots.readiness.state === "ready" ? snapshots.readiness.value : null;
    if (args.canonicalOnly && b && (b.routes.workflow !== "CANONICAL" || b.routes.posting !== "CANONICAL")) {
      setOutcome({ kind: "error", message: "Khu Hợp đồng & quyết toán cần quy trình thu chi chuẩn." });
      return;
    }
    setOutcome({ kind: "idle", message: null });
    setSelected({
      id,
      action,
      scope: { ...args.scope },
      snapshot: b?.rows[id] ? clone(b.rows[id]) : null,
      routes: b ? clone(b.routes) : null,
      key: crypto.randomUUID(),
      postedOn: todayISO(),
      resolveApproval,
    });
  }
  function close() {
    if (
      !inFlight.current &&
      !["unknown", "partial-committed", "processed-refresh-failed"].includes(outcomeRef.current.kind)
    )
      setSelected(null);
  }
  async function refreshAll() {
    // Invalidate mounted readers with rejection enabled; unmounted entries stay stale for next open.
    await client.invalidateQueries(
      {
        predicate: (q) =>
          incomeExpenseActionRefreshKeys.includes(
            q.queryKey[0] as (typeof incomeExpenseActionRefreshKeys)[number],
          ),
      },
      { throwOnError: true },
    );
    const [batch] = await Promise.all([
      snapshots.refresh(),
      books.refresh(),
      cancelEligibility.refresh(),
      current.current.refreshRequired?.(),
    ]);
    return batch;
  }
  async function freshContext(op: SelectedIncomeExpenseAction) {
    const [batch, cashbooks, cancellation] = await Promise.all([
      readActionSnapshotBatches(
        op.scope,
        [op.id],
        readIncomeExpenseActionSnapshotPage,
      ),
      readiness(books.refresh()),
      readiness(readIncomeExpenseCancellation([op.id])),
    ]);
    if (!sameScope(op.scope, current.current.scope))
      throw new Error("Tổ chức hoặc người dùng đã thay đổi. Hãy mở lại phiếu.");
    const ctx = buildIncomeExpenseActionContext({
      id: op.id,
      snapshot: ready(batch),
      cashbooks,
      cancellation,
      handlers,
      canonicalOnly: current.current.canonicalOnly,
    });
    return {
      batch,
      ctx,
      cashbooks: cashbooks.state === "ready" ? cashbooks.value : [],
    };
  }
  async function dispatch(
    op: SelectedIncomeExpenseAction,
    ctx: IncomeExpenseActionContext,
  ) {
    const v = op.snapshot;
    if (!v) throw new Error("Chưa tải phiếu.");
    const p = op.payload || {},
      reason = p.reason?.trim() || "";
    const refund = v.systemSource === 'reservation.refund' ? v.capabilities.reservationRefund : null;
    const refundAction = (action: ReservationRefundActionInput['action'], extra: Partial<ReservationRefundActionInput> = {}) => {
      if (!refund || !v.organizationId) throw Object.assign(new Error('Chưa tải đủ nguồn hoàn giữ chỗ.'), { code: '22023' });
      return executeReservationRefundAction({ ...extra, action, organizationId: v.organizationId, voucherId: v.id,
        sourceVoucherId: refund.sourceVoucherId, settlementId: refund.settlementId, basisFingerprint: refund.basisFingerprint,
        expectedRemaining: refund.remaining, expectedApprovalVersion: cas(v.approvalVersion), expectedPostingVersion: cas(v.postingVersion),
        expectedReviewVersion: cas(v.reviewVersion), idempotencyKey: op.key });
    };
    switch (op.action) {
      case "approveOnly":
        if (refund) return refundAction("approve");
        return approve.mutateAsync({
          voucherId: v.id,
          expectedApprovalVersion: cas(v.approvalVersion),
          idempotencyKey: op.key,
        });
      case "legacyApprove":
        if (
          p.legacy &&
          (p.legacy.accountId !== v.accountId ||
            JSON.stringify(p.legacy.attachments) !==
              JSON.stringify(v.attachments))
        ) {
          if (
            v.flowKind !== null ||
            ctx.permissions.state !== "ready" ||
            !ctx.permissions.value.edit
          )
            throw Object.assign(
              new Error("Phiếu khóa nội dung; không thể đổi sổ trước duyệt."),
              { code: "42501" },
            );
          await quick.mutateAsync({
            id: v.id,
            account_id: p.legacy.accountId,
            attachments: p.legacy.attachments,
            notes: v.notes,
          });
        }
        return legacy.mutateAsync(v.id);
      case "approveAndPost":
      case "post": {
        const input = p.posting;
        if (
          !input ||
          input.subjectKind !== "VOUCHER" ||
          input.subjectId !== v.id ||
          input.amount !== undefined ||
          input.idempotencyKey !== op.key ||
          input.expectedExecutionRevision !== 0 ||
          input.expectedApprovalVersion !== v.approvalVersion ||
          input.expectedPostingVersion !== v.postingVersion ||
          !validatePostFinanceExecutionInput(input).ok
        )
          throw Object.assign(
            new Error("Thông tin ghi sổ không khớp phiếu đang rà soát."),
            { code: "22023" },
          );
        if (refund) return refundAction(op.action === 'post' ? 'post' : 'approve_and_post', { cashbookId: input.cashbookId, postedOn: input.postedOn, evidenceIds: input.evidenceIds });
        return op.action === "post"
          ? post.mutateAsync(input)
          : atomic.mutateAsync(input);
      }
      case "reverse":
        if (!v.accountId || reason.length < 8)
          throw Object.assign(
            new Error("Nhập lý do hoàn tác ít nhất 8 ký tự."),
            { code: "22023" },
          );
        if (refund) return refundAction('reverse', { cashbookId: v.accountId, reason, postedOn: op.postedOn });
        return reverse.mutateAsync({
          voucherId: v.id,
          cashbookId: v.accountId,
          reason,
          idempotencyKey: op.key,
          postedOn: op.postedOn,
        });
      case "unapprove":
        return unapprove.mutateAsync({
          id: v.id,
          expectedApprovalVersion: cas(v.approvalVersion),
        });
      case "cancel": {
        if (reason.length < 8 || ctx.cancellation.state !== "ready")
          throw Object.assign(new Error("Nhập lý do hủy ít nhất 8 ký tự."), {
            code: "22023",
          });
        const gate = ctx.cancellation.value;
        if (gate.useIncomeDoor)
          return income.mutateAsync({ voucherId: v.id, reason });
        if (gate.useFlexWriter)
          return flex.mutateAsync({
            voucherId: v.id,
            reason,
            expectedApprovalVersion: cas(v.approvalVersion),
            expectedPostingVersion: cas(v.postingVersion),
          });
        return cancel.mutateAsync({
          id: v.id,
          reason,
          expectedApprovalVersion: cas(v.approvalVersion),
          expectedPostingVersion: cas(v.postingVersion),
          idempotencyKey: op.key,
          postedOn: op.postedOn,
        });
      }
      case "requestChanges":
        if (refund) return refundAction('request_changes', {reason});
        return request.mutateAsync({
          voucherId: v.id,
          reason,
          expectedReviewVersion: cas(v.reviewVersion),
          idempotencyKey: op.key,
        });
      case "resubmitReview":
        if (refund) return refundAction('resubmit');
        return resubmit.mutateAsync({
          voucherId: v.id,
          expectedReviewVersion: cas(v.reviewVersion),
          idempotencyKey: op.key,
        });
      case "supplement":
        if (!p.supplement)
          throw Object.assign(new Error("Chưa nhập nội dung bổ sung."), {
            code: "22023",
          });
        return supplement.mutateAsync({
          voucherId: v.id,
          ...p.supplement,
          idempotencyKey: op.key,
        });
      case "edit":
        current.current.onEdit?.(v.id);
        return;
      case 'editRecipient': {
        if (!p.recipient) throw Object.assign(new Error('Chưa nhập thông tin người nhận.'), { code: '22023' });
        const original = { payerName: v.payerName, bankName: v.receiveBankName, bankAccount: v.receiveBankAccount };
        return recipient.mutateAsync({ voucherId: v.id, organizationId: op.scope.organizationId,
          expected: { ...original, approvalVersion: v.approvalVersion, postingVersion: v.postingVersion, reviewVersion: v.reviewVersion },
          patch: buildRecipientPatch(original, p.recipient) });
      }
    }
  }
  async function confirm(payload: IncomeExpenseActionPayload = {}) {
    if (inFlight.current) throw new Error("Đang xử lý phiếu.");
    const selectedNow = selection.current;
    if (!selectedNow?.snapshot || !selectedNow.routes)
      throw new Error("Chưa tải đủ phiếu.");
    if (["partial-committed", "processed-refresh-failed"].includes(outcomeRef.current.kind))
      throw new Error("Phiếu đã được xử lý. Hãy tải lại dữ liệu.");
    if (outcomeRef.current.kind === "unknown" && !selectedNow.payload)
      throw new Error("Chưa xác định được yêu cầu trước.");
    const wasUnknown = outcomeRef.current.kind === "unknown";
    if (
      wasUnknown &&
      (["legacyApprove", "unapprove", "cancel", "edit", "editRecipient"].includes(
        selectedNow.action,
      ) ||
        selectedNow.snapshot.capabilities.forfeitPair)
    )
      throw new Error("Yêu cầu này cần đối chiếu, không tự gửi lại.");
    const op = {
      ...selectedNow,
      snapshot: selectedNow.snapshot,
      payload: wasUnknown ? selectedNow.payload : clone(payload),
    };
    selection.current = op;
    setSelected(op);
    inFlight.current = true;
    setPhase("preflight");
    setOutcome({ kind: "idle", message: null });
    let writeStarted = false,
      writeConfirmed = false;
    try {
      const { batch, ctx, cashbooks } = await freshContext(op),
        fresh = batch.rows[op.id];
      if (
        !fresh ||
        fingerprint(fresh) !== fingerprint(op.snapshot) ||
        JSON.stringify(batch.routes) !== JSON.stringify(op.routes)
      )
        throw new Error(
          "Phiếu hoặc quy trình vừa thay đổi. Đóng và mở lại để rà soát trước khi xác nhận.",
        );
      const decision = decideIncomeExpenseActions(ctx)[op.action];
      if (!decision.enabled)
        throw new Error(decision.reason || "Chưa đủ điều kiện thao tác.");
      if (
        op.payload?.posting &&
        !cashbooks.some((b) => b.id === op.payload?.posting?.cashbookId)
      )
        throw new Error(
          "Sổ quỹ đã chọn không còn thuộc quyền giữ sổ hiện tại.",
        );
      if (op.action === "edit") {
        current.current.onEdit?.(op.id);
        setSelected(null);
        return;
      }
      setPhase("writing");
      writeStarted = true;
      await dispatch(op, ctx);
      writeConfirmed = true;
      setPhase("refreshing");
      await refreshAll();
      setOutcome({
        kind: "success",
        message: "Đã xử lý phiếu và tải lại dữ liệu.",
      });
      setSelected(null);
      toast.success("Đã xử lý phiếu và tải lại dữ liệu.");
    } catch (error) {
      const partialCommit = isIncomeExpensePartialCommitError(error);
      if (partialCommit) {
        setPhase("refreshing");
        try {
          const refreshed = await refreshAll();
          const latest = refreshed.rows[op.id];
          if (latest && (latest.approvalStatus === "CANCELLED" || latest.postingStatus === "REVERSED")) {
            setSelected(null);
            setOutcome({
              kind: latest.approvalStatus === "CANCELLED" ? "success" : "error",
              message: latest.approvalStatus === "CANCELLED"
                ? "Đã hoàn tác tiền và hủy phiếu."
                : "Đã hoàn tác tiền; phiếu chưa hủy. Trạng thái mới đã được tải lại để tiếp tục xử lý.",
            });
          } else {
            setOutcome({ kind: "partial-committed", message: errorText(error) });
          }
        } catch {
          setOutcome({ kind: "partial-committed", message: errorText(error) });
        }
      } else if (writeConfirmed) {
        setOutcome({
          kind: "processed-refresh-failed",
          message:
            "Đã xử lý, chưa tải lại được. Hãy tải lại dữ liệu trước khi thao tác tiếp.",
        });
      } else if (
        (wasUnknown && !writeStarted) ||
        (writeStarted && !definitive(error))
      ) {
        setOutcome({
          kind: "unknown",
          message:
            "Chưa xác nhận được kết quả. Giữ nguyên yêu cầu và tải lại để đối chiếu.",
        });
      } else {
        setOutcome({ kind: "error", message: errorText(error) });
        setPhase("refreshing");
        try {
          await refreshAll();
        } catch {
          /* Error remains visible; query readiness also fails closed. */
        }
      }
      toast.error(
        partialCommit ? "Đã ghi nhận một phần, cần đối chiếu." : writeConfirmed ? "Đã xử lý, chưa tải lại được." : errorText(error),
      );
      throw error;
    } finally {
      inFlight.current = false;
      setPhase("idle");
    }
  }
  async function reconcile() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPhase("refreshing");
    try {
      const batch = await refreshAll(),
        op = selection.current,
        v = op ? batch.rows[op.id] : null;
      let observed = false;
      if (
        outcome.kind === "unknown" &&
        v &&
        op?.snapshot &&
        sameScope(op.scope, current.current.scope) &&
        v.code === op.snapshot.code &&
        v.totalAmount === op.snapshot.totalAmount &&
        v.systemSource === op.snapshot.systemSource &&
        v.flowKind === op.snapshot.flowKind
      ) {
        observed =
          op.action === "cancel"
            ? v.approvalStatus === "CANCELLED"
            : op.action === "reverse"
              ? v.postingStatus === "REVERSED"
              : op.action === "unapprove"
                ? v.approvalStatus === "UNAPPROVED" &&
                  v.reviewState === "PENDING"
                : op.action === "requestChanges"
                  ? v.reviewState === "CHANGES_REQUESTED" &&
                    (v.reviewVersion ?? -1) > (op.snapshot.reviewVersion ?? -1)
                  : op.action === "resubmitReview"
                    ? v.reviewState === "PENDING" &&
                      (v.reviewVersion ?? -1) >
                        (op.snapshot.reviewVersion ?? -1)
                    : op.action === "post" || op.action === "approveAndPost"
                      ? v.approvalStatus === "APPROVED" &&
                        v.postingStatus === "POSTED"
                      : op.action === "approveOnly" ||
                          op.action === "legacyApprove"
                        ? v.approvalStatus === "APPROVED"
                        : false;
        if (op.action === 'editRecipient' && op.payload?.recipient) {
          const original = { payerName: op.snapshot.payerName, bankName: op.snapshot.receiveBankName, bankAccount: op.snapshot.receiveBankAccount };
          const wanted = { ...original, ...buildRecipientPatch(original, op.payload.recipient) };
          observed = v.payerName === wanted.payerName && v.receiveBankName === wanted.bankName && v.receiveBankAccount === wanted.bankAccount
            && v.accountId === op.snapshot.accountId && v.contractId === op.snapshot.contractId && v.roomId === op.snapshot.roomId
            && v.approvalStatus === op.snapshot.approvalStatus && v.postingStatus === op.snapshot.postingStatus && v.reviewState === op.snapshot.reviewState;
        }
      }
      if (outcome.kind === "partial-committed") {
        if (v && (v.approvalStatus === "CANCELLED" || v.postingStatus === "REVERSED")) {
          setSelected(null);
          setOutcome({
            kind: v.approvalStatus === "CANCELLED" ? "success" : "error",
            message: v.approvalStatus === "CANCELLED"
              ? "Đã hoàn tác tiền và hủy phiếu."
              : "Đã hoàn tác tiền; phiếu chưa hủy. Trạng thái mới đã được tải lại để tiếp tục xử lý.",
          });
        }
      } else if (outcome.kind === "processed-refresh-failed" || observed) {
        setSelected(null);
        setOutcome({
          kind: "success",
          message: "Đã đối chiếu trạng thái hiện tại của phiếu.",
        });
      }
    } catch {
      toast.error("Chưa tải lại được dữ liệu.");
    } finally {
      inFlight.current = false;
      setPhase("idle");
    }
  }
  const retryable =
    selected &&
    !["legacyApprove", "unapprove", "cancel", "edit", "editRecipient"].includes(
      selected.action,
    ) &&
    !selected.snapshot?.capabilities.forfeitPair;
  return {
    contexts,
    availability: (id: string) =>
      decideIncomeExpenseActions(
        contexts[id] ??
          buildIncomeExpenseActionContext({
            id,
            snapshot: snapshots.readiness,
            cashbooks: books.readiness,
            cancellation: cancelEligibility.readiness,
            handlers,
            canonicalOnly: args.canonicalOnly,
          }),
      ),
    selected,
    open,
    openApproval: (id: string) => {
      const b =
        snapshots.readiness.state === "ready"
          ? snapshots.readiness.value
          : null;
      open(
        !args.canonicalOnly && b && b.rows[id] && b.routes.workflow !== "CANONICAL"
          ? "legacyApprove"
          : "approveOnly",
        id,
        !b?.rows[id],
      );
    },
    close,
    busy,
    dismissalBlocked,
    outcome,
    cashbooks: books.readiness,
    selectedAvailability: selected
      ? decideIncomeExpenseActions(contexts[selected.id])
      : null,
    commands: {
      confirm,
      reconcile,
      retry: async () => {
        if (!retryable)
          throw new Error(
            "Yêu cầu này cần đối chiếu kết quả; không tự gửi lại.",
          );
        return confirm();
      },
    },
    retryable: !!retryable,
  };
}
export type IncomeExpenseActionsController = ReturnType<
  typeof useIncomeExpenseActions
>;
