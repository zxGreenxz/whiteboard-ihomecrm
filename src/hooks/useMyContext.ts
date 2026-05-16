import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Phân loại user hiện tại để FE biết nên hiển thị gì:
 * - `isSuper`: tài khoản nằm trong `super_admins` (bypass RLS toàn bộ).
 * - `isStaff`: caller là nhân viên (có row trong `staff_assignments`
 *   với staff_id = caller AND user_id ≠ caller).
 * - `ownerId`: id của tài khoản chủ dữ liệu (owner) mà caller đang xem.
 *   - Owner & super admin: chính caller.
 *   - Staff: lấy từ `staff_assignments.user_id`.
 */
export interface MyContext {
  isSuper: boolean;
  isStaff: boolean;
  ownerId: string | null;
}

export const useMyContext = () => {
  return useQuery<MyContext>({
    queryKey: ['my-context'],
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return { isSuper: false, isStaff: false, ownerId: null };

      const { data: superFlag } = await (supabase.rpc as any)('is_super_admin');
      const isSuper = !!superFlag;

      if (isSuper) {
        return { isSuper: true, isStaff: false, ownerId: user.id };
      }

      const { data: rows } = await supabase
        .from('staff_assignments')
        .select('user_id')
        .eq('staff_id', user.id);

      const otherOwner = (rows ?? []).find((r) => r.user_id !== user.id);
      if (otherOwner) {
        return { isSuper: false, isStaff: true, ownerId: otherOwner.user_id };
      }

      return { isSuper: false, isStaff: false, ownerId: user.id };
    },
    staleTime: 5 * 60 * 1000,
  });
};
