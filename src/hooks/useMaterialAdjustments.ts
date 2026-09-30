import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { friendlyError } from '@/lib/friendlyError';
import type { Material, MaterialAdjustment, MaterialAdjustmentItem } from '@/types/material';
import { todayISO } from '@/lib/collect';
import { persistentFinancialWorkflow } from '@/lib/persistentFinancialWorkflow';
import { FinancialWorkflowError, isConfirmedFinancialRejection, type CompletedFinancialStep } from '@/lib/financialWorkflow';
import { confirmedRecordBatch } from '@/lib/recordWriteOutcome';
import { confirmedMaterialVoucherId, materialVoucherFailureMessage } from '@/lib/materialVoucherOutcome';
export interface MaterialAdjustmentWithItems extends MaterialAdjustment {
  items: (MaterialAdjustmentItem & { material: Pick<Material, 'id' | 'name' | 'unit'> | null })[];
}
const KEY = ['material-adjustments'] as const;
export const useMaterialAdjustments = () => useQuery({
  queryKey: [...KEY, 'list'],
  queryFn: async (): Promise<MaterialAdjustmentWithItems[]> => {
    const { data, error } = await supabase.from('material_adjustments' as any).select('*, items:material_adjustment_items(*, material:materials(id,name,unit))').order('adjustment_date', { ascending: false }).order('created_at', { ascending: false });
    if (error) throw error;
    if (!Array.isArray(data)) throw new Error('Chưa xác nhận được danh sách phiếu kiểm kê. Tải lại để kiểm tra.');
    return data as unknown as MaterialAdjustmentWithItems[];
  },
});
interface AdjustmentInput {
  adjustment_date: string;
  type: 'IN' | 'OUT';
  reason: string | null;
  items: Array<{ material_id: string; quantity: number }>;
}
async function createAdjustment(input: AdjustmentInput, progress: { completed: CompletedFinancialStep[]; stage: string }, singleItem = false): Promise<MaterialAdjustment> {
  const { data: header, error } = await supabase.from('material_adjustments' as any).insert({ adjustment_date: input.adjustment_date, type: input.type, reason: input.reason }).select().single();
  if (error) throw error;
  const id = confirmedMaterialVoucherId(header);
  progress.completed.push({ id, label: `Phiếu kiểm kê ID ${id} đã tạo` });
  if (input.items.length > 0) {
    progress.stage = 'lưu các dòng vật tư';
    const lines = input.items.map(row => ({ adjustment_id: id, material_id: row.material_id, quantity: row.quantity }));
    const { data, error: lineError } = await supabase.from('material_adjustment_items' as any).insert(singleItem ? lines[0] : lines).select('id');
    if (lineError) {
      progress.stage = 'gỡ phiếu tạm sau lỗi lưu dòng vật tư';
      const { data: removedHeader, error: cleanupError } = await supabase.from('material_adjustments').delete().eq('id', id).select('id').single();
      if (cleanupError) throw cleanupError;
      confirmedMaterialVoucherId(removedHeader, id);
      if (isConfirmedFinancialRejection(lineError)) {
        progress.completed.splice(0, progress.completed.length);
        throw new FinancialWorkflowError('Dòng vật tư bị từ chối; phiếu tạm đã gỡ. Giữ bản nháp, kiểm tra lỗi trước khi thử lại.', 'failure', [], lineError);
      }
      for (const step of progress.completed) if (step.id === id) step.label = `Phiếu tạm ID ${id} đã gỡ; kết quả lưu dòng chưa xác nhận`;
      progress.stage = 'đối chiếu kết quả lưu dòng sau khi đã gỡ phiếu tạm';
      throw lineError;
    }
    const lineIds = confirmedRecordBatch(data, input.items.length, 'lưu dòng phiếu kiểm kê');
    progress.completed.push(...lineIds.map(lineId => ({ id: lineId, label: 'Dòng phiếu kiểm kê đã lưu' })));
  }
  return header as unknown as MaterialAdjustment;
}
export const useCreateMaterialAdjustment = () => {
  const qc = useQueryClient();
  const guard = persistentFinancialWorkflow('material-adjustment');
  const refresh = () => { qc.invalidateQueries({ queryKey: KEY }); qc.invalidateQueries({ queryKey: ['materials'] }); };
  return useMutation({
    mutationFn: async (input: AdjustmentInput) => {
      return guard.run('create', 'tạo phiếu kiểm kê', progress => createAdjustment(input, progress));
    },
    onSuccess: () => { refresh(); toast.success('Đã tạo phiếu kiểm kê'); },
    onError: error => { refresh(); toast.error('Chưa hoàn tất tạo phiếu kiểm kê', { description: materialVoucherFailureMessage(error, 'tạo phiếu kiểm kê') }); },
  });
};
/** SET derives one delta from the supplied inventory snapshot. Partial/unknown writes require reconciliation. */
export const useSetMaterialStock = (options: { silent?: boolean } = {}) => {
  const qc = useQueryClient();
  const guard = persistentFinancialWorkflow('material-adjustment');
  const refresh = () => { qc.invalidateQueries({ queryKey: KEY }); qc.invalidateQueries({ queryKey: ['materials'] }); };
  return useMutation({
    mutationFn: async (input: { material_id: string; target_quantity: number; current_quantity: number; reason?: string }) => {
      const delta = input.target_quantity - input.current_quantity;
      return guard.run<MaterialAdjustment | null>('create', 'điều chỉnh tồn kho', progress => delta === 0 ? Promise.resolve(null) : createAdjustment({ adjustment_date: todayISO(), type: delta > 0 ? 'IN' : 'OUT', reason: input.reason ?? 'Kiểm kê — đặt lại tồn', items: [{ material_id: input.material_id, quantity: Math.abs(delta) }] }, progress, true));
    },
    onSuccess: data => { refresh(); if (!options.silent) { if (data) toast.success('Đã cập nhật tồn kho theo kiểm kê'); else toast.info('Tồn đã khớp — không cần điều chỉnh'); } },
    onError: error => { refresh(); if (!options.silent) toast.error('Chưa hoàn tất điều chỉnh tồn kho', { description: materialVoucherFailureMessage(error, 'điều chỉnh tồn kho') }); },
  });
};
export const useDeleteMaterialAdjustment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase.from('material_adjustments' as any).delete().eq('id', id).select('id').single();
      if (error) throw error;
      if ((data as { id?: string } | null)?.id !== id) throw new Error('Chưa xác nhận được phiếu kiểm kê đã xóa. Tải lại danh sách để kiểm tra.');
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: KEY }); qc.invalidateQueries({ queryKey: ['materials'] }); toast.success('Đã xoá phiếu kiểm kê'); },
    onError: error => { const feedback = friendlyError(error, 'Chưa xóa được phiếu kiểm kê', { operation: 'xóa phiếu kiểm kê' }); toast.error(feedback.title, { description: feedback.description }); },
  });
};
