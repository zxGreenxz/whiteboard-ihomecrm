import type { Json } from "@/integrations/supabase/types";
import type { Contract, PaymentCycle } from "@/types/contract";
import {
  normalizeDateOnly,
  normalizeFirstBillingPeriod,
  type FirstInvoiceAccountingClass,
  type FirstInvoiceItemType,
} from "@/lib/firstInvoiceBuilder";

export interface ContractCreateContractInput {
  room_id: string;
  signed_date: string;
  start_date: string;
  end_date: string;
  rent_price: number;
  total_deposit: number;
  payment_cycle: PaymentCycle;
  start_billing_date?: string | null;
  end_billing_date?: string | null;
  contract_template_id?: string | null;
  invoice_template_id?: string | null;
  notes?: string | null;
  discounts?: { months: number; amount_per_month: number } | null;
  deposit_debt_mode?: "DEBT" | "FIRST_INVOICE" | null;
  deposit_debt_reason?: string | null;
  deposit_topup_due_date?: string | null;
}

export interface ContractCreateCustomerInput {
  customer_id: string;
  is_representative: boolean;
  notes?: string | null;
}

export interface ContractCreateServiceInput {
  service_id: string;
  unit_price: number;
  initial_reading?: number | null;
}

export interface ContractCreateDepositReceiptInput {
  amount: number;
  account_id?: string | null;
  received_date?: string | null;
  attachments?: string[];
  creator_name?: string | null;
}

export interface ContractCreateFirstInvoiceItemInput {
  type: FirstInvoiceItemType;
  accounting_class: FirstInvoiceAccountingClass;
  description: string;
  unit_price: number;
  quantity: number;
  service_id?: string | null;
  from_date?: string | null;
  to_date?: string | null;
}

export interface ContractCreateFirstInvoiceInput {
  items: ContractCreateFirstInvoiceItemInput[];
  discount_amount?: number;
  discount_notes?: string | null;
  issue_date?: string | null;
  due_date?: string | null;
  notes?: string | null;
}

export interface ContractCreatePayload {
  contract: ContractCreateContractInput;
  customers: ContractCreateCustomerInput[];
  services: ContractCreateServiceInput[];
  deposit_receipts?: ContractCreateDepositReceiptInput[];
  existing_deposit_voucher_ids?: string[];
  first_invoice?: ContractCreateFirstInvoiceInput | null;
}

export interface ContractCreateRequest {
  payload: ContractCreatePayload;
  idempotencyKey: string;
}

export type CreateContractPayload = ContractCreatePayload;
export type CreateContractRequest = ContractCreateRequest;

export interface CreateContractV2RpcArgs {
  p_payload: Json;
  p_idempotency_key: string;
}

export interface CreateContractV2Response {
  contract: Contract;
  invoice: Json | null;
  deposit_paid: number;
  deposit_shortfall: number;
}

export interface ContractCreateRpcError {
  code?: string | null;
  message?: string | null;
}

export type ContractCreateRpcInvoker = (
  fn: "create_contract_v2",
  args: CreateContractV2RpcArgs,
) => PromiseLike<{ data: unknown; error: ContractCreateRpcError | null }>;

export const CONTRACT_DEPOSIT_TOLERANCE = 0.01;

export interface ContractDepositBalance {
  shortfall: number;
  overpayment: number;
  requiresResolution: boolean;
  isOverpaid: boolean;
}

export function calculateContractDepositBalance(
  totalDeposit: number,
  depositReceived: number,
): ContractDepositBalance {
  const shortfall = Math.max(0, totalDeposit - depositReceived);
  const overpayment = Math.max(0, depositReceived - totalDeposit);
  return {
    shortfall,
    overpayment,
    requiresResolution: shortfall >= CONTRACT_DEPOSIT_TOLERANCE,
    isOverpaid: overpayment >= CONTRACT_DEPOSIT_TOLERANCE,
  };
}

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;

function normalizeIdempotencyKey(value: string): string {
  const key = value.trim();
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new Error(
      "idempotency_key must be 8 to 200 ASCII characters using A-Z, a-z, 0-9, ., _, :, or -",
    );
  }
  return key;
}

function requiredDateOnly(value: string, field: string): string {
  const normalized = normalizeDateOnly(value);
  if (!normalized) throw new Error(`${field} must be a valid ISO date`);
  return normalized;
}

function optionalDateOnly(
  value: string | null | undefined,
  field: string,
): string | null {
  if (!value) return null;
  const normalized = normalizeDateOnly(value);
  if (!normalized) throw new Error(`${field} must be a valid ISO date`);
  return normalized;
}

