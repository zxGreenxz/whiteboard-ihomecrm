// =============================================================================
// useAcceptanceGeofence — đọc cấu hình geo-fence nghiệm thu (bật/tắt + bán kính)
// qua RPC get_acceptance_geofence_config() (SECURITY DEFINER, đọc settings của
// owner để staff dùng chung). Mặc định an toàn: enabled=true, radiusM=70.
// =============================================================================

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { jsonProp } from '@/lib/jsonValue';

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
      // RPC này CÓ trong types.ts (Args: never, Returns: Json) nên gọi typed
      // được; đọc field qua jsonProp() vì Json không có index signature.
      const { data, error } = await supabase.rpc(
        'get_acceptance_geofence_config',
      );
      if (error || !data) return DEFAULT_GEOFENCE_CONFIG;
      const row = Array.isArray(data) ? data[0] : data;
      const enabled = jsonProp(row, 'enabled');
      const radiusM = jsonProp(row, 'radius_m');
      return {
        enabled: typeof enabled === 'boolean' ? enabled : true,
        radiusM: Number.isFinite(radiusM) ? Number(radiusM) : 70,
      };
    },
    staleTime: 5 * 60 * 1000,
  });
}
