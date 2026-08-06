import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { getSessionUser } from "@/lib/authSession";
import { jsonProp } from "@/lib/jsonValue";

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
  /** Với staff: id khu vực mặc định (area.name khớp username). FE sẽ lock filter.area_id vào giá trị này. */
  defaultAreaId: string | null;
}

export const useMyContext = () => {
  return useQuery<MyContext>({
    queryKey: ['my-context'],
    queryFn: async () => {
      const user = await getSessionUser();
      if (!user) return { isSuper: false, isStaff: false, ownerId: null, defaultAreaId: null };

      // RLS của staff_assignments chỉ cho owner đọc — dùng RPC SECURITY DEFINER
      // để staff thấy được context của chính mình.
      const { data, error } = await supabase.rpc('get_my_context');
      if (error || !data) {
        return { isSuper: false, isStaff: false, ownerId: user.id, defaultAreaId: null };
      }
      const result = Array.isArray(data) ? data[0] : data;
      const ownerId = jsonProp(result, 'owner_id');
      const defaultAreaId = jsonProp(result, 'default_area_id');
      return {
        isSuper: !!jsonProp(result, 'is_super'),
        isStaff: !!jsonProp(result, 'is_staff'),
        ownerId: typeof ownerId === 'string' ? ownerId : user.id,
        defaultAreaId: typeof defaultAreaId === 'string' ? defaultAreaId : null,
      };
    },
    staleTime: 5 * 60 * 1000,
  });
};