/** Prepare once per user submission; retries reuse the returned key. */
export function prepareContractCreateRequest(
  payload: ContractCreatePayload,
  idempotencyKey = `contract-create-${globalThis.crypto.randomUUID()}`,
): ContractCreateRequest {
  return {
    payload,
    idempotencyKey: normalizeIdempotencyKey(idempotencyKey),
  };
}

/** Build the exact create_contract_v2 argument object without routing a write. */
export function buildCreateContractRpcArgs(
  request: ContractCreateRequest,
): CreateContractV2RpcArgs {
  const { payload } = request;
  const startDate = requiredDateOnly(payload.contract.start_date, "start_date");
  const endDate = requiredDateOnly(payload.contract.end_date, "end_date");
  const signedDate = payload.contract.signed_date
    ? requiredDateOnly(payload.contract.signed_date, "signed_date")
    : startDate;
  const billingPeriod = normalizeFirstBillingPeriod(
    optionalDateOnly(
      payload.contract.start_billing_date,
      "start_billing_date",
    ),
    optionalDateOnly(payload.contract.end_billing_date, "end_billing_date"),
    startDate,
  );

  const rpcPayload: Record<string, unknown> = {
    contract: {
      room_id: payload.contract.room_id,
      signed_date: signedDate,
      start_date: startDate,
      end_date: endDate,
      rent_price: payload.contract.rent_price,
      total_deposit: payload.contract.total_deposit,
      payment_cycle: payload.contract.payment_cycle,
      start_billing_date: billingPeriod.start_date,
      end_billing_date: billingPeriod.end_date,
      contract_template_id: payload.contract.contract_template_id ?? null,
      invoice_template_id: payload.contract.invoice_template_id ?? null,
      notes: payload.contract.notes?.trim() || null,
      discounts: payload.contract.discounts ?? [],
      deposit_debt_mode: payload.contract.deposit_debt_mode ?? null,
      deposit_debt_reason: payload.contract.deposit_debt_reason?.trim() || null,
      deposit_topup_due_date:
        optionalDateOnly(
          payload.contract.deposit_topup_due_date,
          "deposit_topup_due_date",
        ) ?? null,
    },
    customers: payload.customers.map((customer) => ({
      customer_id: customer.customer_id,
      is_representative: customer.is_representative,
      notes: customer.notes?.trim() || null,
    })),
    services: payload.services.map((service) => ({
      service_id: service.service_id,
      unit_price: service.unit_price,
      initial_reading: service.initial_reading ?? null,
    })),
    deposit_receipts: (payload.deposit_receipts ?? []).map((receipt) => ({
      amount: receipt.amount,
      account_id: receipt.account_id || null,
      received_date:
        optionalDateOnly(receipt.received_date, "deposit_receipt.received_date") ??
        signedDate,
      attachments: [...(receipt.attachments ?? [])],
      creator_name: receipt.creator_name?.trim() || null,
    })),
    existing_deposit_voucher_ids: [...(payload.existing_deposit_voucher_ids ?? [])],
  };

  if (payload.first_invoice) {
    rpcPayload.first_invoice = {
      items: payload.first_invoice.items.map((item) => ({
        type: item.type,
        accounting_class: item.accounting_class,
        description: item.description,
        unit_price: item.unit_price,
        quantity: item.quantity,
        service_id: item.service_id ?? null,
        from_date:
          optionalDateOnly(item.from_date, "first_invoice.item.from_date") ?? null,
        to_date:
          optionalDateOnly(item.to_date, "first_invoice.item.to_date") ?? null,
      })),
      discount_amount: Math.max(0, payload.first_invoice.discount_amount ?? 0),
      discount_notes: payload.first_invoice.discount_notes?.trim() || null,
      issue_date:
        optionalDateOnly(payload.first_invoice.issue_date, "first_invoice.issue_date") ??
        null,
      due_date:
        optionalDateOnly(payload.first_invoice.due_date, "first_invoice.due_date") ??
        billingPeriod.end_date,
      notes: payload.first_invoice.notes?.trim() || null,
    };
  }

  return {
    p_payload: rpcPayload as unknown as Json,
    p_idempotency_key: normalizeIdempotencyKey(request.idempotencyKey),
  };
}

export async function createContractV2(
  rpc: ContractCreateRpcInvoker,
  request: ContractCreateRequest,
): Promise<CreateContractV2Response> {
  const args = buildCreateContractRpcArgs(request);
  const result = await rpc("create_contract_v2", args);
  if (result.error) throw result.error;

  const data = result.data as Partial<CreateContractV2Response> | null;
  if (!data?.contract?.id) {
    throw new Error("create_contract_v2 returned an invalid response");
  }
  return data as CreateContractV2Response;
}
