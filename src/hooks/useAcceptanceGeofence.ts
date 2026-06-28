// =============================================================================
// useAcceptanceGeofence — đọc cấu hình geo-fence nghiệm thu (bật/tắt + bán kính)
// qua RPC get_acceptance_geofence_config() (SECURITY DEFINER, đọc settings của
// owner để staff dùng chung). Mặc định an toàn: enabled=true, radiusM=70.
// =============================================================================

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface AcceptanceGeofenceConfig {
  enabled: boolean;
  radiusM: number;
}

export const DEFAULT_GEOFENCE_CONFIG: AcceptanceGeofenceConfig = {
  enabled: true,
  radiusM: 70,
};

/** Key dùng cho bảng settings (per-owner). */
export const ACCEPTANCE_GEOFENCE_SETTING_KEY = 'acceptance_geofence';

export function useAcceptanceGeofenceConfig() {
  return useQuery({
    queryKey: ['acceptance-geofence-config'],
    queryFn: async (): Promise<AcceptanceGeofenceConfig> => {
      // RPC chưa có trong types sinh tự động → cast any (giống useMyContext).
      const { data, error } = await (supabase.rpc as any)(
        'get_acceptance_geofence_config',
      );
      if (error || !data) return DEFAULT_GEOFENCE_CONFIG;
      const row = Array.isArray(data) ? data[0] : data;
      return {
        enabled: typeof row?.enabled === 'boolean' ? row.enabled : true,
        radiusM: Number.isFinite(row?.radius_m) ? Number(row.radius_m) : 70,
      };
    },
    staleTime: 5 * 60 * 1000,
  });
}
