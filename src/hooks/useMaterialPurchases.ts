import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import type { Material, MaterialPurchase, MaterialPurchaseItem } from '@/types/material';

export interface MaterialPurchaseWithItems extends MaterialPurchase {
  supplier: { id: string; name: string } | null;
  items: (MaterialPurchaseItem & { material: Pick<Material, 'id' | 'name' | 'unit'> | null })[];
}

interface PurchaseInput {
  purchase_date: string; // YYYY-MM-DD
  supplier_id: string | null;
  notes: string | null;
  items: Array<{ material_id: string; quantity: number; unit_price: number }>;
}

const KEY = ['material-purchases'] as const;

export const useMaterialPurchases = (filters: { from?: string; to?: string } = {}) => {
  return useQuery({
    queryKey: [...KEY, 'list', filters],
    queryFn: async (): Promise<MaterialPurchaseWithItems[]> => {
      let q = supabase
        .from('material_purchases' as any)
        .select(
          '*, supplier:suppliers(id,name), items:material_purchase_items(*, material:materials(id,name,unit))',
        )
        .order('purchase_date', { ascending: false })
        .order('created_at', { ascending: false });
      if (filters.from) q = q.gte('purchase_date', filters.from);
      if (filters.to) q = q.lte('purchase_date', filters.to);
      const { data, error } = await q;
      if (error) {
        console.error('useMaterialPurchases error:', error);
        return [];
      }
      return (data ?? []) as unknown as MaterialPurchaseWithItems[];
    },
  });
};

export const useCreateMaterialPurchase = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: PurchaseInput) => {
      const { data: header, error: hErr } = await supabase
        .from('material_purchases' as any)
        .insert({
          purchase_date: input.purchase_date,
          supplier_id: input.supplier_id,
          notes: input.notes,
        })
        .select()
        .single();
      if (hErr || !header) {
        toast.error(hErr?.message || 'Không thể tạo phiếu nhập');
        throw hErr;
      }
      const headerRow = header as unknown as MaterialPurchase;

      if (input.items.length > 0) {
        const { error: iErr } = await supabase
          .from('material_purchase_items' as any)
          .insert(
            input.items.map((it) => ({
              purchase_id: headerRow.id,
              material_id: it.material_id,
              quantity: it.quantity,
              unit_price: it.unit_price,
            })),
          );
        if (iErr) {
          await supabase.from('material_purchases' as any).delete().eq('id', headerRow.id);
          toast.error(iErr.message || 'Không thể tạo dòng phiếu nhập');
          throw iErr;
        }
      }
      return headerRow;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ['materials'] });
      toast.success('Đã tạo phiếu nhập kho');
    },
  });
};

export const useUpdateMaterialPurchase = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: PurchaseInput }) => {
      const { error: uErr } = await supabase
        .from('material_purchases' as any)
        .update({
          purchase_date: input.purchase_date,
          supplier_id: input.supplier_id,
          notes: input.notes,
        })
        .eq('id', id);
      if (uErr) {
        toast.error(uErr.message || 'Không thể cập nhật phiếu nhập');
        throw uErr;
      }

      // Replace items: delete then insert
      const { error: dErr } = await supabase
        .from('material_purchase_items' as any)
        .delete()
        .eq('purchase_id', id);
      if (dErr) {
        toast.error(dErr.message || 'Không thể xoá dòng cũ');
        throw dErr;
      }

      if (input.items.length > 0) {
        const { error: iErr } = await supabase
          .from('material_purchase_items' as any)
          .insert(
            input.items.map((it) => ({
              purchase_id: id,
              material_id: it.material_id,
              quantity: it.quantity,
              unit_price: it.unit_price,
            })),
          );
        if (iErr) {
          toast.error(iErr.message || 'Không thể tạo dòng mới');
          throw iErr;
        }
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ['materials'] });
      toast.success('Đã cập nhật phiếu nhập');
    },
  });
};

export const useDeleteMaterialPurchase = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from('material_purchases' as any)
        .delete()
        .eq('id', id);
      if (error) {
        toast.error(error.message || 'Không thể xoá phiếu nhập');
        throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ['materials'] });
      toast.success('Đã xoá phiếu nhập');
    },
  });
};
