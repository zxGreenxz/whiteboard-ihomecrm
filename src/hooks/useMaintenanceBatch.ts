// =============================================================================
// useCreateMaintenanceBatch — tạo phiếu TỔNG bảo trì máy lạnh/máy giặt (1 NCC,
// nhiều tòa) qua useCreateIncomeExpenseBatch. Resolve type ml/mg trong đúng tổ
// chức của các tòa — tái dùng nếu có, tạo nếu thiếu.
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

async function resolveOwnType(
  sub: 'ml' | 'mg',
  organizationId: string,
  userId: string,
): Promise<string> {
  const meta = SUBTYPE_META[sub];
  const { data, error } = await supabase
    .from('income_expense_types')
    .select('id, name, category')
    .eq('organization_id', organizationId)
    .eq('type', 'expense');
  if (error) throw new Error(error.message);
  const hit = (data ?? []).find((t: any) => {
    const n = nrm(t.name);
    return n.includes('bao tri ' + meta.match) || n.includes(meta.match);
  });
  if (hit) return hit.id;
  const { data: created, error: insErr } = await supabase
    .from('income_expense_types')
    .insert({
      user_id: userId,
      organization_id: organizationId,
      name: meta.name,
      category: 'Bảo Trì',
      type: 'expense',
    })
    .select('id')
    .single();
  if (insErr?.code === '23505') {
    return resolveOwnType(sub, organizationId, userId);
  }
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

      const buildingIds = Array.from(new Set(args.lines.map((line) => line.buildingId)));
      const { data: scopedBuildings, error: buildingError } = await supabase
        .from('buildings')
        .select('id, organization_id')
        .in('id', buildingIds);
      if (buildingError) throw new Error(buildingError.message);
      if ((scopedBuildings ?? []).length !== buildingIds.length) {
        throw new Error('Không thể xác định đầy đủ tổ chức của các tòa bảo trì');
      }
      const organizationIds = new Set<string>(
        (scopedBuildings ?? [])
          .map((building: { organization_id?: string | null }) => building.organization_id)
          .filter((id: string | null | undefined): id is string => Boolean(id)),
      );
      if (organizationIds.size !== 1) {
        throw new Error('Một phiếu bảo trì chỉ được chứa các tòa trong cùng tổ chức');
      }
      const organizationId = [...organizationIds][0];

      const need = new Set(args.lines.map((l) => l.subtype));
      const typeIds: Record<'ml' | 'mg', string> = {} as any;
      for (const s of need) typeIds[s] = await resolveOwnType(s, organizationId, uid);

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
