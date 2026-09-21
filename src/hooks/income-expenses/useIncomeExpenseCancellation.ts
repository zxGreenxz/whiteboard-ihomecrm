import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  queryActionReadiness,
  type ActionSnapshotScope,
} from "@/lib/incomeExpenseActionSnapshot";
import {
  parseCancellationEligibility,
  type CancellationEligibility,
} from "@/lib/incomeExpenseActionContext";
export async function readIncomeExpenseCancellation(
  ids: readonly string[],
): Promise<CancellationEligibility> {
  const unique = [...new Set(ids)].sort(),
    result: CancellationEligibility = { income: {}, flex: {} };
  for (let start = 0; start < unique.length; start += 100) {
    const page = unique.slice(start, start + 100);
    const [income, flex] = await Promise.all([
      supabase.rpc("can_cancel_income_voucher_v1", { p_ids: page }),
      supabase.rpc("can_flex_cancel_v1", { p_ids: page }),
    ]);
    if (income.error) throw income.error;
    if (flex.error) throw flex.error;
    Object.assign(
      result.income,
      parseCancellationEligibility(income.data, page, "income"),
    );
    Object.assign(
      result.flex,
      parseCancellationEligibility(flex.data, page, "flex"),
    );
  }
  return result;
}
export function useIncomeExpenseCancellation(
  scope: ActionSnapshotScope,
  ids: readonly string[],
  enabled: boolean,
) {
  const active = enabled && !!scope.actorId && !!scope.organizationId;
  const query = useQuery({
    queryKey: [
      "income-expense-action-cancellation",
      scope.organizationId,
      scope.actorId,
      [...new Set(ids)].sort(),
    ],
    enabled: active,
    queryFn: () => readIncomeExpenseCancellation(ids),
    staleTime: 0,
    refetchInterval: 30_000,
    refetchOnWindowFocus: "always",
    retry: false,
  });
  return {
    ...query,
    readiness: queryActionReadiness(query, active),
    refresh: async () => {
      const r = await query.refetch();
      if (r.error || !r.data) throw new Error("CANCEL_REFRESH_FAILED");
      return r.data;
    },
  };
}
