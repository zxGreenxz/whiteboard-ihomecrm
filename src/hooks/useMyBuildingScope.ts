import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useMyContext } from '@/hooks/useMyContext';
import { useIsAdmin } from '@/hooks/useIsAdmin';

/**
 * Mirror logic của `staff_in_building(owner, building_id)` ở DB.
 *
 * Trả về:
 *   - canManageAll: caller là owner/admin/staff "tất cả tòa" → toàn quyền.
 *   - buildingIds: set các building_id staff được giao (chỉ có ý nghĩa khi
 *     canManageAll=false).
 *   - hasAnyScope: canManageAll || có ít nhất 1 building → quyết định ẩn
 *     nút "Thêm" (staff không tòa nào không tạo được gì).
 *   - canManageBuilding(b): helper per-row để ẩn nút Sửa/Xoá.
 */
export interface MyBuildingScope {
  canManageAll: boolean;
  buildingIds: Set<string>;
  hasAnyScope: boolean;
  canManageBuilding: (buildingId: string | null | undefined) => boolean;
  isLoading: boolean;
}

const ALL: MyBuildingScope = {
  canManageAll: true,
  buildingIds: new Set(),
  hasAnyScope: true,
  canManageBuilding: () => true,
  isLoading: false,
};

const NONE: MyBuildingScope = {
  canManageAll: false,
  buildingIds: new Set(),
  hasAnyScope: false,
  canManageBuilding: () => false,
  isLoading: false,
};

export const useMyBuildingScope = (): MyBuildingScope => {
  const { data: ctx, isLoading: ctxLoading } = useMyContext();
  const { data: isAdmin, isLoading: adminLoading } = useIsAdmin();

  const { data: rows, isLoading: assignmentsLoading } = useQuery({
    queryKey: ['my-assignments'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_my_assignments');
      if (error) {
        console.error('get_my_assignments error:', error);
        return [] as Array<{ user_id: string; building_id: string | null }>;
      }
      return (data || []) as Array<{ user_id: string; building_id: string | null }>;
    },
    staleTime: 5 * 60 * 1000,
  });

  const loading = ctxLoading || adminLoading || assignmentsLoading;

  // Chờ đủ context trước khi quyết định — nếu mặc định ALL trong lúc loading
  // thì nút action sẽ flash hiện rồi ẩn, không đẹp.
  if (loading) return { ...NONE, isLoading: true };

  // Owner / super admin / admin / không phải staff → toàn quyền.
  if (!ctx || isAdmin || ctx.isSuper || !ctx.isStaff) return ALL;

  const list = rows || [];
  const canAll = list.some((r) => r.building_id === null);
  if (canAll) return ALL;

  const ids = new Set<string>();
  for (const r of list) {
    if (r.building_id) ids.add(r.building_id);
  }
  const hasAny = ids.size > 0;

  return {
    canManageAll: false,
    buildingIds: ids,
    hasAnyScope: hasAny,
    canManageBuilding: (bid) => !!bid && ids.has(bid),
    isLoading: false,
  };
};
