import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useMyContext } from '@/hooks/useMyContext';

/**
 * Permissions của caller hiện tại, dạng `{ moduleKey: { actionKey: boolean } }`.
 *
 * - Owner & super admin: trả về sentinel `__superadmin: true` → mọi quyền true.
 * - Staff: lấy từ `roles.permissions` (JSONB) qua bảng `staff_assignments`.
 *
 * FE dùng helper `can(perms, moduleKey, actionKey)` để gate các nút trong UI.
 * Backend RLS đã tự enforce qua `staff_can()` cho các action chuẩn
 * (view/create/edit/delete). `record_payment` là action mới — hiện tại chỉ
 * gate UI (FE check), không có hậu kiểm DB.
 */
export type PermissionsMap = Record<string, Record<string, boolean>> & {
  __superadmin?: boolean;
};

export const useMyPermissions = () => {
  const { data: ctx } = useMyContext();

  return useQuery<PermissionsMap>({
    queryKey: ['my-permissions', ctx?.isStaff, ctx?.isSuper, ctx?.ownerId],
    enabled: !!ctx,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      if (!ctx) return {};
      // Owner & super admin: full quyền.
      if (!ctx.isStaff) return { __superadmin: true };

      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return {};

      const { data, error } = await (supabase as any)
        .from('staff_assignments')
        .select('role:roles(permissions)')
        .eq('staff_id', user.id)
        .eq('user_id', ctx.ownerId)
        .limit(1)
        .maybeSingle();
      if (error || !data) return {};

      const perms = (data as any).role?.permissions;
      if (perms && typeof perms === 'object' && !Array.isArray(perms)) {
        return perms as PermissionsMap;
      }
      return {};
    },
  });
};

/** Helper gate UI: trả true khi user được phép `actionKey` trên `moduleKey`. */
export const can = (
  perms: PermissionsMap | undefined,
  moduleKey: string,
  actionKey: string,
): boolean => {
  if (!perms) return false;
  if (perms.__superadmin === true) return true;
  return !!perms[moduleKey]?.[actionKey];
};
