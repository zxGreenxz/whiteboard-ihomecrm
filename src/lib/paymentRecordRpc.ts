import type { Database, Json } from "@/integrations/supabase/types";

export type PaymentMethod = Database["public"]["Enums"]["payment_method"];

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;
const ROUNDING_THRESHOLD = 10_000;

function normalizeIdempotencyKey(idempotencyKey: string): string {
  const normalized = idempotencyKey.trim();
  if (!IDEMPOTENCY_KEY_RE.test(normalized)) {
    throw new Error(
      "idempotency_key must be 8 to 200 ASCII characters using A-Z, a-z, 0-9, ., _, :, or -",
    );
  }
  return normalized;
}

function isMoney(value: number, allowZero = false): boolean {
  if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) return false;
  return Math.abs(Math.round(value * 100) - value * 100) < 1e-6;
}

export interface PaymentRpcError {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
}

export type CollectionOverpayAction = "REJECT" | "REFUND" | "CREDIT";

export interface InvoiceCollectionTenderInput {
  payment_method: PaymentMethod;
  gross_amount: number;
  account_id: string;
  /** Optional client metadata for fail-fast account invariants; never sent to RPC. */
  account_is_virtual?: boolean | null;
  change_account_id?: string | null;
  change_account_is_virtual?: boolean | null;
  rounding_account_id?: string | null;
  rounding_account_is_virtual?: boolean | null;
  receipt_number?: string | null;
}

export interface RecordInvoiceCollectionInput {
  invoice_id: string;
  collection_date: string;
  tenders: InvoiceCollectionTenderInput[];
  overpay_action: CollectionOverpayAction;
  allow_rounding: boolean;
  notes?: string | null;
  receipt_image_url?: string | null;
  expected_paid_amount: number;
}

export interface RecordInvoiceCollectionRpcArgs {
  p_invoice_id: string;
  p_collection_date: string;
  p_tenders: Json;
  p_overpay_action: CollectionOverpayAction;
  p_allow_rounding: boolean;
  p_notes: string | null;
  p_receipt_image_url: string | null;
  p_expected_paid_amount: number;
  p_idempotency_key: string;
}

function normalizeTender(tender: InvoiceCollectionTenderInput): InvoiceCollectionTenderInput {
  if (!isMoney(tender.gross_amount)) {
    throw new Error("Mỗi dòng thanh toán phải lớn hơn 0 và tối đa 2 số lẻ");
  }
  if (!tender.account_id?.trim()) {
    throw new Error("Mỗi dòng thanh toán phải có sổ quỹ nhận");
  }
  if (tender.account_is_virtual === true) {
    throw new Error("Sổ quỹ nhận tiền phải là sổ thật, không phải sổ ảo");
  }
  if (tender.change_account_id && tender.change_account_is_virtual === false) {
    throw new Error("Sổ quỹ tiền thối phải là sổ ảo");
  }
  if (tender.rounding_account_id && tender.rounding_account_is_virtual === false) {
    throw new Error("Sổ quỹ làm tròn phải là sổ ảo");
  }
  if (!(["TM", "TK", "TT"] as string[]).includes(tender.payment_method)) {
    throw new Error("Phương thức thanh toán không hợp lệ");
  }
  return {
    payment_method: tender.payment_method,
    gross_amount: tender.gross_amount,
    account_id: tender.account_id.trim(),
    change_account_id: tender.change_account_id?.trim() || null,
    rounding_account_id: tender.rounding_account_id?.trim() || null,
    receipt_number: tender.receipt_number?.trim() || null,
  };
}

function normalizeCollectionInput(
  input: RecordInvoiceCollectionInput,
): RecordInvoiceCollectionInput {
  if (!input.invoice_id?.trim() || !input.collection_date) {
    throw new Error("Hóa đơn hoặc ngày thu không hợp lệ");
  }
  if (!Array.isArray(input.tenders) || input.tenders.length === 0) {
    throw new Error("Phải có ít nhất một dòng thanh toán");
  }
  if (!isMoney(input.expected_paid_amount, true)) {
    throw new Error("expected_paid_amount không hợp lệ");
  }
  if (!(["REJECT", "REFUND", "CREDIT"] as string[]).includes(input.overpay_action)) {
    throw new Error("overpay_action không hợp lệ");
  }
  return {
    ...input,
    invoice_id: input.invoice_id.trim(),
    tenders: input.tenders.map(normalizeTender),
    notes: input.notes?.trim() || null,
    receipt_image_url: input.receipt_image_url?.trim() || null,
  };
}

export function buildRecordInvoiceCollectionRpcArgs(
  input: RecordInvoiceCollectionInput,
  idempotencyKey: string,
): RecordInvoiceCollectionRpcArgs {
  const normalized = normalizeCollectionInput(input);
  return {
    p_invoice_id: normalized.invoice_id,
    p_collection_date: normalized.collection_date,
    p_tenders: normalized.tenders as unknown as Json,
    p_overpay_action: normalized.overpay_action,
    p_allow_rounding: normalized.allow_rounding,
    p_notes: normalized.notes ?? null,
    p_receipt_image_url: normalized.receipt_image_url ?? null,
    p_expected_paid_amount: normalized.expected_paid_amount,
    p_idempotency_key: normalizeIdempotencyKey(idempotencyKey),
  };
}

