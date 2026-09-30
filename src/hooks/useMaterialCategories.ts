import {confirmedRecordId,recordWriteMessage} from '@/lib/recordWriteOutcome';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import type { MaterialCategory } from '@/types/material';
import { friendlyError } from '@/lib/friendlyError';

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
        throw error;
      }
      if (!Array.isArray(data)) throw new Error('Chưa xác nhận được danh mục vật tư. Tải lại danh sách trước khi chọn.');
      return data as unknown as MaterialCategory[];
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
        throw error;
      }
      confirmedRecordId(data,'tạo danh mục vật tư');
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      toast.success('Đã tạo danh mục vật tư');
    },
    onError: error => { toast.error(recordWriteMessage(error,'tạo danh mục vật tư')); },
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
        throw error;
      }
      confirmedRecordId(data,'cập nhật danh mục vật tư',id);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ['materials'] });
      toast.success('Đã cập nhật danh mục');
    },
    onError: error => { toast.error(recordWriteMessage(error,'cập nhật danh mục vật tư')); },
  });
};

export const useDeleteMaterialCategory = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data: inUse, error: checkError } = await supabase
        .from('materials' as any)
        .select('id')
        .eq('category_id', id)
        .is('deleted_at', null)
        .limit(1);
      if (checkError) throw checkError;
      if (!Array.isArray(inUse)) throw new Error('Chưa xác nhận được vật tư đang dùng danh mục. Tải lại trước khi xóa.');
      if (inUse.length > 0) {
        const msg = 'Không thể xoá: danh mục đang được dùng cho vật tư';
        throw new Error(msg);
      }
      const { data, error } = await supabase.from('material_categories' as any).delete().eq('id', id).select('id').single();
      if (error) {
        throw error;
      }
      confirmedRecordId(data,'xóa danh mục vật tư',id);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      toast.success('Đã xoá danh mục');
    },
    onError: error => { const feedback = friendlyError(error, 'Chưa xóa được danh mục vật tư', { operation: 'xóa danh mục vật tư', rules: [{ message: 'Không thể xoá: danh mục đang được dùng cho vật tư', description: 'Danh mục đang được dùng cho vật tư. Chuyển vật tư sang danh mục khác trước khi xóa.' }] }); toast.error(feedback.title, { description: feedback.description }); },
  });
};
