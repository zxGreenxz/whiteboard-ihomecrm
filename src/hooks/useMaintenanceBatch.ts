// =============================================================================
// useCreateMaintenanceBatch — tạo phiếu TỔNG bảo trì máy lạnh/máy giặt (1 NCC,
// nhiều tòa) qua useCreateIncomeExpenseBatch. Resolve type ml/mg của CHÍNH CALLER
// (RLS user_id=auth.uid()) — tái dùng nếu có, tạo nếu thiếu.
// =============================================================================

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { getSessionUser } from '@/lib/authSession';
import { nrm } from '@/lib/fixedExpenseCategories';
import { useCreateIncomeExpenseBatch } from '@/hooks/useIncomeExpenses';
import { monthToStartDate, monthToEndDate } from '@/lib/monthPeriod';

const SUBTYPE_META = {
  ml: { name: 'Bảo trì máy lạnh', match: 'may lanh' },
  mg: { name: 'Bảo trì máy giặt', match: 'may giat' },
} as const;

async function resolveOwnType(sub: 'ml' | 'mg'): Promise<string> {
  const meta = SUBTYPE_META[sub];
  const { data, error } = await (supabase as any)
    .from('income_expense_types')
    .select('id, name, category')
    .eq('type', 'expense');
  if (error) throw new Error(error.message);
  const hit = (data ?? []).find((t: any) => {
    const n = nrm(t.name);
    return n.includes('bao tri ' + meta.match) || n.includes(meta.match);
  });
  if (hit) return hit.id;
  const { data: created, error: insErr } = await (supabase as any)
    .from('income_expense_types')
    .insert({ name: meta.name, category: 'Bảo Trì', type: 'expense' })
    .select('id')
    .single();
  if (insErr) throw new Error(insErr.message);
  return created.id;
}

export interface MaintenanceBatchLine {
  buildingId: string;
  subtype: 'ml' | 'mg';
  amount: number;
}

export function useCreateMaintenanceBatch(period: string) {
  const qc = useQueryClient();
  const createBatch = useCreateIncomeExpenseBatch();
  return useMutation({
    mutationFn: async (args: { payerName: string; voucherDate: string; accountId: string; lines: MaintenanceBatchLine[]; attachments?: string[] }) => {
      const uid = (await getSessionUser())?.id;
      if (!uid) throw new Error('Bạn chưa đăng nhập');
      if (!args.accountId) throw new Error('Chọn sổ quỹ ghi chi');
      if (!args.lines.length) throw new Error('Thêm ít nhất 1 dòng (tòa × loại máy)');
      const need = new Set(args.lines.map((l) => l.subtype));
      const typeIds: Record<'ml' | 'mg', string> = {} as any;
      for (const s of need) typeIds[s] = await resolveOwnType(s);

      const start = monthToStartDate(period);
      const end = monthToEndDate(period);
      await createBatch.mutateAsync({
        type: 'EXPENSE',
        shared_name: `Bảo trì · ${args.payerName || 'NCC'}`,
        account_id: args.accountId,
        voucher_date: args.voucherDate,
        payer_name: args.payerName || null,
        business_result_accounting: null,
        attachments: args.attachments ?? [],
        notes: null,
        items: args.lines.map((l) => ({
          building_id: l.buildingId,
          income_expense_type_id: typeIds[l.subtype],
          type_name: SUBTYPE_META[l.subtype].name,
          description: `${SUBTYPE_META[l.subtype].name} kỳ ${period}`,
          quantity: 1,
          unit_price: l.amount,
          start_date: start,
          end_date: end,
        })),
      } as any);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['period-maintenance'] });
      qc.invalidateQueries({ queryKey: ['income-expenses'] });
      qc.invalidateQueries({ queryKey: ['income-expense-batches'] });
      qc.invalidateQueries({ queryKey: ['accounts-with-balance'] });
    },
  });
}
