import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

// Shape trả về của SQL public.effective_permissions(uuid):
//   { "__all": true }                            -- super admin hoặc admin
//   { "contracts": ["view","edit","terminate"], "invoices": [...] }
export interface EffectivePermissions {
  hasAll: boolean;
  byResource: Record<string, Set<string>>;
}

const parsePermissions = (raw: unknown): EffectivePermissions => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { hasAll: false, byResource: {} };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.__all === true) {
    return { hasAll: true, byResource: {} };
  }
  const byResource: Record<string, Set<string>> = {};
  for (const [resource, actions] of Object.entries(obj)) {
    if (Array.isArray(actions)) {
      byResource[resource] = new Set(actions.filter((a): a is string => typeof a === "string"));
    }
  }
  return { hasAll: false, byResource };
};

// Quyền hiệu dụng của user hiện tại (role baseline ± per-user overrides).
// Super admin / tenant admin sẽ trả hasAll = true.
export const useEffectivePermissions = (): UseQueryResult<EffectivePermissions> => {
  return useQuery({
    queryKey: ["auth", "effective_permissions"],
    queryFn: async (): Promise<EffectivePermissions> => {
      const { data, error } = await (supabase as any).rpc("effective_permissions");
      if (error) {
        console.error("useEffectivePermissions error:", error);
        return { hasAll: false, byResource: {} };
      }
      return parsePermissions(data);
    },
    staleTime: 60 * 1000,
    retry: 1,
  });
};

// Helper: kiểm tra 1 quyền cụ thể. Trả về { allowed, loading } để caller
// có thể disable loading state nếu cần. Trong khi loading mặc định allowed=false
// để tránh nháy nội dung khi user thực sự không có quyền.
export const usePermission = (resource: string, action: string) => {
  const { data, isLoading } = useEffectivePermissions();
  if (isLoading || !data) return { allowed: false, loading: true };
  if (data.hasAll) return { allowed: true, loading: false };
  return {
    allowed: data.byResource[resource]?.has(action) ?? false,
    loading: false,
  };
};

// Hook đồng bộ (không loading state) cho các nơi đã chắc data sẵn sàng.
// Trả false nếu data chưa load — caller nên ưu tiên usePermission().
export const can = (
  perms: EffectivePermissions | undefined,
  resource: string,
  action: string,
): boolean => {
  if (!perms) return false;
  if (perms.hasAll) return true;
  return perms.byResource[resource]?.has(action) ?? false;
};
