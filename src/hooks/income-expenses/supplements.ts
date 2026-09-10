import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';
import { supabase } from '@/integrations/supabase/client';
import { fetchAllRows } from '@/lib/supabaseFetchAll';
import { appendSupplementResultSchema, incomeExpenseSupplementSchema, supplementErrorMessage,
  appendSupplementInputSchema, type IncomeExpenseSupplement } from '@/lib/incomeExpenseSupplement';

const columns = 'id,organization_id,income_expense_id,note,attachments,actor_id,actor_name,created_at';

export async function hydrateIncomeExpenseSupplements<T extends { id: string }>(vouchers: T[]): Promise<(T & { supplements: IncomeExpenseSupplement[] })[]> {
  const grouped = new Map<string, IncomeExpenseSupplement[]>();
  const ids = [...new Set(vouchers.map(v => v.id))];
  for (let start = 0; start < ids.length; start += 50) {
    const chunk = ids.slice(start, start + 50);
    const rows = await fetchAllRows((from, to) => supabase.from('income_expense_supplements')
      .select(columns).in('income_expense_id', chunk)
      .order('created_at', { ascending: true }).order('id', { ascending: true }).range(from, to),
    { label: 'income-expense-supplements' });
    if (rows === null) throw new Error('Không tải được phần chứng từ bổ sung. Hãy thử lại.');
    for (const row of z.array(incomeExpenseSupplementSchema).parse(rows) as IncomeExpenseSupplement[]) {
      const group = grouped.get(row.income_expense_id) ?? [];
      group.push(row); grouped.set(row.income_expense_id, group);
    }
  }
  return vouchers.map(v => ({ ...v, supplements: grouped.get(v.id) ?? [] }));
}

export function useIncomeExpenseSupplements(voucherId?: string, enabled = true) {
  return useQuery({
    queryKey: ['income-expense-supplements', voucherId], enabled: enabled && !!voucherId,
    queryFn: async () => {
      if (!voucherId) throw new Error('Thiếu phiếu cần xem.');
      const [voucher] = await hydrateIncomeExpenseSupplements([{ id: voucherId }]);
      if (!voucher) throw new Error('Không tải được phần chứng từ bổ sung. Hãy thử lại.');
      return voucher.supplements;
    },
  });
}

export interface AppendIncomeExpenseSupplementInput {
  voucherId: string; note: string; attachments: string[]; idempotencyKey: string;
}

export function useAppendIncomeExpenseSupplement() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: AppendIncomeExpenseSupplementInput) => {
      const fields = appendSupplementInputSchema.parse(input);
      const { data, error } = await supabase.rpc('append_income_expense_supplement_v1', {
        p_voucher: fields.voucherId, p_note: fields.note || undefined,
        p_attachments: fields.attachments, p_idempotency_key: fields.idempotencyKey,
      });
      if (error) throw error;
      return appendSupplementResultSchema.parse(data);
    },
    onSuccess: async () => {
      await Promise.all(['income-expense-supplements', 'income-expenses', 'income-expense-batches',
        'voucher-with-batch', 'income-expense', 'reservation-refund-evidence', 'ie-history', 'voucher-change-log']
        .map(key => client.invalidateQueries({ queryKey: [key] })));
      toast.success('Đã lưu bổ sung chứng từ / ghi chú.');
    },
    onError: error => { toast.error(supplementErrorMessage(error)); },
  });
}
