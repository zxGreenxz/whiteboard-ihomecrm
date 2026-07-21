const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;

export type CustomerCreditMutationKind =
  | "invoice-create"
  | "contract-forfeit"
  | "contract-move-out"
  | "invoice-cancel"
  | "invoice-delete"
  | "invoice-bulk-delete"
  | "invoice-force-cancel"
  | "invoice-restore";

export type CustomerCreditRpcName =
  | "create_invoice_with_credit_v1"
  | "terminate_contract_forfeit_with_credit_v1"
  | "terminate_contract_move_out_with_credit_v1"
  | "cancel_invoice_with_credit_v1"
  | "soft_delete_invoice_with_credit_v1"
  | "bulk_soft_delete_invoices_with_credit_v1"
  | "super_admin_force_cancel_invoice_with_credit_v1"
  | "restore_invoice_with_credit_v1";

export interface CustomerCreditRpcError {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
}

export interface PreparedCustomerCreditRequest {
  idempotencyKey: string;
}

export type CustomerCreditRpcInvoker = (
  fn: CustomerCreditRpcName,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: CustomerCreditRpcError | null }>;

const KEY_PREFIX: Record<CustomerCreditMutationKind, string> = {
  "invoice-create": "invoice-credit-create",
  "contract-forfeit": "contract-credit-forfeit",
  "contract-move-out": "contract-credit-moveout",
  "invoice-cancel": "invoice-credit-cancel",
  "invoice-delete": "invoice-credit-delete",
  "invoice-bulk-delete": "invoice-credit-bulk-delete",
  "invoice-force-cancel": "invoice-credit-force-cancel",
  "invoice-restore": "invoice-credit-restore",
};

function normalizeIdempotencyKey(value: string): string {
  const key = value.trim();
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new Error(
      "idempotency_key must be 8 to 200 ASCII characters using A-Z, a-z, 0-9, ., _, :, or -",
    );
  }
  return key;
}

function requirePositiveMoney(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be positive`);
  }
  const rounded = Math.round(value * 100) / 100;
  if (rounded <= 0 || Math.abs(rounded - value) >= 1e-6) {
    throw new Error(`${field} must use at most two decimal places`);
  }
  return rounded;
}

/** Prepare once for a mutation submission so every retry reuses one key. */
export function prepareCustomerCreditRequest(
  kind: CustomerCreditMutationKind,
  idempotencyKey = `${KEY_PREFIX[kind]}-${globalThis.crypto.randomUUID()}`,
): PreparedCustomerCreditRequest {
  return { idempotencyKey: normalizeIdempotencyKey(idempotencyKey) };
}

export function selectInvoiceCreateRpc(appliedCredit: number):
  | "create_invoice_v1"
  | "create_invoice_with_credit_v1" {
  if (!Number.isFinite(appliedCredit) || appliedCredit < 0) {
    throw new Error("applied_credit cannot be negative");
  }
  return appliedCredit > 0
    ? "create_invoice_with_credit_v1"
    : "create_invoice_v1";
}

export function buildCreditInvoiceCreateRpcArgs(
  baseArgs: Record<string, unknown>,
  appliedCredit: number,
  request: PreparedCustomerCreditRequest,
): Record<string, unknown> {
  const normalizedCredit = requirePositiveMoney(appliedCredit, "applied_credit");
  const totalDiscount = Number(baseArgs.p_discount_amount);
  if (!Number.isFinite(totalDiscount) || totalDiscount < normalizedCredit) {
    throw new Error("discount_amount must include the full applied_credit component");
  }
  const nonCreditDiscount = Math.round((totalDiscount - normalizedCredit) * 100) / 100;
  return {
    ...baseArgs,
    p_applied_credit: normalizedCredit,
    p_non_credit_discount_amount: nonCreditDiscount,
    p_idempotency_key: normalizeIdempotencyKey(request.idempotencyKey),
  };
}

export function buildForfeitWithCreditRpcArgs(
  input: {
    contractId: string;
    forfeitDate: string;
    extraCharges?: unknown[];
  },
  request: PreparedCustomerCreditRequest,
): Record<string, unknown> {
  return {
    p_contract_id: input.contractId,
    p_forfeit_date: input.forfeitDate,
    p_extra_charges: input.extraCharges ?? [],
    p_idempotency_key: normalizeIdempotencyKey(request.idempotencyKey),
  };
}

export function buildMoveOutWithCreditRpcArgs(
  input: {
    contractId: string;
    moveOutDate: string;
    depositRefund: number;
    penaltyFee?: number;
    excessRent?: number;
    outstandingDebt?: number;
    notes?: string;
    extraCharges?: unknown[];
    shortfallMode?: "PAID" | "DEBT";
    receiptAccountId?: string | null;
  },
  request: PreparedCustomerCreditRequest,
): Record<string, unknown> {
  return {
    p_contract_id: input.contractId,
    p_move_out_date: input.moveOutDate,
    p_deposit_refund: input.depositRefund,
    p_penalty_fee: input.penaltyFee ?? 0,
    p_excess_rent: input.excessRent ?? 0,
    p_outstanding_debt: input.outstandingDebt ?? 0,
    p_notes: input.notes ?? null,
    p_extra_charges: input.extraCharges ?? [],
    p_shortfall_mode: input.shortfallMode ?? "PAID",
    p_receipt_account_id: input.receiptAccountId ?? null,
    p_idempotency_key: normalizeIdempotencyKey(request.idempotencyKey),
  };
}

export function buildInvoiceCreditLifecycleRpcArgs(
  invoiceId: string,
  request: PreparedCustomerCreditRequest,
): Record<string, unknown> {
  return {
    p_invoice_id: invoiceId,
    p_idempotency_key: normalizeIdempotencyKey(request.idempotencyKey),
  };
}

export function buildBulkInvoiceCreditLifecycleRpcArgs(
  invoiceIds: string[],
  request: PreparedCustomerCreditRequest,
): Record<string, unknown> {
  return {
    p_invoice_ids: [...invoiceIds],
    p_idempotency_key: normalizeIdempotencyKey(request.idempotencyKey),
  };
}

/** Credit lifecycle writes are canonical-only: every RPC error fails closed. */
export async function invokeCustomerCreditRpc(
  rpc: CustomerCreditRpcInvoker,
  fn: CustomerCreditRpcName,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = await rpc(fn, args);
  if (result.error) throw result.error;
  return result.data;
}
