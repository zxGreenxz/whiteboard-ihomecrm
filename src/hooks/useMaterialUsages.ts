import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import type { Material, MaterialUsage, MaterialUsageItem } from '@/types/material';
import { FinancialWorkflowError, RepeatableWriteUnknownError } from '@/lib/financialWorkflow';
import { confirmedRecordBatch, repeatableWrite, settleZeroRowDelete } from '@/lib/recordWriteOutcome';
import { confirmedMaterialVoucherId, createMaterialVoucherOnce, materialLinesRewriteError, materialVoucherFailureMessage, sameVoucherHeader, materialVoucherMatchKeys } from '@/lib/materialVoucherOutcome';
import { useOrganization } from '@/contexts/OrganizationContext';
import { withOrg, withOrgAll } from '@/lib/orgPayload';
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
    // hermes-parity:begin w2c-material-usages — Hermes chép vùng này (public.materials_usages_v1)
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
    // hermes-parity:end w2c-material-usages
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
interface ManualUsageInput extends UsageInput {
  /** Mã bản nháp của form tạo (không gửi lên máy chủ): các lần bấm của cùng bản nháp là cùng một phiếu. */
  draft?: string;
}
interface UpsertInput extends UsageInput { job_id: string }
/**
 * Một lượt lưu vật tư của công việc, CHẠY LẠI ĐƯỢC: đọc phiếu xuất của công việc, đặt ngày / ghi chú, xoá MỌI dòng cũ rồi
 * chèn đúng bộ dòng đang nhập (không còn dòng nào thì gỡ phiếu). Tồn kho do trigger tính lại từ toàn bộ dòng đang có
 * (recompute_material_stock: nhập − xuất, không trừ dồn), nên chạy lại sau một lần chưa rõ kết quả cho cùng bộ dòng và
 * cùng tồn kho: không nhân đôi dòng, không trừ tồn hai lần. Mỗi công việc tối đa một phiếu (uq_material_usages_job), nên
 * lần chạy lại sau khi tạo đầu phiếu mất phản hồi đọc thấy phiếu đó, không tạo phiếu thứ hai. Chưa nguyên tử (đợt 10):
 * hỏng SAU khi đã xoá thì công việc tạm không còn dòng vật tư nào (tồn kho tạm cộng trả) tới lần bấm lưu lại; câu báo nói
 * rõ điều đó. Hai lượt lưu CÙNG LÚC (hai tab) vẫn có thể chồng dòng như bản trước — chỉ hàm nguyên tử ở đợt 10 chặn được.
 */
