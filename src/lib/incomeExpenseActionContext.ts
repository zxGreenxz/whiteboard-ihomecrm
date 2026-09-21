import {
  pendingIncomeExpenseActionContext,
  type ActionReadiness,
  type IncomeExpenseActionContext,
} from "./incomeExpenseActionPolicy";
import type { ActionSnapshotBatch } from "./incomeExpenseActionSnapshot";
import type { PostingCashbook } from "./postingCashbooks";
import type { IncomeCancelEligibility } from "@/hooks/income-expenses/incomeVoucherCancel";
import type { FlexCancelEligibility } from "@/hooks/income-expenses/flexMutations";
export interface CancellationEligibility {
  income: Record<string, IncomeCancelEligibility>;
  flex: Record<string, FlexCancelEligibility>;
}
const ready = <T>(value: T): ActionReadiness<T> => ({ state: "ready", value });
const fail = {
  state: "error" as const,
  reason: "Chưa tải được điều kiện của phiếu. Vui lòng tải lại.",
};
const flexCodes = [
  "STRICT_MODE",
  "NOT_MANUAL",
  "CASHBOOK_CLOSED",
  "HANDOVER_LOCKED",
  "PROFIT_LOCKED",
  "DELETED",
  "ALREADY_CANCELLED",
  "RESTRICTED",
  "NO_ACTIVE_POSTING",
  "NO_PERMISSION",
  "NOT_CUSTODIAN",
  "UNKNOWN",
];
const incomeCodes = [
  "NOT_INCOME",
  "DELETED",
  "ALREADY_CANCELLED",
  "NOT_OWNER",
  "CASHBOOK_CLOSED",
  "HANDOVER_LOCKED",
  "PROFIT_LOCKED",
  "LIFO_ORDER",
  "CREDIT_SPENT",
  "IS_REVERSAL",
  "COUNTER_ALIVE",
  "INVOICE_NO_PAYMENT",
  "UNKNOWN",
];
export function parseCancellationEligibility(
  input: unknown,
  ids: readonly string[],
  kind: "income",
): Record<string, IncomeCancelEligibility>;
export function parseCancellationEligibility(
  input: unknown,
  ids: readonly string[],
  kind: "flex",
): Record<string, FlexCancelEligibility>;
export function parseCancellationEligibility(
  input: unknown,
  ids: readonly string[],
  kind: "income" | "flex",
): Record<string, IncomeCancelEligibility | FlexCancelEligibility> {
  if (!Array.isArray(input)) throw new Error("INVALID_CANCEL_ELIGIBILITY");
  const result: Record<
    string,
    IncomeCancelEligibility | FlexCancelEligibility
  > = {};
  for (const value of input) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("INVALID_CANCEL_ELIGIBILITY");
    const r = value as Record<string, unknown>;
    if (
      typeof r.id !== "string" ||
      !ids.includes(r.id) ||
      result[r.id] ||
      typeof r.eligible !== "boolean" ||
      !(
        r.reason_code === null ||
        (typeof r.reason_code === "string" &&
          (kind === "income" ? incomeCodes : flexCodes).includes(r.reason_code))
      )
    )
      throw new Error("INVALID_CANCEL_ELIGIBILITY");
    if (kind === "income") {
      if (
        !(
          r.mode === null ||
          ["MANUAL", "COLLECTION", "FORFEIT_PAIR"].includes(String(r.mode))
        ) ||
        !(
          r.blocking_voucher_code === null ||
          typeof r.blocking_voucher_code === "string"
        ) ||
        (r.eligible && r.mode === null)
      )
        throw new Error("INVALID_CANCEL_ELIGIBILITY");
      result[r.id] = {
        id: r.id,
        eligible: r.eligible,
        reason_code: r.reason_code as IncomeCancelEligibility["reason_code"],
        mode: r.mode as IncomeCancelEligibility["mode"],
        blocking_voucher_code: r.blocking_voucher_code as string | null,
      };
    } else
      result[r.id] = {
        id: r.id,
        eligible: r.eligible,
        reason_code: r.reason_code as FlexCancelEligibility["reason_code"],
      };
  }
  return result;
}
const blockReason = (code: string | null) =>
  ({
    CASHBOOK_CLOSED: "Sổ quỹ đã chốt.",
    HANDOVER_LOCKED: "Phiếu đang thuộc phiên bàn giao.",
    PROFIT_LOCKED: "Tháng đã chốt lợi nhuận.",
    LIFO_ORDER: "Cần hủy khoản thu mới hơn trước.",
    NOT_OWNER: "Chỉ người thu hoặc chủ tổ chức được hủy.",
    NO_PERMISSION: "Không có quyền hủy phiếu tại tòa nhà.",
    NOT_CUSTODIAN: "Cần giữ đúng sổ quỹ của phiếu.",
    CREDIT_SPENT: "Tiền thừa đã được cấn; cần gỡ khoản cấn trước.",
    COUNTER_ALIVE: "Khoản thu đã có phiếu hoàn tác.",
    RESTRICTED: "Phiếu có hạng mục hạn chế.",
  })[code || ""] ?? "Nguồn phiếu chưa đủ điều kiện hủy.";
