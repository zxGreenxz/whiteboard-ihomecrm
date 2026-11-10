// Dữ liệu điểm danh GPS tự động. Máy chủ tự kiểm quyền từng hàm.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  gpsMyStatusSchema, gpsSettingsDocSchema, pairStartSchema, type GpsSettingsForm,
} from "@/lib/gpsCheckin";

// Viết thẳng `db.rpc("tên", …)` tại từng nơi gọi để gate bề mặt RPC đọc được tên hàm.
type KetQuaRpc = Promise<{ data: unknown; error: unknown }>;
const db = supabase as unknown as { rpc(fn: string, args?: Record<string, unknown>): KetQuaRpc };

async function unwrap(call: KetQuaRpc): Promise<unknown> {
  const { data, error } = await call;
  if (error) throw error;
  return data;
}

export function useGpsSettings() {
  return useQuery({
    queryKey: ["gps-checkin", "settings"],
    queryFn: async () => gpsSettingsDocSchema.parse(await unwrap(db.rpc("gps_checkin_settings_get_v1"))),
    staleTime: 30_000,
  });
}

/** `live`: màn điểm danh tự làm mới; ô lối vào ở /my-day chỉ đọc một lần và không báo lỗi lên màn. */
export function useGpsMyStatus(live = true) {
  return useQuery({
    queryKey: ["gps-checkin", "me"],
    queryFn: async () => gpsMyStatusSchema.parse(await unwrap(db.rpc("gps_checkin_my_status_v1"))),
    staleTime: live ? 20_000 : 5 * 60_000,
    refetchInterval: live ? 30_000 : false,
    meta: live ? undefined : { silent: true },
  });
}

function useInvalidateGps() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: ["gps-checkin"] });
    void client.invalidateQueries({ queryKey: ["staff-day"] });
  };
}

export function useSaveGpsSettings() {
  const invalidate = useInvalidateGps();
  return useMutation({
    meta: { handlesFeedback: true },
    mutationFn: (form: GpsSettingsForm) => unwrap(db.rpc("gps_checkin_settings_set_v1", { p_patch: form })),
    onSuccess: invalidate,
  });
}

export function useSetGpsMember() {
  const invalidate = useInvalidateGps();
  return useMutation({
    meta: { handlesFeedback: true },
    mutationFn: ({ userId, applies }: { userId: string; applies: boolean }) =>
      unwrap(db.rpc("gps_checkin_member_set_v1", { p_user: userId, p_applies: applies })),
    onSuccess: invalidate,
  });
}

export function useStartGpsPair() {
  return useMutation({
    meta: { handlesFeedback: true },
    mutationFn: async () => pairStartSchema.parse(await unwrap(db.rpc("gps_checkin_pair_start_v1"))),
  });
}

export function useRevokeGpsDevice() {
  const invalidate = useInvalidateGps();
  return useMutation({
    meta: { handlesFeedback: true },
    mutationFn: (deviceId: string) => unwrap(db.rpc("gps_checkin_device_revoke_v1", { p_device: deviceId })),
    onSuccess: invalidate,
  });
}