export type CollectionRpcInvoker = (
  fn: "record_invoice_collection_v5",
  args: RecordInvoiceCollectionRpcArgs,
) => PromiseLike<{ data: unknown; error: PaymentRpcError | null }>;

/** New clients are V5-only: every error fails closed after exactly one RPC. */
export async function recordInvoiceCollectionV5(
  rpc: CollectionRpcInvoker,
  input: RecordInvoiceCollectionInput,
  idempotencyKey: string,
): Promise<unknown> {
  const normalizedKey = normalizeIdempotencyKey(idempotencyKey);
  const args = buildRecordInvoiceCollectionRpcArgs(input, normalizedKey);
  const canonical = await rpc("record_invoice_collection_v5", args);
  if (canonical.error) throw canonical.error;
  return canonical.data;
}

export interface InvoiceCollectionPlanningInput extends RecordInvoiceCollectionInput {
  invoice_total_amount: number;
  deposit_due?: number;
  has_contract?: boolean;
}

export interface PlannedInvoiceCollectionTender extends InvoiceCollectionTenderInput {
  line_index: number;
  retained_amount: number;
  applied_amount: number;
  change_amount: number;
  credit_amount: number;
  rounding_amount: number;
  revenue_amount: number;
  deposit_amount: number;
}

export interface InvoiceCollectionPlan {
  gross_amount: number;
  retained_amount: number;
  applied_amount: number;
  change_amount: number;
  credit_amount: number;
  rounding_amount: number;
  remaining_before: number;
  tenders: PlannedInvoiceCollectionTender[];
}

/** Mirrors server allocation rules for fail-fast validation and UI previews. */
export function planInvoiceCollection(
  input: InvoiceCollectionPlanningInput,
): InvoiceCollectionPlan {
  const normalized = normalizeCollectionInput(input);
  if (!isMoney(input.invoice_total_amount, true)) {
    throw new Error("Tổng hóa đơn không hợp lệ");
  }
  const depositDue = input.deposit_due ?? 0;
  if (!isMoney(depositDue, true) || depositDue - input.invoice_total_amount >= 0.01) {
    throw new Error("Dữ liệu cọc của hóa đơn vượt tổng phải thu; cần review kế toán");
  }

  const remaining = Math.max(input.invoice_total_amount - normalized.expected_paid_amount, 0);
  const grossTotal = normalized.tenders.reduce((sum, tender) => sum + tender.gross_amount, 0);
  const tmTotal = normalized.tenders
    .filter((tender) => tender.payment_method === "TM")
    .reduce((sum, tender) => sum + tender.gross_amount, 0);
  const appliedTotal = Math.min(grossTotal, remaining);
  if (appliedTotal <= 0) throw new Error("Hóa đơn không còn số tiền có thể thu");

  const overpay = Math.max(grossTotal - remaining, 0);
  let changeTotal = 0;
  let creditTotal = 0;
  if (overpay > 0) {
    if (normalized.overpay_action === "REFUND") changeTotal = overpay;
    else if (normalized.overpay_action === "CREDIT") {
      if (input.has_contract === false) {
        throw new Error("Không thể giữ credit cho hóa đơn không có hợp đồng");
      }
      creditTotal = overpay;
    } else {
      throw new Error("Số thu vượt còn phải thu; chọn thối lại hoặc giữ credit");
    }
    if (tmTotal < overpay) {
      throw new Error("Phần thu dư phải nằm trong dòng tiền mặt TM");
    }
  } else if (normalized.overpay_action !== "REJECT") {
    throw new Error("Chỉ chọn thối lại hoặc giữ credit khi thực sự có tiền dư");
  }

  const residual = remaining - appliedTotal;
  const roundingTotal = normalized.allow_rounding
    && residual > 0
    && residual < ROUNDING_THRESHOLD
    ? residual
    : 0;
  const revenueDue = Math.max(input.invoice_total_amount - depositDue, 0);
  const depositAfter = Math.max(
    Math.min(depositDue, normalized.expected_paid_amount + appliedTotal - revenueDue),
    0,
  );
  if (roundingTotal > 0 && depositDue - depositAfter >= 0.01) {
    throw new Error("Không được làm tròn bỏ qua phần tiền cọc còn thiếu");
  }

  let remainingApply = appliedTotal;
  let changeLeft = changeTotal;
  let creditLeft = creditTotal;
  let paidCursor = normalized.expected_paid_amount;
  const lastLineIndex = normalized.tenders.length - 1;

  const planned = normalized.tenders.map((tender, lineIndex) => {
    let lineChange = 0;
    let lineCredit = 0;
    if (tender.payment_method === "TM" && (changeLeft > 0 || creditLeft > 0)) {
      const laterTmTotal = normalized.tenders
        .slice(lineIndex + 1)
        .filter((later) => later.payment_method === "TM")
        .reduce((sum, later) => sum + later.gross_amount, 0);
      lineChange = Math.min(tender.gross_amount, Math.max(changeTotal - laterTmTotal, 0));
      lineCredit = Math.min(
        tender.gross_amount - lineChange,
        Math.max(creditTotal - laterTmTotal, 0),
      );
      changeLeft -= lineChange;
      creditLeft -= lineCredit;
    }

    if (lineChange > 0 && !tender.change_account_id) {
      throw new Error("Thiếu sổ quỹ tiền thối");
    }
    const retained = tender.gross_amount - lineChange;
    const applied = Math.min(retained - lineCredit, remainingApply);
    remainingApply -= applied;

    const depositBefore = Math.max(Math.min(depositDue, paidCursor - revenueDue), 0);
    const nextPaidCursor = paidCursor + applied;
    const depositAfterLine = Math.max(Math.min(depositDue, nextPaidCursor - revenueDue), 0);
    const depositAmount = depositAfterLine - depositBefore;
    const revenueAmount = applied - depositAmount;
    paidCursor = nextPaidCursor;

    const lineRounding = lineIndex === lastLineIndex ? roundingTotal : 0;
    if (lineRounding > 0 && !tender.rounding_account_id) {
      throw new Error("Thiếu sổ quỹ làm tròn tiền thiếu");
    }

    return {
      ...tender,
      line_index: lineIndex,
      retained_amount: retained,
      applied_amount: applied,
      change_amount: lineChange,
      credit_amount: lineCredit,
      rounding_amount: lineRounding,
      revenue_amount: revenueAmount,
      deposit_amount: depositAmount,
    };
  });

  if (
    Math.abs(remainingApply) >= 0.01
    || Math.abs(changeLeft) >= 0.01
    || Math.abs(creditLeft) >= 0.01
  ) {
    throw new Error("Phân bổ collection không cân bằng");
  }

  return {
    gross_amount: grossTotal,
    retained_amount: grossTotal - changeTotal,
    applied_amount: appliedTotal,
    change_amount: changeTotal,
    credit_amount: creditTotal,
    rounding_amount: roundingTotal,
    remaining_before: remaining,
    tenders: planned,
  };
}