export function buildIncomeExpenseActionContext(args: {
  id: string;
  snapshot: ActionReadiness<ActionSnapshotBatch>;
  cashbooks: ActionReadiness<PostingCashbook[]>;
  cancellation: ActionReadiness<CancellationEligibility>;
  handlers: IncomeExpenseActionContext["handlers"];
  display?: IncomeExpenseActionContext["display"];
  canonicalOnly?: boolean;
}): IncomeExpenseActionContext {
  const c = pendingIncomeExpenseActionContext(args.handlers, args.display, args.canonicalOnly),
    batch = args.snapshot;
  if (batch.state !== "ready") {
    if (batch.state === "error")
      for (const key of [
        "voucher",
        "actor",
        "permissions",
        "routes",
        "ownership",
        "lifecycle",
        "source",
      ] as const)
        c[key] = batch;
    return c;
  }
  const b = batch.value,
    v = b.rows[args.id];
  c.actor = ready({
    id: b.actorId,
    organizationId: b.organizationId,
    isAdmin: b.isAdmin,
  });
  c.routes = ready(b.routes);
  if (!v) {
    c.voucher = fail;
    return c;
  }
  const cap = v.capabilities,
    canonical =
      v.flowKind === null || v.flowKind === "CANONICAL_INCOME_EXPENSE";
  c.voucher = ready(v);
  c.permissions = ready(v.permissions);
  c.source = ready({
    moneyActionsAllowed: !cap.reservationMoneyBlocked,
    refundReverseAllowed: v.systemSource === 'reservation.refund' ? false : cap.reservationRefundReverseAllowed,
    reservationRefund: v.systemSource === 'reservation.refund' ? cap.reservationRefund ?? null : null,
  });
  c.ownership = ready({
    flowKind: v.flowKind,
    sourceReviewSupported:
      canonical && (!v.systemSource?.startsWith("reservation.") || (v.systemSource === 'reservation.refund' && !!cap.reservationRefund?.basisValid && cap.reservationRefund.current && cap.reservationRefund.fullRemaining)),
    moneyEditAllowed: v.flowKind === null && cap.manual,
  });
  c.lifecycle = ready({
    forfeitPair: cap.forfeitPair,
    forfeitAllowed: cap.forfeitAllowed && !cap.engineBlocked,
    approveBirthReady: canonical
      ? v.birthState === "COMMITTED"
      : cap.birthPrior,
    unapproveSupported:
      !cap.engineBlocked &&
      (cap.forfeitPair ? cap.forfeitAllowed : v.flowKind === null),
  });
  const books = args.cashbooks;
  c.custody =
    books.state === "ready"
      ? ready({
          hasUsableCashbook: books.value.length > 0,
          holdsVoucherCashbook: books.value.some(
            (a) =>
              a.id === v.accountId && a.organizationId === v.organizationId,
          ),
        })
      : books;
  if (args.cancellation.state !== "ready") {
    c.cancellation = args.cancellation;
    return c;
  }
  const eligibility = args.cancellation.value;
  if (v.type === "INCOME") {
    const e = eligibility.income[v.id];
    c.cancellation = e
      ? ready({
          canCancel: e.eligible,
          reason: e.eligible ? null : blockReason(e.reason_code),
          useIncomeDoor: true,
          useFlexWriter: false,
          mode: e.mode,
        })
      : fail;
    return c;
  }
  const e = eligibility.flex[v.id];
  if (!e) {
    c.cancellation = fail;
    return c;
  }
  if (e.eligible) {
    c.cancellation = ready({
      canCancel: true,
      reason: null,
      useIncomeDoor: false,
      useFlexWriter: true,
      mode: null,
    });
    return c;
  }
  if (!["STRICT_MODE", "NOT_MANUAL"].includes(e.reason_code || "")) {
    c.cancellation = ready({
      canCancel: false,
      reason: blockReason(e.reason_code),
      useIncomeDoor: false,
      useFlexWriter: false,
      mode: null,
    });
    return c;
  }
  // Fallback signals only select a writer. They are never permission grants.
  if (books.state !== "ready") {
    c.cancellation = books;
    return c;
  }
  const held = books.value.some((a) => a.id === v.accountId),
    refund = ["INVOICE_REFUND", "TERMINATION_REFUND"].includes(
      v.flowKind || "",
    );
  const fallback = cap.forfeitPair
    ? cap.forfeitAllowed && !cap.engineBlocked
    : refund
      ? v.permissions.approve
      : canonical &&
        (cap.legacyCancelAllowed ||
          cap.compatCancelOwner ||
          (v.permissions.cancel && (!v.accountId || held)));
  const postedReady =
    v.postingStatus !== "POSTED" ||
    (canonical && held && v.permissions.reverse);
  c.cancellation = ready({
    canCancel: fallback && postedReady,
    reason:
      fallback && postedReady
        ? null
        : "Chưa có quyền hoặc cửa hủy phù hợp với nguồn phiếu.",
    useIncomeDoor: false,
    useFlexWriter: false,
    mode: null,
  });
  return c;
}
