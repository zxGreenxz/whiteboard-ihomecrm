import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import type { MaterialCategory } from '@/types/material';

const KEY = ['material-categories'] as const;

export const useMaterialCategories = () => {
  return useQuery({
    queryKey: KEY,
    queryFn: async (): Promise<MaterialCategory[]> => {
      const { data, error } = await supabase
        .from('material_categories' as any)
        .select('*')
        .order('name', { ascending: true });
      if (error) {
        console.error('useMaterialCategories error:', error);
        return [];
      }
      return (data ?? []) as unknown as MaterialCategory[];
    },
  });
};

export const useCreateMaterialCategory = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { name: string; description?: string | null }) => {
      const { data, error } = await supabase
        .from('material_categories' as any)
        .insert({ name: input.name, description: input.description ?? null })
        .select()
        .single();
      if (error) {
        toast.error(error.message || 'Không thể tạo danh mục');
        throw error;
      }
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      toast.success('Đã tạo danh mục vật tư');
    },
  });
};

export const useUpdateMaterialCategory = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: { name?: string; description?: string | null } }) => {
      const { data, error } = await supabase
        .from('material_categories' as any)
        .update(updates)
        .eq('id', id)
        .select()
        .single();
      if (error) {
        toast.error(error.message || 'Không thể cập nhật danh mục');
        throw error;
      }
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ['materials'] });
      toast.success('Đã cập nhật danh mục');
    },
  });
};

export const useDeleteMaterialCategory = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data: inUse } = await supabase
        .from('materials' as any)
        .select('id')
        .eq('category_id', id)
        .is('deleted_at', null)
        .limit(1);
      if (inUse && inUse.length > 0) {
        const msg = 'Không thể xoá: danh mục đang được dùng cho vật tư';
        toast.error(msg);
        throw new Error(msg);
      }
      const { error } = await supabase.from('material_categories' as any).delete().eq('id', id);
      if (error) {
        toast.error(error.message || 'Không thể xoá danh mục');
        throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      toast.success('Đã xoá danh mục');
    },
  });
};
