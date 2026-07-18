import type { IncomeExpenseFormValues } from "./incomeExpenseValidation";

export interface CreateIncomeExpenseV1RpcItem {
  income_expense_type_id: string;
  description: string | null;
  quantity: number;
  unit_price: number;
  start_date: string;
  end_date: string;
}

export type CanonicalIncomeExpenseDraftValues = Omit<
  IncomeExpenseFormValues,
  "account_id"
> & {
  account_id: string | null;
};

export interface CreateIncomeExpenseV1RpcArgs {
  p_type: IncomeExpenseFormValues["type"];
  p_name: string;
  p_building_id: string;
  p_room_id: string | null;
  p_tenant_id: string | null;
  p_contract_id: string | null;
  p_payer_name: string | null;
  p_receive_bank_account: string | null;
  p_receive_bank_name: string | null;
  p_account_id: string | null;
  p_attachments: string[];
  p_business_result_accounting: boolean | null;
  p_notes: null;
  p_voucher_date: string;
  p_items: CreateIncomeExpenseV1RpcItem[];
  p_idempotency_key: string;
}

/**
 * Build the exact create_income_expense_v1 argument object without routing a write.
 * The canonical draft writer intentionally supports non-recurring vouchers only.
 */
export function buildCreateIncomeExpenseRpcArgs(
  values: CanonicalIncomeExpenseDraftValues,
  idempotencyKey: string,
): CreateIncomeExpenseV1RpcArgs {
  const repeatCycle = values.repeat_cycle ?? "NONE";
  const repeatInfinity = values.repeat_infinity ?? false;
  const repeatCount = values.repeat_count ?? 0;

  if (repeatCycle !== "NONE" || repeatInfinity || repeatCount !== 0) {
    throw new Error("create_income_expense_v1 does not support recurring vouchers");
  }

  const normalizedIdempotencyKey = idempotencyKey.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(normalizedIdempotencyKey)) {
    throw new Error(
      "idempotency_key must be 8 to 200 ASCII characters using A-Z, a-z, 0-9, ., _, :, or -",
    );
  }

  return {
    p_type: values.type,
    p_name: values.name,
    p_building_id: values.building_id,
    p_room_id: values.room_id ?? null,
    p_tenant_id: values.tenant_id ?? null,
    p_contract_id: values.contract_id ?? null,
    p_payer_name: values.payer_name ?? null,
    p_receive_bank_account: values.receive_bank_account ?? null,
    p_receive_bank_name: values.receive_bank_name ?? null,
    p_account_id: values.account_id || null,
    p_attachments: [...values.attachments],
    p_business_result_accounting: values.business_result_accounting ?? null,
    p_notes: null,
    p_voucher_date: values.voucher_date,
    p_items: values.items.map((item) => ({
      income_expense_type_id: item.income_expense_type_id,
      description: item.description ?? null,
      quantity: item.quantity,
      unit_price: item.unit_price,
      start_date: item.start_date,
      end_date: item.end_date,
    })),
    p_idempotency_key: normalizedIdempotencyKey,
  };
}
