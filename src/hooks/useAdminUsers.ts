import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

export interface AdminUser {
  id: string;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  is_active: boolean | null;
  is_super_admin: boolean;
  assignments_count: number;
  created_at: string;
}

// Liệt kê user trong tổ chức (profiles + super_admins flag + assignments_count).
// Caller cần là super_admin để chạy (RLS trên profiles allow admin).
export const useAdminUsers = () => {
  return useQuery({
    queryKey: ['admin-users'],
    queryFn: async (): Promise<AdminUser[]> => {
      const { data: profiles, error } = await supabase
        .from('profiles')
        .select('id, full_name, email, phone, is_active, created_at')
        .order('created_at', { ascending: false });
      if (error) throw error;

      const [{ data: supers }, { data: assignments }] = await Promise.all([
        supabase.from('super_admins').select('user_id'),
        supabase.from('staff_assignments').select('staff_id'),
      ]);

      const superSet = new Set((supers ?? []).map((s) => (s as any).user_id));
      const assignCount: Record<string, number> = {};
      for (const a of (assignments ?? []) as any[]) {
        assignCount[a.staff_id] = (assignCount[a.staff_id] ?? 0) + 1;
      }

      return (profiles ?? []).map((p: any) => ({
        id: p.id,
        full_name: p.full_name,
        email: p.email,
        phone: p.phone,
        is_active: p.is_active,
        is_super_admin: superSet.has(p.id),
        assignments_count: assignCount[p.id] ?? 0,
        created_at: p.created_at,
      }));
    },
  });
};

interface CreateUserPayload {
  email: string;
  password: string;
  full_name?: string;
  phone?: string;
}

// Gọi edge function admin-create-user (yêu cầu caller là super_admin trên DB).
export const useCreateAdminUser = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: CreateUserPayload) => {
      const { data, error } = await supabase.functions.invoke('admin-create-user', {
        body: payload,
      });
      if (error) throw new Error(error.message || 'Tạo user thất bại');
      if ((data as any)?.error) throw new Error((data as any).error);
      return data;
    },
    onSuccess: () => {
      toast.success('Đã tạo tài khoản mới');
      qc.invalidateQueries({ queryKey: ['admin-users'] });
    },
    onError: (e: any) => {
      toast.error('Không thể tạo tài khoản', { description: e?.message ?? String(e) });
    },
  });
};