async function saveJobMaterialUsage(input: UpsertInput): Promise<string | null> {
  const { data: existing, error: readError } = await supabase.from('material_usages' as any).select('id').eq('job_id', input.job_id).maybeSingle();
  if (readError) throw readError;
  const existingId = existing ? confirmedMaterialVoucherId(existing) : null;
  if (!existingId && input.items.length === 0) return null;
  let usageId: string;
  if (existingId) {
    // Khớp 0 dòng (không thấy / không có quyền sửa) ⇒ PGRST116: từ chối rõ, chưa xoá dòng nào.
    const { data, error } = await supabase.from('material_usages' as any).update({ usage_date: input.usage_date, notes: input.notes }).eq('id', existingId).select('id').single();
    if (error) throw error;
    usageId = confirmedMaterialVoucherId(data, existingId);
    try {
      const { data: removed, error: removeError } = await supabase.from('material_usage_items' as any).delete().eq('usage_id', existingId).select('id');
      if (removeError) throw removeError;
      // Biên nhận xoá sai dạng ⇒ chưa rõ: dừng, không chèn dòng mới lên trên.
      confirmedRecordBatch(removed, Array.isArray(removed) ? removed.length : 0, 'xóa dòng vật tư công việc cũ');
    } catch (removeError) {
      throw materialLinesRewriteError(null, 'Lưu vật tư', removeError);
    }
  } else {
    const { data, error } = await supabase.from('material_usages' as any).insert({ job_id: input.job_id, usage_date: input.usage_date, notes: input.notes }).select().single();
    if (error) throw error;
    usageId = confirmedMaterialVoucherId(data);
  }
  if (input.items.length > 0) {
    const lines = input.items.map(row => ({ usage_id: usageId, material_id: row.material_id, quantity: row.quantity, unit_cost_at_usage: row.unit_cost_at_usage }));
    try {
      const { data, error } = await supabase.from('material_usage_items' as any).insert(lines).select('id');
      if (error) throw error;
      confirmedRecordBatch(data, input.items.length, 'lưu dòng vật tư công việc mới');
    } catch (error) {
      throw materialLinesRewriteError(existingId ? 'Đã xoá vật tư cũ của công việc' : 'Đã tạo phiếu xuất cho công việc', 'Lưu vật tư', error);
    }
  } else if (existingId) {
    const { data, error } = await supabase.from('material_usages' as any).delete().eq('id', existingId).select('id').single();
    if (error && (error as { code?: unknown }).code === 'PGRST116') {
      // Gỡ phiếu khớp 0 dòng: đọc lại đúng phiếu. Không còn ⇒ đã gỡ (lần trước / người khác); còn ⇒ không có quyền xoá.
      try {
        await settleZeroRowDelete('gỡ phiếu xuất công việc không còn vật tư', () => supabase.from('material_usages').select('id').eq('id', existingId).maybeSingle());
      } catch (refusal) {
        if (refusal instanceof RepeatableWriteUnknownError || !(refusal instanceof FinancialWorkflowError)) throw refusal;
        throw new FinancialWorkflowError(`Đã xoá hết vật tư của công việc. ${refusal.message}`, 'failure', [], refusal);
      }
    } else {
      if (error) throw error;
      confirmedMaterialVoucherId(data, existingId);
    }
  }
  return usageId;
}
export const useUpsertJobMaterialUsage = (options: { silent?: boolean } = {}) => {
  const qc = useQueryClient();
  const refresh = (jobId: string) => { qc.invalidateQueries({ queryKey: ['material-usages', 'by-job', jobId] }); qc.invalidateQueries({ queryKey: ['material-usages', 'list'] }); qc.invalidateQueries({ queryKey: ['materials'] }); };
  return useMutation({
    mutationFn: async (input: UpsertInput) => {
      // Đợt 8 (luật 5, cách A): không giữ dấu «chờ đối chiếu»; kết quả chưa rõ báo rõ, form không khoá, bấm lại ghi lại.
      const usageId = await repeatableWrite('lưu vật tư công việc', () => saveJobMaterialUsage(input));
      const jobId = input.job_id;
      try {
        const { forgetLegacyPending } = await import('@/lib/legacyPendingExit');
        await forgetLegacyPending({ namespace: 'material-job-usage', businessKey: jobId });
      } catch { /* Dấu bản trước không còn chặn gì; gỡ hỏng thì lần lưu sau gỡ lại. */ }
      return usageId;
    },
    onSuccess: (data, input) => { refresh(input.job_id); if (!options.silent) { if (data) toast.success('Đã lưu vật tư sử dụng cho phiếu công việc'); else toast.info('Không có vật tư cần lưu.'); } },
    onError: (error, input) => { refresh(input.job_id); if (!options.silent) toast.error('Chưa hoàn tất lưu vật tư công việc', { description: materialVoucherFailureMessage(error, 'lưu vật tư công việc') }); },
  });
};
export const useCreateMaterialUsage = () => {
  const qc = useQueryClient();
  const { selectedOrganizationId } = useOrganization();
  const refresh = () => { qc.invalidateQueries({ queryKey: ['material-usages', 'list'] }); qc.invalidateQueries({ queryKey: ['materials'] }); };
  return useMutation({
    // Đợt 9 (cách D): không giữ dấu «chờ đối chiếu»; đầu phiếu và dòng mang mã do trình duyệt sinh (xem
    // `createMaterialVoucherOnce`). Bấm lại dùng lại đúng phiếu, đúng các mã dòng: tồn (trigger tính lại) không trừ hai lần.
    mutationFn: async (input: ManualUsageInput): Promise<MaterialUsage & { replayed: boolean }> => {
      if (input.items.length === 0) throw new Error('Cần ít nhất 1 dòng vật tư');
      const { getSessionUser } = await import('@/lib/authSession');
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');
      const headerPayload = withOrg({ job_id: null, usage_date: input.usage_date, notes: input.notes }, selectedOrganizationId);
      const compare = ['material_id', 'quantity', 'unit_cost_at_usage'] as const;
      const created = await repeatableWrite('tạo phiếu xuất', () => createMaterialVoucherOnce<MaterialUsage>({
        headerTable: 'material_usages', lineTable: 'material_usage_items', parentColumn: 'usage_id', noun: 'Phiếu xuất', operation: 'tạo phiếu xuất',
        userId: user.id, organizationId: selectedOrganizationId ?? '',
        matchKeys: materialVoucherMatchKeys(input.draft, [input.usage_date, input.notes], input.items, compare),
        headerPayload, sameHeader: row => sameVoucherHeader(row, headerPayload, ['job_id', 'usage_date', 'notes']),
        items: input.items, compare,
        buildLines: header => withOrgAll(input.items.map(row => ({ usage_id: header.id, material_id: row.material_id, quantity: row.quantity, unit_cost_at_usage: row.unit_cost_at_usage })), header.organization_id as string | null | undefined),
      }));
      try { const { forgetLegacyPending } = await import('@/lib/legacyPendingExit'); await forgetLegacyPending({ namespace: 'material-manual-usage', businessKey: 'create' }); }
      catch { /* Dấu bản trước không còn chặn gì; gỡ hỏng thì lần tạo sau gỡ lại. */ }
      return { ...created.header, replayed: created.replayed };
    },
    onSuccess: usage => { refresh(); toast.success(usage.replayed ? `Phiếu xuất ${usage.code ?? ''} đã được lưu ở lần bấm trước (mã ${usage.id}); không ghi thêm.` : 'Đã tạo phiếu xuất kho'); },
    onError: error => { refresh(); toast.error('Chưa hoàn tất tạo phiếu xuất', { description: materialVoucherFailureMessage(error, 'tạo phiếu xuất') }); },
  });
};
