import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import type { Material, MaterialWithCategory } from '@/types/material';
import type { MaterialFormValues } from '@/lib/materialValidation';

interface MaterialFilters {
  search?: string;
  categoryId?: string | null;
  onlyLowStock?: boolean;
}

const KEY_LIST = (f: MaterialFilters) => ['materials', 'list', f] as const;

export const useMaterials = (filters: MaterialFilters = {}) => {
  return useQuery({
    queryKey: KEY_LIST(filters),
    queryFn: async (): Promise<MaterialWithCategory[]> => {
      let query = supabase
        .from('materials' as any)
        .select('*, category:material_categories(*)')
        .is('deleted_at', null)
        .order('name', { ascending: true });

      if (filters.categoryId) query = query.eq('category_id', filters.categoryId);

      const { data, error } = await query;
      if (error) {
        console.error('useMaterials error:', error);
        return [];
      }
      let rows = (data ?? []) as unknown as MaterialWithCategory[];

      if (filters.search?.trim()) {
        const q = filters.search.trim().toLowerCase();
        rows = rows.filter(
          (r) =>
            r.name.toLowerCase().includes(q) ||
            (r.code?.toLowerCase().includes(q) ?? false) ||
            (r.description?.toLowerCase().includes(q) ?? false)
        );
      }
      if (filters.onlyLowStock) {
        rows = rows.filter((r) => Number(r.on_hand) <= Number(r.reorder_level));
      }
      return rows;
    },
  });
};

export const useMaterial = (id: string | null | undefined) => {
  return useQuery({
    queryKey: ['materials', 'detail', id],
    queryFn: async (): Promise<MaterialWithCategory | null> => {
      if (!id) return null;
      const { data, error } = await supabase
        .from('materials' as any)
        .select('*, category:material_categories(*)')
        .eq('id', id)
        .maybeSingle();
      if (error) {
        console.error('useMaterial error:', error);
        return null;
      }
      return (data as unknown as MaterialWithCategory) ?? null;
    },
    enabled: !!id,
  });
};

export const useCreateMaterial = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: MaterialFormValues): Promise<Material> => {
      const { data, error } = await supabase
        .from('materials' as any)
        .insert({
          code: input.code?.trim() || null,
          name: input.name.trim(),
          category_id: input.category_id || null,
          unit: input.unit.trim(),
          image_url: input.image_url?.trim() || null,
          description: input.description?.trim() || null,
          reorder_level: input.reorder_level ?? 0,
        })
        .select()
        .single();
      if (error) {
        toast.error(error.message || 'Không thể tạo vật tư');
        throw error;
      }
      return data as unknown as Material;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['materials'] });
      toast.success('Đã tạo vật tư');
    },
  });
};

export const useUpdateMaterial = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: Partial<MaterialFormValues> }) => {
      const payload: Record<string, unknown> = {};
      if (updates.code !== undefined) payload.code = updates.code?.trim() || null;
      if (updates.name !== undefined) payload.name = updates.name.trim();
      if (updates.category_id !== undefined) payload.category_id = updates.category_id || null;
      if (updates.unit !== undefined) payload.unit = updates.unit.trim();
      if (updates.image_url !== undefined) payload.image_url = updates.image_url?.trim() || null;
      if (updates.description !== undefined) payload.description = updates.description?.trim() || null;
      if (updates.reorder_level !== undefined) payload.reorder_level = updates.reorder_level;

      const { data, error } = await supabase
        .from('materials' as any)
        .update(payload)
        .eq('id', id)
        .select()
        .single();
      if (error) {
        toast.error(error.message || 'Không thể cập nhật vật tư');
        throw error;
      }
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['materials'] });
      toast.success('Đã cập nhật vật tư');
    },
  });
};

export const useSoftDeleteMaterial = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from('materials' as any)
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', id);
      if (error) {
        toast.error(error.message || 'Không thể xoá vật tư');
        throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['materials'] });
      toast.success('Đã xoá vật tư');
    },
  });
};
