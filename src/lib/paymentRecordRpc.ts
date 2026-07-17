import type { Database, Json } from "@/integrations/supabase/types";

type PaymentMethod = Database["public"]["Enums"]["payment_method"];

/**
 * v3 và v4 chia sẻ đúng 12 tham số (bề mặt 1:1) — cùng một object args dùng cho
 * cả hai route. Nguồn chuẩn: scripts/authz-prepared/t1b_01_record_payment_v4.sql
 * và generated types của record_invoice_payment_v3.
 */
export interface RecordInvoicePaymentRpcArgs {
  p_invoice_id: string;
  p_amount: number;
  p_payment_method: PaymentMethod;
  p_payment_date: string;
  p_idempotency_key: string;
  p_account_id: string | null;
  p_notes: string | null;
  p_receipt_image_url: string | null;
  p_voucher: Json | null;
  p_items: Json | null;
  p_receipt_number: string | null;
  p_voucher_owner_id: string | null;
}

export interface RecordInvoicePaymentInput {
  invoice_id: string;
  amount: number;
  payment_method: PaymentMethod;
  payment_date: string;
  account_id?: string | null;
  notes?: string | null;
  receipt_image_url?: string | null;
  receipt_number?: string | null;
  voucher?: Json | null;
  items?: Json | null;
  voucher_owner_id?: string | null;
}

/**
 * Build exact args cho record_invoice_payment v4/v3 mà KHÔNG route một write nào.
 * Key phải khớp ràng buộc ledger canonical_write_operations (ASCII 8–200).
 */
export function buildRecordInvoicePaymentRpcArgs(
  input: RecordInvoicePaymentInput,
  idempotencyKey: string,
): RecordInvoicePaymentRpcArgs {
  const normalizedIdempotencyKey = idempotencyKey.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(normalizedIdempotencyKey)) {
    throw new Error(
      "idempotency_key must be 8 to 200 ASCII characters using A-Z, a-z, 0-9, ., _, :, or -",
    );
  }
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new Error("amount phải là số dương hữu hạn");
  }

  return {
    p_invoice_id: input.invoice_id,
    p_amount: input.amount,
    p_payment_method: input.payment_method,
    p_payment_date: input.payment_date,
    p_idempotency_key: normalizedIdempotencyKey,
    p_account_id: input.account_id ?? null,
    p_notes: input.notes ?? null,
    p_receipt_image_url: input.receipt_image_url ?? null,
    p_voucher: input.voucher ?? null,
    p_items: input.items ?? null,
    p_receipt_number: input.receipt_number ?? null,
    p_voucher_owner_id: input.voucher_owner_id ?? null,
  };
}

export interface PaymentRpcError {
  code?: string | null;
  message?: string | null;
}

export type PaymentWriterRoute = "CANONICAL" | "LEGACY";

export type LegacyFallbackReason =
  | "writer-not-deployed" // PGRST202: v4 chưa có trong schema cache (chưa apply)
  | "writer-disabled" // 55000 "chưa bật": rollout OFF/không canary cho org này
  | "v4-denied"; // 42501: coexistence — v3 vẫn là authority cho tới T7 drain

/**
 * Phân loại lỗi v4 thành tín hiệu fallback hợp lệ, hoặc null = PHẢI throw.
 *
 * - 55000 chỉ fallback khi đúng thông điệp rollout "chưa bật"; 55000 khác
 *   (ví dụ bất thường ledger idempotency) là lỗi thật, không được nuốt.
 * - 42501 fallback CÓ CHỦ ĐÍCH trong giai đoạn coexistence: siết quyền chỉ
 *   diễn ra ở bước drain/revoke (T7) theo kế hoạch cutover, không phải lúc
 *   deploy adapter. Reason được trả ra để hook ghi telemetry mismatch.
 * - 23505 (kể cả guard "đã dùng ở đường legacy") KHÔNG BAO GIỜ fallback —
 *   retry vắt qua thời điểm flip mà fallback sẽ double-pay.
 */
export function classifyV4FallbackSignal(
  error: PaymentRpcError,
): LegacyFallbackReason | null {
  if (error.code === "PGRST202") return "writer-not-deployed";
  if (error.code === "55000" && (error.message ?? "").includes("chưa bật")) {
    return "writer-disabled";
  }
  if (error.code === "42501") return "v4-denied";
  return null;
}

export type PaymentRpcInvoker = (
  fn: "record_invoice_payment_v4" | "record_invoice_payment_v3",
  args: RecordInvoicePaymentRpcArgs,
) => PromiseLike<{ data: unknown; error: PaymentRpcError | null }>;

export interface RecordInvoicePaymentOutcome {
  result: unknown;
  route: PaymentWriterRoute;
  legacyReason?: LegacyFallbackReason;
}

/**
 * Gọi v4 trước; fallback v3 CHỈ theo classifyV4FallbackSignal. Server quyết
 * định route theo org (evaluate_feature_route) — client không tự chọn.
 */
export async function recordInvoicePaymentWithFallback(
  rpc: PaymentRpcInvoker,
  input: RecordInvoicePaymentInput,
  idempotencyKey: string,
): Promise<RecordInvoicePaymentOutcome> {
  const args = buildRecordInvoicePaymentRpcArgs(input, idempotencyKey);

  const v4 = await rpc("record_invoice_payment_v4", args);
  if (!v4.error) {
    return { result: v4.data, route: "CANONICAL" };
  }

  const legacyReason = classifyV4FallbackSignal(v4.error);
  if (!legacyReason) {
    throw v4.error;
  }

  const v3 = await rpc("record_invoice_payment_v3", args);
  if (v3.error) {
    throw v3.error;
  }
  return { result: v3.data, route: "LEGACY", legacyReason };
}
