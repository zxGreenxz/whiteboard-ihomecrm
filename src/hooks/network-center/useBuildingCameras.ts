import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { CameraEventCursor, CameraRepository, CameraScope } from "@/lib/network-center/cameraContracts";
import { demoCameraRepository } from "@/lib/network-center/cameraDemo";
import { supabaseCameraRepository } from "@/lib/network-center/cameraRepository";
import { shouldRetryNetworkCenterQuery } from "@/lib/network-center/retryPolicy";
import type { NetworkCenterMode } from "@/lib/network-center/runtime";

export interface BuildingCameraScope extends CameraScope {
  actorId: string;
  canView: boolean;
  mode: NetworkCenterMode;
}

export const cameraQueryKey = (scope: BuildingCameraScope) => [
  "network-center", scope.actorId, scope.organizationId, "building", scope.buildingId, "camera", scope.mode,
] as const;

export function useBuildingCameras(scope: BuildingCameraScope, repository?: CameraRepository) {
  const service = repository ?? (scope.mode === "demo" ? demoCameraRepository : supabaseCameraRepository);
  const enabled = scope.canView && Boolean(scope.actorId && scope.organizationId && scope.buildingId) && scope.mode !== "off";
  const key = cameraQueryKey(scope);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [enabled]);
  const snapshotQuery = useQuery({
    queryKey: [...key, "snapshot"],
    queryFn: () => service.getBuilding(scope),
    enabled, refetchInterval: 30_000, retry: shouldRetryNetworkCenterQuery, retryOnMount: false,
  });
  const eventsQuery = useInfiniteQuery({
    queryKey: [...key, "events"],
    initialPageParam: undefined as CameraEventCursor | undefined,
    queryFn: ({ pageParam }) => service.listEvents(scope, pageParam),
    getNextPageParam: (lastPage) => {
      const last = lastPage.items[lastPage.items.length - 1];
      return lastPage.hasMore && last ? { observedAt: last.observed_at, id: last.id } : undefined;
    },
    enabled: enabled && snapshotQuery.isSuccess,
    refetchInterval: 30_000, retry: shouldRetryNetworkCenterQuery, retryOnMount: false,
  });
  return {
    now, enabled, snapshotQuery, eventsQuery,
    recorders: snapshotQuery.data?.recorders ?? [],
    events: [...new Map(eventsQuery.data?.pages.flatMap((page) => page.items).map((event) => [event.id, event])).values()],
  };
}
