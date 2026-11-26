import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import type { Material, MaterialUsage, MaterialUsageItem } from '@/types/material';
import { FinancialWorkflowError } from '@/lib/financialWorkflow';
import { repeatableWrite } from '@/lib/recordWriteOutcome';
import { confirmReplacedHeader, confirmReplacedMaterialLines, createMaterialVoucherOnce, materialReplaceUnknown, materialServerRefusal, materialVoucherFailureMessage, sameVoucherHeader, materialVoucherMatchKeys } from '@/lib/materialVoucherOutcome';
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
type UsageLine = UsageInput['items'][number];
type SaveJobUsageRpc = (name: 'save_job_material_usage_v1', args: { p_job_id: string; p_usage_date: string; p_notes: string | null; p_items: UsageLine[] }) =>
  PromiseLike<{ data: unknown; error: unknown }>;
const JOB_USAGE_OPERATION = 'lưu vật tư công việc';
const JOB_USAGE_ADVICE = 'Máy chủ ghi cả bộ vật tư của công việc trong một lần: lần trước hoặc chưa ghi gì, hoặc đã ghi đủ, tồn kho tính theo đúng bộ đó. Bấm lại «Lưu vật tư» để ghi đúng các dòng đang nhập; không nhân đôi dòng, tồn kho không trừ hai lần.';
/**
 * Một lượt lưu vật tư của công việc, CHẠY LẠI ĐƯỢC. Đợt 10b: MỘT lời gọi `save_job_material_usage_v1` (SECURITY INVOKER: RLS
 * và trigger như ghi thẳng; khoá tư vấn theo công việc) trong một giao dịch: tra phiếu xuất của công việc (tối đa một phiếu,
 * uq_material_usages_job), chưa có thì tạo, có thì đặt ngày / ghi chú, xoá MỌI dòng cũ rồi chèn đúng bộ dòng đang nhập; bộ rỗng
 * thì gỡ phiếu. Hoặc chưa ghi gì, hoặc đã ghi đủ; tồn kho do trigger tính lại từ toàn bộ dòng đang có (nhập − xuất), nên chạy
 * lại sau một lần chưa rõ cho cùng bộ dòng và cùng tồn kho, kể cả hai lần lưu cùng lúc (khoá tư vấn xếp hàng). Không gửi
 * organization_id: trigger suy công ty. Trả mã phiếu (đã gỡ thì mã phiếu vừa gỡ), `null` khi không có gì cần lưu.
 */
async function saveJobMaterialUsage(input: UpsertInput): Promise<string | null> {
  const items: UsageLine[] = input.items.map(row => ({ material_id: row.material_id, quantity: row.quantity, unit_cost_at_usage: row.unit_cost_at_usage }));
  const client = supabase as unknown as { rpc: SaveJobUsageRpc };
  const { data, error } = await client.rpc('save_job_material_usage_v1', { p_job_id: input.job_id, p_usage_date: input.usage_date, p_notes: input.notes, p_items: items });
  // Từ chối rõ (P0002 không sửa được phiếu, 42501, 23514…): cả giao dịch đã lùi, vật tư cũ còn nguyên.
  if (error) throw materialServerRefusal(error);
  const mismatch = () => new FinancialWorkflowError('Biên nhận vật tư của công việc chưa khớp bộ dòng đã gửi.', 'unknown', [], new TypeError('Mismatched job material usage receipt'));
  const reply = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : null;
  if (!reply || typeof reply.removed !== 'boolean' || !Array.isArray(reply.items)) throw mismatch();
  const lines: unknown[] = reply.items;
  const usageId = reply.usage_id;
  if (usageId === null) {
    // Công việc chưa có phiếu và bộ rỗng: máy chủ không ghi gì («Không có vật tư cần lưu»).
    if (items.length || reply.removed || reply.usage !== null || lines.length) throw mismatch();
    return null;
  }
  if (typeof usageId !== 'string' || !usageId) throw mismatch();
  if (reply.removed) {
    // Bộ rỗng: máy chủ đã xoá hết dòng và gỡ phiếu trong cùng giao dịch.
    if (items.length || reply.usage !== null || lines.length) throw mismatch();
    return usageId;
  }
  confirmReplacedHeader(reply.usage, usageId, { job_id: input.job_id, usage_date: input.usage_date, notes: input.notes }, ['job_id', 'usage_date', 'notes']);
  if (!items.length) {
    if (lines.length) throw mismatch();
    // Như trước đợt 10b: dòng đã xoá hết, phiếu rỗng còn lại vì tài khoản sửa được nhưng không được xoá phiếu xuất.
    throw new FinancialWorkflowError(`Đã xoá hết vật tư của công việc nhưng chưa gỡ được phiếu xuất rỗng (mã ${usageId}): tài khoản có thể chưa có quyền xoá phiếu. Phiếu đó không còn dòng nào nên không làm đổi tồn kho.`, 'failure', []);
  }
  confirmReplacedMaterialLines(lines, 'usage_id', usageId, items, ['material_id', 'quantity', 'unit_cost_at_usage']);
  return usageId;
}
export const useUpsertJobMaterialUsage = (options: { silent?: boolean } = {}) => {
  const qc = useQueryClient();
  const refresh = (jobId: string) => { qc.invalidateQueries({ queryKey: ['material-usages', 'by-job', jobId] }); qc.invalidateQueries({ queryKey: ['material-usages', 'list'] }); qc.invalidateQueries({ queryKey: ['materials'] }); };
  return useMutation({
    mutationFn: async (input: UpsertInput) => {
      // Đợt 8 (luật 5, cách A): không giữ dấu «chờ đối chiếu»; kết quả chưa rõ báo rõ, form không khoá, bấm lại ghi lại.
      const usageId = await repeatableWrite(JOB_USAGE_OPERATION, () => saveJobMaterialUsage(input))
        .catch((error: unknown) => { throw materialReplaceUnknown(error, JOB_USAGE_OPERATION, JOB_USAGE_ADVICE); });
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
