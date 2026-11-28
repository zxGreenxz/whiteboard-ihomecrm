import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { Tables } from '@/integrations/supabase/types';
import { fetchAllRows } from '@/lib/supabaseFetchAll';

type ExpenseBuilding = Pick<Tables<'buildings'>, 'id' | 'name'>;
type ExpenseTypeRule = Pick<Tables<'income_expense_types'>, 'id' | 'name' | 'fee_category' | 'spend_mode' | 'force_approval'>;

export function useExpenseBuildings(orgId: string) {
  return useQuery({
    queryKey: ['spend-engine', 'buildings', orgId],
    enabled: !!orgId,
    staleTime: 300_000,
    meta: { label: 'tòa nhà theo công ty', errorDisplay: 'inline' },
    queryFn: async () => {
      const rows = await fetchAllRows<ExpenseBuilding>((from, to) => supabase.from('buildings').select('id, name')
        .eq('organization_id', orgId).is('deleted_at', null).order('name').order('id').range(from, to));
      if (!rows) throw new Error('Chưa tải được danh sách tòa.');
      return rows;
    },
  });
}

// The general voucher picker deduplicates by name across memberships. Rules must
// use the exact organization's expense type that the fee writer resolves.
export function useOrgExpenseRules(orgId: string | null) {
  return useQuery({
    queryKey: ['income-expense-types', 'spend-rules', orgId],
    enabled: !!orgId,
    meta: { label: 'luật hạng mục chi', errorDisplay: 'inline' },
    queryFn: async () => {
      if (!orgId) throw new Error('Chọn công ty trước khi xem quy tắc.');
      const rows = await fetchAllRows<ExpenseTypeRule>((from, to) => supabase.from('income_expense_types')
        .select('id, name, fee_category, spend_mode, force_approval')
        .eq('organization_id', orgId).eq('type', 'expense').order('name').order('id').range(from, to));
      if (!rows) throw new Error('Chưa tải được danh sách luật hạng mục.');
      return rows;
    },
  });
}
