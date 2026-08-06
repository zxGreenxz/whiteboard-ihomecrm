import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import type { Material, MaterialAdjustment, MaterialAdjustmentItem } from '@/types/material';
import { todayISO } from '@/lib/collect';

export interface MaterialAdjustmentWithItems extends MaterialAdjustment {
  items: (MaterialAdjustmentItem & { material: Pick<Material, 'id' | 'name' | 'unit'> | null })[];
}

const KEY = ['material-adjustments'] as const;

export const useMaterialAdjustments = () => {
  return useQuery({
    queryKey: [...KEY, 'list'],
    queryFn: async (): Promise<MaterialAdjustmentWithItems[]> => {
      const { data, error } = await supabase
        .from('material_adjustments' as any)
        .select('*, items:material_adjustment_items(*, material:materials(id,name,unit))')
        .order('adjustment_date', { ascending: false })
        .order('created_at', { ascending: false });
      if (error) {
        console.error('useMaterialAdjustments error:', error);
        return [];
      }
      return (data ?? []) as unknown as MaterialAdjustmentWithItems[];
    },
  });
};

interface AdjustmentInput {
  adjustment_date: string;
  type: 'IN' | 'OUT';
  reason: string | null;
  items: Array<{ material_id: string; quantity: number }>;
}

export const useCreateMaterialAdjustment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: AdjustmentInput) => {
      const { data: header, error: hErr } = await supabase
        .from('material_adjustments' as any)
        .insert({
          adjustment_date: input.adjustment_date,
          type: input.type,
          reason: input.reason,
        })
        .select()
        .single();
      if (hErr || !header) {
        toast.error(hErr?.message || 'Không thể tạo phiếu kiểm kê');
        throw hErr;
      }
      const headerRow = header as unknown as MaterialAdjustment;
      if (input.items.length > 0) {
        const { error: iErr } = await supabase
          .from('material_adjustment_items' as any)
          .insert(
            input.items.map((it) => ({
              adjustment_id: headerRow.id,
              material_id: it.material_id,
              quantity: it.quantity,
            })),
          );
        if (iErr) {
          await supabase.from('material_adjustments' as any).delete().eq('id', headerRow.id);
          toast.error(iErr.message || 'Không thể tạo dòng phiếu');
          throw iErr;
        }
      }
      return headerRow;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ['materials'] });
      toast.success('Đã tạo phiếu kiểm kê');
    },
  });
};

/**
 * "SET" kiểm đếm: đặt tồn hiện tại của material về `targetQuantity`.
 * Triển khai bằng cách tạo 1 phiếu IN hoặc OUT với delta = target - current.
 * Reason mặc định: "Kiểm kê — đặt lại tồn".
 */
export const useSetMaterialStock = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      material_id: string;
      target_quantity: number;
      current_quantity: number;
      reason?: string;
    }) => {
      const delta = input.target_quantity - input.current_quantity;
      if (delta === 0) {
        toast.info('Tồn đã khớp — không cần điều chỉnh');
        return null;
      }
      const type: 'IN' | 'OUT' = delta > 0 ? 'IN' : 'OUT';
      const qty = Math.abs(delta);
      const { data: header, error: hErr } = await supabase
        .from('material_adjustments' as any)
        .insert({
          adjustment_date: todayISO(),
          type,
          reason: input.reason ?? 'Kiểm kê — đặt lại tồn',
        })
        .select()
        .single();
      if (hErr || !header) {
        toast.error(hErr?.message || 'Không thể tạo phiếu kiểm kê');
        throw hErr;
      }
      const { error: iErr } = await supabase
        .from('material_adjustment_items' as any)
        .insert({
          adjustment_id: (header as any).id,
          material_id: input.material_id,
          quantity: qty,
        });
      if (iErr) {
        await supabase.from('material_adjustments' as any).delete().eq('id', (header as any).id);
        toast.error(iErr.message || 'Không thể tạo dòng phiếu');
        throw iErr;
      }
      return header;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ['materials'] });
      toast.success('Đã cập nhật tồn kho theo kiểm kê');
    },
  });
};

export const useDeleteMaterialAdjustment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from('material_adjustments' as any)
        .delete()
        .eq('id', id);
      if (error) {
        toast.error(error.message || 'Không thể xoá phiếu kiểm kê');
        throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ['materials'] });
      toast.success('Đã xoá phiếu kiểm kê');
    },
  });
};
