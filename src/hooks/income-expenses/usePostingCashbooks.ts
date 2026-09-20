import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { queryActionReadiness, type ActionSnapshotScope } from '@/lib/incomeExpenseActionSnapshot';
import { readPostingCashbooks } from '@/lib/postingCashbooks';

export const postingCashbooksQueryKey = (scope: ActionSnapshotScope) => ['income-expense-posting-cashbooks', scope.organizationId, scope.actorId] as const;

async function readCustodyPages(signal?: AbortSignal): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (let offset = 0; ; offset += 200) {
    signal?.throwIfAborted();
    const response = await supabase.rpc('list_cashbooks_for_expense_v2').range(offset, offset + 199).abortSignal(signal ?? new AbortController().signal);
    if (response.error || !Array.isArray(response.data)) throw new Error('CUSTODY_READ_FAILED');
    rows.push(...response.data);
    if (response.data.length < 200) return rows;
    if (offset >= 99_800) throw new Error('CUSTODY_READ_INCOMPLETE');
  }
}

export function usePostingCashbooks(scope: ActionSnapshotScope, enabled = true) {
  const active = enabled && !!scope.organizationId && !!scope.actorId;
  const query = useQuery({ queryKey: postingCashbooksQueryKey(scope), enabled: active,
    queryFn: async ({ signal }) => {
      const actor = await supabase.auth.getUser();
      if (actor.error || actor.data.user?.id !== scope.actorId) throw new Error('CASHBOOK_ACTOR_CHANGED');
      return readPostingCashbooks(scope.organizationId, () => readCustodyPages(signal), async ids => {
      // <=100 requested primary keys keeps the response below the server row cap.
      // Missing rows are deliberate RLS omissions; transport errors remain errors.
      const response = await supabase.from('accounts').select('id,name,organization_id,is_virtual,deleted_at').in('id', ids).abortSignal(signal);
      if (response.error) throw new Error('CASHBOOK_METADATA_READ_FAILED');
      return response.data;
      });
    }, staleTime: 0, refetchOnWindowFocus: 'always', refetchInterval: 30_000, retry: false });
  return { ...query, readiness: queryActionReadiness(query, active),
    refresh: async () => {
      if (!active) throw new Error('CASHBOOK_SCOPE');
      const result = await query.refetch();
      if (result.error || !result.data) throw new Error('CASHBOOK_REFRESH_FAILED');
      return result.data;
    } };
}
