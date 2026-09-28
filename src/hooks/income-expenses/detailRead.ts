import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { loadIncomeExpenseDetails } from "@/lib/incomeExpenseDetailRpc";
export { loadIncomeExpenseDetails } from "@/lib/incomeExpenseDetailRpc";
import type { IncomeExpenseWithRelations } from "./types";
import { hydrateReservationCreators } from "./reservationCreators";
import { hydrateIncomeExpenseSupplements } from "./supplements";
/** Keep ordinary RLS relation labels only while their FK still matches the snapshot. */
export async function enrichIncomeExpenseDetails(
  rows: IncomeExpenseWithRelations[],
): Promise<IncomeExpenseWithRelations[]> {
  const groups = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.organization_id)
      throw new Error("Phiếu thiếu tổ chức. Vui lòng tải lại.");
    const ids = groups.get(row.organization_id) ?? [];
    ids.push(row.id);
    groups.set(row.organization_id, ids);
  }
  const details = (
    await Promise.all(
      [...groups].map(([org, ids]) => loadIncomeExpenseDetails(org, ids)),
    )
  ).flat();
  const byId = new Map(details.map((row) => [row.id, row]));
  return rows.map((row) => {
    const detail = byId.get(row.id)!;
    // The list was selected by these header fields. A newer snapshot needs the
    // selection query rerun, otherwise a cancelled/moved voucher crosses filters.
    const selectionFields: (keyof IncomeExpenseWithRelations)[] = [
      "updated_at",
      "approval_version",
      "posting_version",
      "organization_id",
      "building_id",
      "room_id",
      "tenant_id",
      "account_id",
      "type",
      "voucher_date",
      "approval_status",
      "user_id",
      "total_amount",
      "kqkd_amount",
      "verified_at",
      "system_source",
      "counts_in_business_result",
      "business_result_accounting",
    ];
    if (selectionFields.some((field) => row[field] !== detail[field])) {
      throw new Error("Danh sách phiếu vừa thay đổi. Vui lòng tải lại.");
    }
    return {
      ...row,
      ...detail,
      creator_name: detail.creator_name ?? row.creator_name,
      room_name: detail.room_id === row.room_id ? row.room_name : null,
      tenant_name: detail.tenant_id === row.tenant_id ? row.tenant_name : null,
      account_name:
        detail.account_id === row.account_id ? row.account_name : null,
      account_is_virtual:
        detail.account_id === row.account_id ? row.account_is_virtual : null,
    };
  });
}
export async function loadIncomeExpenseDetail(
  id: string,
): Promise<IncomeExpenseWithRelations | null> {
  const { data, error } = await supabase
    .from("income_expenses")
    .select(
      "organization_id, room:rooms!income_expenses_room_id_fkey(id,name), tenant:tenants!income_expenses_tenant_id_fkey(id,full_name), account:accounts!income_expenses_account_id_fkey(id,name,is_virtual)",
    )
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  if (!data.organization_id) throw new Error("Phiếu thiếu tổ chức.");
  const [detail] = await loadIncomeExpenseDetails(data.organization_id, [id]);
  if (!detail) throw new Error("Không tải đủ chi tiết phiếu. Vui lòng thử lại.");
  const [result] = await hydrateIncomeExpenseSupplements(
    await hydrateReservationCreators([
      {
        ...detail,
        room_name: data.room?.id === detail.room_id ? data.room.name : null,
        tenant_name:
          data.tenant?.id === detail.tenant_id ? data.tenant.full_name : null,
        account_name:
          data.account?.id === detail.account_id ? data.account.name : null,
        account_is_virtual:
          data.account?.id === detail.account_id
            ? data.account.is_virtual
            : null,
      },
    ]),
  );
  if (!result) throw new Error("Không tải đủ chi tiết phiếu. Vui lòng thử lại.");
  return result;
}
export function useIncomeExpenseDetail(
  id: string | null | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: ["income-expense", "detail", id],
    queryFn: () => loadIncomeExpenseDetail(id!),
    enabled: enabled && !!id,
    staleTime: 0,
    refetchOnMount: "always",
    retry: false,
  });
}

/** Related entities retain their own RLS. Missing permission means no label, never a broader read grant. */
export async function hydrateIncomeExpenseDetailRelations(
  rows: IncomeExpenseWithRelations[],
): Promise<IncomeExpenseWithRelations[]> {
  const chunks = (ids: (string | null)[]) => {
    const unique = [...new Set(ids.filter((id): id is string => !!id))];
    const result: string[][] = [];
    for (let offset = 0; offset < unique.length; offset += 100)
      result.push(unique.slice(offset, offset + 100));
    return result;
  };
  const [roomResults, tenantResults, accountResults] = await Promise.all([
    Promise.all(
      chunks(rows.map((row) => row.room_id)).map((ids) =>
        supabase.from("rooms").select("id,name").in("id", ids),
      ),
    ),
    Promise.all(
      chunks(rows.map((row) => row.tenant_id)).map((ids) =>
        supabase.from("tenants").select("id,full_name").in("id", ids),
      ),
    ),
    Promise.all(
      chunks(rows.map((row) => row.account_id)).map((ids) =>
        supabase.from("accounts").select("id,name,is_virtual").in("id", ids),
      ),
    ),
  ]);
  for (const result of [...roomResults, ...tenantResults, ...accountResults])
    if (result.error) throw result.error;
  const rooms = new Map(
    roomResults
      .flatMap((result) => result.data ?? [])
      .map((row) => [row.id, row]),
  );
  const tenants = new Map(
    tenantResults
      .flatMap((result) => result.data ?? [])
      .map((row) => [row.id, row]),
  );
  const accounts = new Map(
    accountResults
      .flatMap((result) => result.data ?? [])
      .map((row) => [row.id, row]),
  );
  return rows.map((row) => ({
    ...row,
    room_name: row.room_id ? (rooms.get(row.room_id)?.name ?? null) : null,
    tenant_name: row.tenant_id
      ? (tenants.get(row.tenant_id)?.full_name ?? null)
      : null,
    account_name: row.account_id
      ? (accounts.get(row.account_id)?.name ?? null)
      : null,
    account_is_virtual: row.account_id
      ? (accounts.get(row.account_id)?.is_virtual ?? null)
      : null,
  }));
}
