import { supabase } from "@/integrations/supabase/client";
import { readIncomeExpenseActionSnapshotPage } from "@/hooks/income-expenses/useIncomeExpenseActionSnapshots";
import { readActionSnapshotBatches } from "./incomeExpenseActionSnapshot";
import {
  type CreatableSettlementSourceRef,
  type SettlementCreatePorts,
  type SettlementRefundCreateArgs,
  settlementCreateSourceId,
  SettlementCreateError,
} from "./contractSettlementCreate";
import {
  parseSettlementCreateSource,
  parseSettlementRefundPreview,
  parseSettlementSaleProposals,
} from "./contractSettlementCreateReader";
type SourceRpc = (
  name: "read_contract_settlement_create_source_v1",
  args: {
    p_organization_id: string;
    p_kind: string;
    p_source_id: string;
    p_proposed_amount: number | null;
  },
) => PromiseLike<{
  data: unknown;
  error: { message: string; code?: string } | null;
}>;
type RefundRecipientRpc = (
  name: "create_termination_refund_voucher_v1",
  args: SettlementRefundCreateArgs,
) => PromiseLike<{
  data: unknown;
  error: { message: string; code?: string } | null;
}>;
const value = <T>(result: {
  data: T;
  error: { message: string; code?: string } | null;
}): T => {
  if (result.error)
    throw Object.assign(new Error(result.error.message), {
      code: result.error.code,
    });
  return result.data;
};
export function settlementCreateRepository(
  actorId: string,
  organizationId: string,
): SettlementCreatePorts {
  const repository: SettlementCreatePorts = {
    readSource: async (ref: CreatableSettlementSourceRef, amount?: number) => {
      if (ref.organizationId !== organizationId)
        throw new SettlementCreateError(
          "blocked",
          "Tổ chức của nguồn đã thay đổi.",
        );
      return parseSettlementCreateSource(
        value(
          await (supabase.rpc as unknown as SourceRpc)(
            "read_contract_settlement_create_source_v1",
            {
              p_organization_id: organizationId,
              p_kind: ref.kind,
              p_source_id: settlementCreateSourceId(ref),
              p_proposed_amount: amount ?? null,
            },
          ),
        ),
        ref,
        actorId,
      );
    },
    readVoucher: async (id: string) => {
      const batch = await readActionSnapshotBatches(
        { actorId, organizationId },
        [id],
        readIncomeExpenseActionSnapshotPage,
      );
      const row = batch.rows[id];
      if (!row)
        throw new SettlementCreateError(
          "unconfirmed",
          "Chưa đọc được phiếu vừa lập.",
        );
      return row;
    },
    createCommission: async (args) =>
      value(await supabase.rpc("create_commission_voucher", args)),
    createDeposit: async (args) =>
      value(await supabase.rpc("create_sale_bonus_from_deposit_v1", args)),
    previewRefund: async (id) =>
      parseSettlementRefundPreview(
        value(
          await supabase.rpc("preview_termination_refund_v1", {
            p_termination_id: id,
          }),
        ),
      ),
    recordObligation: async (id) =>
      value(
        await supabase.rpc("record_termination_refund_obligation_v1", {
          p_termination_id: id,
        }),
      ),
    readObligation: async (id, ref) => {
      const source = await repository.readSource(ref);
      if (!source.latestObligation || source.latestObligation.id !== id)
        throw new SettlementCreateError(
          "conflict",
          "Phiên bản nghĩa vụ hoàn vừa thay đổi. Tải lại để đối chiếu trước khi lập phiếu.",
        );
      return source.latestObligation;
    },
    createRefund: async (args) =>
      value(
        await (supabase.rpc as unknown as RefundRecipientRpc)(
          "create_termination_refund_voucher_v1",
          args,
        ),
      ),
  };
  return repository;
}
/** Explicit proposal search: source rows, never unpaid obligations or cap-as-award amounts. */
export async function readSettlementSaleProposalPage(
  organizationId: string,
  kind: "sale_contract" | "sale_deposit",
  search: string,
  page: number,
) {
  const from = page * 30,
    term = search.replace(/[%_\\]/g, "").trim();
  if (kind === "sale_contract") {
    let query = supabase
      .from("contracts")
      .select(
        "id,organization_id,contract_number,room_id,signed_date,room:rooms!inner(name,building_id)",
      )
      .eq("organization_id", organizationId)
      .is("deleted_at", null)
      .order("signed_date", { ascending: false })
      .order("id");
    if (term) query = query.ilike("contract_number", "%" + term + "%");
    return parseSettlementSaleProposals(
      value(await query.range(from, from + 29)),
      organizationId,
      kind,
    );
  }
  let query = supabase
    .from("income_expenses")
    .select(
      "id,organization_id,code,name,room_id,building_id,voucher_date,income_expense_items!inner(accounting_class)",
    )
    .eq("organization_id", organizationId)
    .eq("type", "INCOME")
    .neq("approval_status", "CANCELLED")
    .is("deleted_at", null)
    .eq("income_expense_items.accounting_class", "DEPOSIT")
    .order("voucher_date", { ascending: false })
    .order("id");
  if (term) query = query.ilike("code", "%" + term + "%");
  return parseSettlementSaleProposals(
    value(await query.range(from, from + 29)),
    organizationId,
    kind,
  );
}
