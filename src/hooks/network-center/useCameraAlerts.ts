import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CameraAlertDeliveryStatus, CameraAlertRepository, CameraAlertSettingsPatch, CameraAlertSettingsView,
  CameraChannelMuteInput,
} from "@/lib/network-center/cameraContracts";
import { createDemoCameraAlertRepository } from "@/lib/network-center/cameraDemo";
import { supabaseCameraAlertRepository } from "@/lib/network-center/cameraRepository";
import { shouldRetryNetworkCenterQuery } from "@/lib/network-center/retryPolicy";
import type { NetworkCenterMode } from "@/lib/network-center/runtime";

// Cảnh báo camera v2 — dữ liệu của màn cài đặt (cấp công ty) và thao tác trên tab
// Camera. Component không gọi RPC: mọi đường đi qua CameraAlertRepository.

let demoAlertRepository: CameraAlertRepository | null = null;
/** DEMO chỉ khi đang ở chế độ demo; không bao giờ là đường lui khi truy vấn thật lỗi. */
export function cameraAlertRepositoryFor(mode: NetworkCenterMode): CameraAlertRepository {
  if (mode !== "demo") return supabaseCameraAlertRepository;
  demoAlertRepository ??= createDemoCameraAlertRepository();
  return demoAlertRepository;
}

const normalize = (value: string) => value.trim().toLowerCase();

export interface CameraAlertScope {
  actorId: string;
  organizationId: string;
  mode: NetworkCenterMode;
  canView: boolean;
}

export const cameraAlertQueryKey = (scope: Pick<CameraAlertScope, "actorId" | "organizationId" | "mode">) => [
  "network-center", normalize(scope.actorId), normalize(scope.organizationId), "camera-alerts", scope.mode,
] as const;

const DELIVERY_PAGE_SIZE = 50;

export function useCameraAlertSettings(scope: CameraAlertScope, repository?: CameraAlertRepository) {
  const queryClient = useQueryClient();
  const service = repository ?? cameraAlertRepositoryFor(scope.mode);
  const enabled = scope.canView && Boolean(scope.actorId && scope.organizationId) && scope.mode !== "off";
  const key = cameraAlertQueryKey(scope);

  const settingsQuery = useQuery({
    queryKey: [...key, "settings"],
    queryFn: () => service.getSettings(scope.organizationId),
    enabled,
    retry: shouldRetryNetworkCenterQuery,
    // Đang sửa form thì không để lần nạp nền đổi dữ liệu dưới tay; CAS bắt lệch lúc lưu.
    refetchOnWindowFocus: false,
  });

  const saveMutation = useMutation({
    mutationFn: ({ expectedVersion, patch }: { expectedVersion: number; patch: CameraAlertSettingsPatch }) =>
      service.saveSettings(scope.organizationId, expectedVersion, patch),
    onSuccess: async (view) => {
      // Lần nạp settings đang bay (vd. sau tin thử) về muộn sẽ đè bản vừa lưu bằng bản cũ ⇒ huỷ trước.
      await queryClient.cancelQueries({ queryKey: [...key, "settings"] });
      queryClient.setQueryData<CameraAlertSettingsView>([...key, "settings"], view);
      void queryClient.invalidateQueries({ queryKey: [...key, "deliveries"] });
    },
  });

  const testMutation = useMutation({
    mutationFn: () => service.sendTest(scope.organizationId),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: [...key, "settings"] });
      void queryClient.invalidateQueries({ queryKey: [...key, "deliveries"] });
    },
  });

  return { enabled, key, settingsQuery, saveMutation, testMutation };
}

export function useCameraAlertDeliveries(scope: CameraAlertScope, status: CameraAlertDeliveryStatus | null, repository?: CameraAlertRepository) {
  const service = repository ?? cameraAlertRepositoryFor(scope.mode);
  const enabled = scope.canView && Boolean(scope.actorId && scope.organizationId) && scope.mode !== "off";
  return useInfiniteQuery({
    queryKey: [...cameraAlertQueryKey(scope), "deliveries", status ?? "ALL"],
    initialPageParam: undefined as { createdAt: string; id: string } | undefined,
    queryFn: ({ pageParam }) => service.listDeliveries(scope.organizationId, {
      status: status ?? undefined, limit: DELIVERY_PAGE_SIZE, before: pageParam,
    }),
    getNextPageParam: (lastPage) => {
      const last = lastPage.items[lastPage.items.length - 1];
      return lastPage.hasMore && last ? { createdAt: last.createdAt, id: last.id } : undefined;
    },
    enabled,
    retry: shouldRetryNetworkCenterQuery,
    refetchOnWindowFocus: false,
  });
}

/** Danh sách nhóm Zalo chỉ dành cho người sửa được (máy chủ trả 42501 với người chỉ xem). */
export function useCameraAlertZaloGroups(scope: CameraAlertScope, search: string, open: boolean, repository?: CameraAlertRepository) {
  const service = repository ?? cameraAlertRepositoryFor(scope.mode);
  const term = search.trim();
  return useQuery({
    queryKey: [...cameraAlertQueryKey(scope), "zalo-groups", term],
    queryFn: () => service.listZaloGroups(scope.organizationId, term || undefined, 200),
    enabled: open && scope.canView && Boolean(scope.actorId && scope.organizationId) && scope.mode !== "off",
    retry: shouldRetryNetworkCenterQuery,
    staleTime: 30_000,
  });
}

/** Tắt báo kênh và "Đã biết" trên tab Camera; xong thì nạp lại trạng thái tắt và sự cố của toà. */
export function useCameraChannelAlertActions(
  mode: NetworkCenterMode,
  invalidateKey: readonly unknown[],
  repository?: CameraAlertRepository,
) {
  const queryClient = useQueryClient();
  const service = repository ?? cameraAlertRepositoryFor(mode);
  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: [...invalidateKey, "mutes"] }),
    queryClient.invalidateQueries({ queryKey: [...invalidateKey, "incidents"] }),
  ]);
  const setMute = useMutation({
    mutationFn: (input: CameraChannelMuteInput) => service.setChannelMute(input),
    onSuccess: refresh,
  });
  const clearMute = useMutation({
    mutationFn: ({ recorderId, channel }: { recorderId: string; channel: number }) => service.clearChannelMute(recorderId, channel),
    onSuccess: refresh,
  });
  const acknowledge = useMutation({
    mutationFn: (incidentId: string) => service.acknowledgeIncident(incidentId),
    onSettled: refresh,
  });
  return { setMute, clearMute, acknowledge };
}