export function deriveInvoiceDepositDue(invoice: {
  invoice_items?: unknown;
  previous_debt_sources?: unknown;
}): number {
  const items = Array.isArray(invoice.invoice_items) ? invoice.invoice_items : [];
  const itemDeposit = (items as Array<Record<string, unknown>>).reduce((sum, item) => {
    const isDeposit = item.accounting_class === "DEPOSIT"
      || (
        item.type === "OTHER"
        && typeof item.description === "string"
        && item.description.trim().toLowerCase() === "tiền cọc"
      );
    return isDeposit ? sum + (Number(item.amount) || 0) : sum;
  }, 0);
  const sources = Array.isArray(invoice.previous_debt_sources)
    ? invoice.previous_debt_sources
    : [];
  const previousDeposit = (sources as Array<Record<string, unknown>>).reduce(
    (sum, source) => source.type === "deposit" ? sum + (Number(source.amount) || 0) : sum,
    0,
  );
  return Math.max(itemDeposit + previousDeposit, 0);
}

export interface ReverseInvoicePaymentInput {
  payment_id?: string | null;
  collection_id?: string | null;
  reversal_date: string;
  reason: string;
  idempotency_key: string;
}

export type ReversePaymentRpcInvoker = (
  fn: "reverse_invoice_collection_v5" | "reverse_invoice_payment_v3",
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: PaymentRpcError | null }>;

export async function reverseInvoicePaymentBySource(
  rpc: ReversePaymentRpcInvoker,
  input: ReverseInvoicePaymentInput,
): Promise<{ result: unknown; source: "COLLECTION" | "LEGACY_PAYMENT" }> {
  const key = normalizeIdempotencyKey(input.idempotency_key);
  const reason = input.reason.trim();
  if (!input.reversal_date || reason.length < 8 || reason.length > 1000) {
    throw new Error("Ngày hoàn tác hoặc lý do 8-1000 ký tự không hợp lệ");
  }

  const collectionId = input.collection_id?.trim() || null;
  const paymentId = input.payment_id?.trim() || null;
  if (!collectionId && !paymentId) {
    throw new Error("Nguồn hoàn tác không hợp lệ: cần collection_id hoặc payment_id legacy");
  }

  const source = collectionId ? "COLLECTION" : "LEGACY_PAYMENT";
  const response = collectionId
    ? await rpc("reverse_invoice_collection_v5", {
        p_collection_id: collectionId,
        p_reversal_date: input.reversal_date,
        p_reason: reason,
        p_idempotency_key: key,
      })
    : await rpc("reverse_invoice_payment_v3", {
        p_payment_id: paymentId,
        p_reason: reason,
        p_idempotency_key: key,
      });
  if (response.error) throw response.error;
  return { result: response.data, source };
}
