import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import type { Material, MaterialUsage, MaterialUsageItem } from '@/types/material';

export interface MaterialUsageWithItems extends MaterialUsage {
  items: (MaterialUsageItem & { material: Pick<Material, 'id' | 'name' | 'unit'> | null })[];
}

export interface MaterialUsageWithJob extends MaterialUsageWithItems {
  job: { id: string; code: string; title: string } | null;
}

export const useMaterialUsages = () => {
  return useQuery({
    queryKey: ['material-usages', 'list'],
    queryFn: async (): Promise<MaterialUsageWithJob[]> => {
      const { data, error } = await supabase
        .from('material_usages' as any)
        .select(
          '*, items:material_usage_items(*, material:materials(id,name,unit)), job:jobs(id,code,title)',
        )
        .order('usage_date', { ascending: false })
        .order('created_at', { ascending: false });
      if (error) {
        console.error('useMaterialUsages error:', error);
        return [];
      }
      return (data ?? []) as unknown as MaterialUsageWithJob[];
    },
  });
};

export const useMaterialUsageByJob = (jobId: string | null | undefined) => {
  return useQuery({
    queryKey: ['material-usages', 'by-job', jobId],
    queryFn: async (): Promise<MaterialUsageWithItems | null> => {
      if (!jobId) return null;
      const { data, error } = await supabase
        .from('material_usages' as any)
        .select('*, items:material_usage_items(*, material:materials(id,name,unit))')
        .eq('job_id', jobId)
        .maybeSingle();
      if (error) {
        console.error('useMaterialUsageByJob error:', error);
        return null;
      }
      return (data as unknown as MaterialUsageWithItems) ?? null;
    },
    enabled: !!jobId,
  });
};

interface UpsertInput {
  job_id: string;
  usage_date: string;
  notes: string | null;
  items: Array<{ material_id: string; quantity: number; unit_cost_at_usage: number }>;
}

export const useUpsertJobMaterialUsage = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpsertInput) => {
      const { data: existing } = await supabase
        .from('material_usages' as any)
        .select('id')
        .eq('job_id', input.job_id)
        .maybeSingle();
      const existingId = (existing as any)?.id as string | undefined;

      let usageId: string;
      if (existingId) {
        const { error: uErr } = await supabase
          .from('material_usages' as any)
          .update({ usage_date: input.usage_date, notes: input.notes })
          .eq('id', existingId);
        if (uErr) {
          toast.error(uErr.message || 'Không thể cập nhật phiếu xuất');
          throw uErr;
        }
        const { error: dErr } = await supabase
          .from('material_usage_items' as any)
          .delete()
          .eq('usage_id', existingId);
        if (dErr) {
          toast.error(dErr.message || 'Không thể xoá dòng cũ');
          throw dErr;
        }
        usageId = existingId;
      } else {
        if (input.items.length === 0) {
          // Nothing to do
          return null;
        }
        const { data: ins, error: iErr } = await supabase
          .from('material_usages' as any)
          .insert({
            job_id: input.job_id,
            usage_date: input.usage_date,
            notes: input.notes,
          })
          .select()
          .single();
        if (iErr || !ins) {
          toast.error(iErr?.message || 'Không thể tạo phiếu xuất');
          throw iErr;
        }
        usageId = (ins as any).id as string;
      }

      if (input.items.length > 0) {
        const { error: insItErr } = await supabase
          .from('material_usage_items' as any)
          .insert(
            input.items.map((it) => ({
              usage_id: usageId,
              material_id: it.material_id,
              quantity: it.quantity,
              unit_cost_at_usage: it.unit_cost_at_usage,
            })),
          );
        if (insItErr) {
          toast.error(insItErr.message || 'Không thể tạo dòng vật tư');
          throw insItErr;
        }
      } else if (existingId) {
        // Empty items + had existing → delete the header so we don't keep an empty usage row
        await supabase.from('material_usages' as any).delete().eq('id', existingId);
      }

      return usageId;
    },
    onSuccess: (_d, input) => {
      qc.invalidateQueries({ queryKey: ['material-usages', 'by-job', input.job_id] });
      qc.invalidateQueries({ queryKey: ['materials'] });
      toast.success('Đã lưu vật tư sử dụng cho phiếu công việc');
    },
  });
};
