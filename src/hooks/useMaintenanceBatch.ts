// =============================================================================
// useCreateMaintenanceBatch — tạo phiếu TỔNG bảo trì máy lạnh/máy giặt (1 NCC,
// nhiều tòa) qua useCreateIncomeExpenseBatch. Resolve type ml/mg trong đúng tổ
// chức của các tòa — CHỈ dùng hạng mục có sẵn, KHÔNG tự tạo.
//
// Danh mục chi chuẩn (chủ duyệt 03/10/2026): chỉ superadmin / chủ công ty tạo hạng
// mục (RLS chặn người khác). "vệ sinh máy lạnh/giặt" giữ tên, chỉ ẩn khỏi ô chọn tay
// để công cụ này nhận diện; mục đã lưu trữ (gộp vào "Điện lạnh") không được chọn.
// Thiếu hạng mục ⇒ báo người dùng nhờ chủ công ty tạo/khôi phục.
// =============================================================================

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { getSessionUser } from '@/lib/authSession';
import { FinancialWorkflowError } from '@/lib/financialWorkflowError';
import {
  MAINTENANCE_IE_TYPES,
  maintenanceIeTypeMissingMessage,
  pickMaintenanceIeType,
  type MaintenanceSubtype,
} from '@/lib/ieTypeLookup';
import { useCreateIncomeExpenseBatch } from '@/hooks/useIncomeExpenses';
import { monthToStartDate, monthToEndDate } from '@/lib/monthPeriod';

type MaintenanceTypeRow = { id: string; name: string; archived_at?: string | null };

async function resolveOwnType(
  sub: MaintenanceSubtype,
  organizationId: string,
): Promise<string> {
  // select('*'): cột archived_at chỉ có sau migration danh mục chuẩn; môi trường chưa áp
  // thì không trả cột ⇒ coi như chưa lưu trữ (chọn cột tường minh sẽ lỗi 42703).
  const { data, error } = await supabase
    .from('income_expense_types')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('type', 'expense');
  if (error) throw error;
  const hit = pickMaintenanceIeType((data ?? []) as unknown as MaintenanceTypeRow[], sub);
  // FinancialWorkflowError 'failure': voucherFailureMessage hiện nguyên câu, không khoá form.
  if (!hit) throw new FinancialWorkflowError(maintenanceIeTypeMissingMessage(sub), 'failure', []);
  return hit.id;
}

export interface MaintenanceBatchLine {
  buildingId: string;
  subtype: 'ml' | 'mg';
  amount: number;
}

export function useCreateMaintenanceBatch(period: string) {
  const qc = useQueryClient();
  const createBatch = useCreateIncomeExpenseBatch({silent:true});
  return useMutation({
    meta: {handlesFeedback: true},
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
      if (buildingError) throw buildingError;
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
      for (const s of need) typeIds[s] = await resolveOwnType(s, organizationId);

      const start = monthToStartDate(period);
      const end = monthToEndDate(period);
      return await createBatch.mutateAsync({
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
          type_name: MAINTENANCE_IE_TYPES[l.subtype].label,
          description: `${MAINTENANCE_IE_TYPES[l.subtype].label} kỳ ${period}`,
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
