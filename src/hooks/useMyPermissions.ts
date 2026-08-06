import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Permissions của caller hiện tại, dạng `{ moduleKey: { actionKey: boolean } }`.
 *
 * - Owner & super admin: backend trả sentinel `__superadmin: true` → mọi quyền true.
 * - Staff: backend trả `roles.permissions` (JSONB) của role được gán.
 *
 * Dùng RPC `get_my_permissions()` (SECURITY DEFINER) vì RLS của
 * staff_assignments chỉ cho owner đọc — staff sẽ nhận `[]` nếu query trực
 * tiếp bảng và mất hết quyền UI.
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
  return useQuery<PermissionsMap>({
    queryKey: ['my-permissions'],
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_my_permissions');
      if (error || !data) return {};
      if (typeof data === 'object' && !Array.isArray(data)) {
        return data as PermissionsMap;
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
