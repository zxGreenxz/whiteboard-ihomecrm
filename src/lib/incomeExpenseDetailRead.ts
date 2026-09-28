import { z } from "zod";
import type { IncomeExpenseWithRelations } from "@/hooks/income-expenses/types";
const uuid = z.string().uuid();
const nullableText = z.string().nullable();
const amount = z
  .union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/)])
  .transform(Number)
  .pipe(z.number().finite());
const headerSchema = z.object({
  id: uuid,
  organization_id: uuid,
  user_id: uuid,
  building_id: uuid.nullable(),
  code: z
    .string()
    .nullable()
    .transform((value) => value ?? ""),
  type: z.enum(["INCOME", "EXPENSE"]),
  name: z.string(),
  voucher_date: z.string(),
  total_amount: amount,
  kqkd_amount: amount,
  approval_status: z.enum(["UNAPPROVED", "APPROVED", "CANCELLED"]),
  approval_version: z.number().int().positive(),
  posting_version: z.number().int().positive(),
  created_at: z.string(),
  updated_at: z.string(),
  posting_mode: z.enum(["CASHBOOK", "NON_CASH"]).nullable(),
  posting_status: z
    .enum(["UNPOSTED", "POSTED", "REVERSED", "NOT_APPLICABLE"])
    .nullable(),
  review_state: z
    .enum(["PENDING", "CHANGES_REQUESTED", "DISPUTED", "RESOLVED"])
    .nullable(),
  room_id: nullableText,
  tenant_id: nullableText,
  approved_by: nullableText,
  approved_at: nullableText,
  notes: nullableText,
  payer_name: nullableText,
  account_id: nullableText,
  system_source: nullableText,
  shareholder_id: nullableText,
  contract_id: nullableText,
  invoice_id: nullableText,
  commission_kind: z.enum(["broker", "sale"]).nullable(),
  attachments: z.array(z.string()),
  business_result_accounting: z.boolean().nullable(),
  counts_in_business_result: z.boolean(),
  receive_bank_name: nullableText,
  receive_bank_account: nullableText,
  creator_name: nullableText,
  repeat_cycle: z.enum(["NONE", "WEEK", "MONTH", "QUARTER", "YEAR"]).nullable(),
  repeat_infinity: z.boolean(),
  repeat_count: z.number(),
  repeat_remaining: z.number(),
  repeat_next_date: nullableText,
  repeat_parent_id: nullableText,
  verified_at: nullableText,
  verified_by: nullableText,
  verified_by_name: nullableText,
  verified_note: nullableText,
  reversal_of_income_expense_id: nullableText,
});
const itemSchema = z.object({
  id: uuid,
  income_expense_id: uuid,
  organization_id: uuid,
  income_expense_type_id: uuid,
  type_name: z.string(),
  category: z.string().nullable(),
  is_deposit: z.boolean(),
  description: z.string().nullable(),
  quantity: amount,
  unit_price: amount,
  amount,
  start_date: z.string().nullable(),
  end_date: z.string().nullable(),
  accounting_class: z.string().nullable().optional(),
});
const responseSchema = z.object({
  rows: z.array(
    z.object({
      header: headerSchema,
      items: z.array(itemSchema),
      building_name: z.string().nullable(),
      expected_item_count: z.number().int().nonnegative(),
      items_complete: z.boolean(),
      issues: z.array(z.string()),
    }),
  ),
});
export type IncomeExpenseDetailRpc = (
  name: "read_income_expense_details_v1",
  args: { p_organization_id: string; p_voucher_ids: string[] },
) => PromiseLike<{ data: unknown; error: unknown }>;
export function hasCompleteVoucherDetail(
  v:
    | {
        items?: unknown[];
        detail_read?: { complete: boolean; expected_item_count: number };
      }
    | null
    | undefined,
): boolean {
  return (
    !!v?.detail_read?.complete &&
    v.detail_read.expected_item_count === v.items?.length
  );
}
/** Read one snapshot of each parent and its entire item collection. Never infer zero from a failed read. */
export async function readIncomeExpenseDetails(
  rpc: IncomeExpenseDetailRpc,
  organizationId: string,
  voucherIds: string[],
): Promise<IncomeExpenseWithRelations[]> {
  uuid.parse(organizationId);
  const ids = z.array(uuid).parse(voucherIds);
  const unique = [...new Set(ids)];
  const result = new Map<string, IncomeExpenseWithRelations>();
  for (let start = 0; start < unique.length; start += 200) {
    const chunk = unique.slice(start, start + 200);
    const response = await rpc("read_income_expense_details_v1", {
      p_organization_id: organizationId,
      p_voucher_ids: chunk,
    });
    if (response.error) throw response.error;
    const parsed = responseSchema.safeParse(response.data);
    if (!parsed.success)
      throw new Error(
        "Không tải được đầy đủ chi tiết phiếu. Vui lòng thử lại.",
      );
    for (const row of parsed.data.rows) {
      const h = row.header;
      if (
        !chunk.includes(h.id) ||
        result.has(h.id) ||
        h.organization_id !== organizationId ||
        !row.items_complete ||
        row.issues.length ||
        row.expected_item_count !== row.items.length ||
        (h.building_id !== null && !row.building_name) ||
        new Set(row.items.map((i) => i.id)).size !== row.items.length ||
        row.items.some(
          (i) =>
            i.income_expense_id !== h.id ||
            i.organization_id !== organizationId,
        )
      )
        throw new Error("Chi tiết phiếu chưa đầy đủ. Vui lòng tải lại.");
      result.set(h.id, {
        ...h,
        id: h.id,
        organization_id: h.organization_id,
        user_id: h.user_id,
        building_id: h.building_id,
        code: h.code,
        type: h.type,
        name: h.name,
        voucher_date: h.voucher_date,
        total_amount: h.total_amount,
        kqkd_amount: h.kqkd_amount,
        approval_status: h.approval_status,
        approval_version: h.approval_version,
        posting_version: h.posting_version,
        created_at: h.created_at,
        updated_at: h.updated_at,
        posting_mode: h.posting_mode,
        posting_status: h.posting_status,
        review_state: h.review_state,
        room_id: h.room_id,
        tenant_id: h.tenant_id,
        approved_by: h.approved_by,
        approved_at: h.approved_at,
        notes: h.notes,
        payer_name: h.payer_name,
        account_id: h.account_id,
        system_source: h.system_source,
        shareholder_id: h.shareholder_id,
        contract_id: h.contract_id,
        invoice_id: h.invoice_id,
        commission_kind: h.commission_kind,
        attachments: h.attachments,
        business_result_accounting: h.business_result_accounting,
        counts_in_business_result: h.counts_in_business_result,
        receive_bank_name: h.receive_bank_name,
        receive_bank_account: h.receive_bank_account,
        creator_name: h.creator_name,
        repeat_cycle: h.repeat_cycle,
        repeat_infinity: h.repeat_infinity,
        repeat_count: h.repeat_count,
        repeat_remaining: h.repeat_remaining,
        repeat_next_date: h.repeat_next_date,
        repeat_parent_id: h.repeat_parent_id,
        verified_at: h.verified_at,
        verified_by: h.verified_by,
        verified_by_name: h.verified_by_name,
        verified_note: h.verified_note,
        building_name: row.building_name ?? "",
        room_name: null,
        tenant_name: null,
        account_name: null,
        account_is_virtual: null,
        items: row.items.map((i) => ({
          id: i.id,
          income_expense_id: i.income_expense_id,
          income_expense_type_id: i.income_expense_type_id,
          type_name: i.type_name,
          category: i.category,
          is_deposit: i.is_deposit,
          description: i.description,
          quantity: i.quantity,
          unit_price: i.unit_price,
          amount: i.amount,
          start_date: i.start_date,
          end_date: i.end_date,
          accounting_class: i.accounting_class,
        })),
        detail_read: {
          complete: true,
          expected_item_count: row.expected_item_count,
        },
      });
    }
    if (chunk.some((id) => !result.has(id)))
      throw new Error(
        "Phiếu không còn khả dụng hoặc bạn không còn quyền xem. Vui lòng tải lại.",
      );
  }
  return ids.map((id) => result.get(id)!);
}
