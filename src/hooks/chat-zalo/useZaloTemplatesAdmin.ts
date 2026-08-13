// CRUD mẫu tin (zalo_message_templates) — nguồn sự thật là DB của TỔ CHỨC.
// Guard quyền chat_zalo.manage_templates nằm ở RPC (RBAC v3 theo org).
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { QK, useZaloOrgId } from '@/hooks/useZaloChat';

export interface ZaloTemplateFull {
  id: string; title: string; body: string; category: string | null;
  color: string | null; sortOrder: number; isActive: boolean;
}

export function useZaloTemplatesAdmin(enabled: boolean) {
  const orgId = useZaloOrgId();
  return useQuery({
    queryKey: [...QK.templates, orgId, 'admin'],
    enabled: enabled && !!orgId,
    retry: 1,
    queryFn: async (): Promise<ZaloTemplateFull[]> => {
      const { data, error } = await supabase
        .from('zalo_message_templates')
        .select('id, title, body, category, color, sort_order, is_active')
        .eq('organization_id', orgId!)
        .order('sort_order', { ascending: true });
      if (error) throw error;
      return (data || []).map((t) => ({
        id: t.id, title: t.title, body: t.body || '', category: t.category,
        color: t.color, sortOrder: t.sort_order, isActive: t.is_active,
      }));
    },
  });
}

export function useSaveTemplate() {
  const qc = useQueryClient();
  const orgId = useZaloOrgId();
  return useMutation({
    mutationFn: async (v: { id?: string; title: string; body: string; category?: string; color?: string; sortOrder?: number; isActive?: boolean }) => {
      const { data, error } = await supabase.rpc('zalo_save_template', {
        p_title: v.title,
        p_body: v.body,
        p_id: v.id,
        p_category: v.category,
        p_color: v.color,
        p_sort_order: v.sortOrder ?? 0,
        p_is_active: v.isActive ?? true,
        p_organization_id: orgId ?? undefined,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QK.templates });
      toast.success('Đã lưu mẫu tin');
    },
    onError: (e: Error) => { toast.error(e?.message || 'Không lưu được mẫu tin'); },
  });
}

export function useDeleteTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc('zalo_delete_template', { p_id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QK.templates });
      toast.success('Đã xoá mẫu tin');
    },
    onError: (e: Error) => { toast.error(e?.message || 'Không xoá được mẫu tin'); },
  });
}
