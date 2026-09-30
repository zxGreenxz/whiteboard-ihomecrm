import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import type { Material, MaterialUsage, MaterialUsageItem } from '@/types/material';
import { FinancialWorkflowError, isConfirmedFinancialRejection } from '@/lib/financialWorkflow';
import { confirmedRecordBatch } from '@/lib/recordWriteOutcome';
import { persistentFinancialWorkflow } from '@/lib/persistentFinancialWorkflow';
import { confirmedMaterialVoucherId, materialVoucherFailureMessage } from '@/lib/materialVoucherOutcome';
export interface MaterialUsageWithItems extends MaterialUsage {
  items: (MaterialUsageItem & { material: Pick<Material, 'id' | 'name' | 'unit'> | null })[];
}
export interface MaterialUsageWithJob extends MaterialUsageWithItems {
  job: { id: string; code: string; title: string } | null;
  creator: { full_name: string | null } | null;
}
export const useMaterialUsages = () => useQuery({
  queryKey: ['material-usages', 'list'],
  queryFn: async (): Promise<MaterialUsageWithJob[]> => {
    const { data, error } = await supabase.from('material_usages' as any).select('*, items:material_usage_items(*, material:materials(id,name,unit)), job:jobs(id,code,title)').order('usage_date', { ascending: false }).order('created_at', { ascending: false });
    if (error) throw error;
    if (!Array.isArray(data)) throw new Error('Chưa xác nhận được danh sách phiếu xuất. Tải lại để kiểm tra.');
    const rows = data as unknown as MaterialUsageWithJob[];
    const userIds = [...new Set(rows.map(row => row.user_id).filter(Boolean))];
    if (userIds.length) {
      const { data: profiles, error: profileError } = await supabase.from('profiles' as any).select('id, full_name').in('id', userIds);
      if (profileError) throw profileError;
      if (!Array.isArray(profiles)) throw new Error('Chưa xác nhận được người tạo phiếu xuất. Tải lại để kiểm tra.');
      const nameMap = new Map((profiles as unknown as Array<{ id: string; full_name: string | null }>).map(profile => [profile.id, profile.full_name]));
      rows.forEach(row => { row.creator = row.user_id ? { full_name: nameMap.get(row.user_id) ?? null } : null; });
    }
    return rows;
  },
});
export const useMaterialUsageByJob = (jobId: string | null | undefined) => useQuery({
  queryKey: ['material-usages', 'by-job', jobId],
  queryFn: async (): Promise<MaterialUsageWithItems | null> => {
    if (!jobId) return null;
    const { data, error } = await supabase.from('material_usages' as any).select('*, items:material_usage_items(*, material:materials(id,name,unit))').eq('job_id', jobId).maybeSingle();
    if (error) throw error;
    return data as unknown as MaterialUsageWithItems | null;
  },
  enabled: !!jobId,
});
interface UsageInput {
  usage_date: string;
  notes: string | null;
  items: Array<{ material_id: string; quantity: number; unit_cost_at_usage: number }>;
}
interface UpsertInput extends UsageInput { job_id: string }
export const useUpsertJobMaterialUsage = (options: { silent?: boolean } = {}) => {
  const qc = useQueryClient();
  const guard = persistentFinancialWorkflow('material-job-usage');
  const refresh = (jobId: string) => { qc.invalidateQueries({ queryKey: ['material-usages', 'by-job', jobId] }); qc.invalidateQueries({ queryKey: ['material-usages', 'list'] }); qc.invalidateQueries({ queryKey: ['materials'] }); };
  return useMutation({
    mutationFn: async (input: UpsertInput) => {
      const { data: existing, error: readError } = await supabase.from('material_usages' as any).select('id').eq('job_id', input.job_id).maybeSingle();
      if (readError) throw readError;
      const existingId = existing ? confirmedMaterialVoucherId(existing) : null;
      return guard.run(input.job_id, 'lưu vật tư công việc', async progress => {
        if (!existingId && input.items.length === 0) return null;
        let usageId: string;
        if (existingId) {
          const { data, error } = await supabase.from('material_usages' as any).update({ usage_date: input.usage_date, notes: input.notes }).eq('id', existingId).select('id').single();
          if (error) throw error;
          usageId = confirmedMaterialVoucherId(data, existingId);
          progress.completed.push({ id: usageId, label: `Thông tin phiếu xuất công việc ID ${usageId} đã cập nhật` });
          progress.stage = 'xóa toàn bộ dòng vật tư công việc cũ';
          const { data: removed, error: removeError } = await supabase.from('material_usage_items' as any).delete().eq('usage_id', existingId).select('id');
          if (removeError) throw removeError;
          const removedIds = confirmedRecordBatch(removed, Array.isArray(removed) ? removed.length : 0, 'xóa dòng vật tư công việc cũ');
          progress.completed.push(...removedIds.map(lineId => ({ id: lineId, label: 'Dòng vật tư công việc cũ đã xóa' })));
        } else {
          const { data, error } = await supabase.from('material_usages' as any).insert({ job_id: input.job_id, usage_date: input.usage_date, notes: input.notes }).select().single();
          if (error) throw error;
          usageId = confirmedMaterialVoucherId(data);
          progress.completed.push({ id: usageId, label: `Phiếu xuất công việc ID ${usageId} đã tạo` });
        }
        if (input.items.length > 0) {
          progress.stage = 'lưu các dòng vật tư công việc mới';
          const lines = input.items.map(row => ({ usage_id: usageId, material_id: row.material_id, quantity: row.quantity, unit_cost_at_usage: row.unit_cost_at_usage }));
          const { data, error } = await supabase.from('material_usage_items' as any).insert(lines).select('id');
          if (error) throw error;
          const lineIds = confirmedRecordBatch(data, input.items.length, 'lưu dòng vật tư công việc mới');
          progress.completed.push(...lineIds.map(lineId => ({ id: lineId, label: 'Dòng vật tư công việc mới đã lưu' })));
        } else if (existingId) {
          progress.stage = 'gỡ phiếu xuất công việc không còn dòng';
          const { data, error } = await supabase.from('material_usages' as any).delete().eq('id', existingId).select('id').single();
          if (error) throw error;
          confirmedMaterialVoucherId(data, existingId);
          progress.completed.push({ id: existingId, label: 'Phiếu xuất công việc không còn dòng đã gỡ' });
        }
        return usageId;
      });
    },
    onSuccess: (data, input) => { refresh(input.job_id); if (!options.silent) { if (data) toast.success('Đã lưu vật tư sử dụng cho phiếu công việc'); else toast.info('Không có vật tư cần lưu.'); } },
    onError: (error, input) => { refresh(input.job_id); if (!options.silent) toast.error('Chưa hoàn tất lưu vật tư công việc', { description: materialVoucherFailureMessage(error, 'lưu vật tư công việc') }); },
  });
};
export const useCreateMaterialUsage = () => {
  const qc = useQueryClient();
  const guard = persistentFinancialWorkflow('material-manual-usage');
  const refresh = () => { qc.invalidateQueries({ queryKey: ['material-usages', 'list'] }); qc.invalidateQueries({ queryKey: ['materials'] }); };
  return useMutation({
    mutationFn: async (input: UsageInput) => {
      if (input.items.length === 0) throw new Error('Cần ít nhất 1 dòng vật tư');
      return guard.run('create', 'tạo phiếu xuất', async progress => {
        const { data: header, error } = await supabase.from('material_usages' as any).insert({ job_id: null, usage_date: input.usage_date, notes: input.notes }).select('id').single();
        if (error) throw error;
        const id = confirmedMaterialVoucherId(header);
        progress.completed.push({ id, label: `Phiếu xuất ID ${id} đã tạo` });
        progress.stage = 'lưu các dòng vật tư';
        const lines = input.items.map(row => ({ usage_id: id, material_id: row.material_id, quantity: row.quantity, unit_cost_at_usage: row.unit_cost_at_usage }));
        const { data, error: lineError } = await supabase.from('material_usage_items' as any).insert(lines).select('id');
        if (lineError) {
          progress.stage = 'gỡ phiếu tạm sau lỗi lưu dòng vật tư';
          const { data: removedHeader, error: cleanupError } = await supabase.from('material_usages' as any).delete().eq('id', id).select('id').single();
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
        const lineIds = confirmedRecordBatch(data, input.items.length, 'lưu dòng phiếu xuất');
        progress.completed.push(...lineIds.map(lineId => ({ id: lineId, label: 'Dòng phiếu xuất đã lưu' })));
        return id;
      });
    },
    onSuccess: () => { refresh(); toast.success('Đã tạo phiếu xuất kho'); },
    onError: error => { refresh(); toast.error('Chưa hoàn tất tạo phiếu xuất', { description: materialVoucherFailureMessage(error, 'tạo phiếu xuất') }); },
  });
};
