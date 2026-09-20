import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { actionSnapshotQueryKey, queryActionReadiness, readActionSnapshotBatches, type ActionSnapshotReader, type ActionSnapshotScope } from '@/lib/incomeExpenseActionSnapshot';

type SnapshotRpc = (name: 'read_income_expense_action_snapshots_v1', args: { p_organization_id: string; p_voucher_ids: string[] }) => PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>;
export const readIncomeExpenseActionSnapshotPage: ActionSnapshotReader = async (scope, ids, signal) => {
  signal?.throwIfAborted();
  const result = await (supabase.rpc as unknown as SnapshotRpc)('read_income_expense_action_snapshots_v1', { p_organization_id: scope.organizationId, p_voucher_ids: ids });
  signal?.throwIfAborted();
  if (result.error) throw new Error(result.error.code === '42501' ? 'SNAPSHOT_READ_DENIED' : 'SNAPSHOT_READ_FAILED');
  return result.data;
};

/** One selected voucher or a whole visible page, in bounded batches; both surfaces share this key. */
export function useIncomeExpenseActionSnapshots(scope: ActionSnapshotScope, voucherIds: readonly string[], enabled = true) {
  const active = enabled && !!scope.actorId && !!scope.organizationId;
  const query = useQuery({ queryKey: actionSnapshotQueryKey(scope, voucherIds), enabled: active,
    queryFn: ({ signal }) => readActionSnapshotBatches(scope, voucherIds, readIncomeExpenseActionSnapshotPage, signal),
    staleTime: 0, refetchOnWindowFocus: 'always', refetchInterval: 30_000, retry: false });
  return { ...query, readiness: queryActionReadiness(query, active),
    refresh: async () => {
      if (!active) throw new Error('SNAPSHOT_SCOPE');
      const result = await query.refetch();
      if (result.error || !result.data) throw new Error('SNAPSHOT_REFRESH_FAILED');
      return result.data;
    } };
}
