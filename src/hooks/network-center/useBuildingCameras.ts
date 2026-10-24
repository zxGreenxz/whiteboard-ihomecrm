import { useInfiniteQuery, useQuery, useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { CameraEventCursor, CameraRepository, CameraScope } from "@/lib/network-center/cameraContracts";
import { demoCameraRepository } from "@/lib/network-center/cameraDemo";
import { supabaseCameraRepository } from "@/lib/network-center/cameraRepository";
import { shouldRetryNetworkCenterQuery } from "@/lib/network-center/retryPolicy";
import type { NetworkCenterMode } from "@/lib/network-center/runtime";
import { NetworkCenterRepositoryError } from "@/lib/network-center/supabaseRepository";

const temporaryCameraErrors = new Set(["PGRST000", "PGRST001", "PGRST002", "PGRST003", "57014"]);
const cameraAccessErrors = new Set(["42501", "PGRST301", "PGRST302", "PGRST303", "28000", "28P01", "CAMERA_SCOPE_MISMATCH"]);
export function isTemporaryCameraError(error: unknown) {
  if (error instanceof NetworkCenterRepositoryError) return !error.code || temporaryCameraErrors.has(error.code);
  return error instanceof Error && ["TypeError", "AbortError", "TimeoutError"].includes(error.name);
}
// Query identity includes actor/org/building/mode. Keep a denial through retries
// and remounts until a current request validates the same scope successfully.
const blockedCameraQueries = new WeakMap<object, Error>();
function cameraQueryBlock(client: QueryClient, key: QueryKey) {
  const query = client.getQueryCache().find({ queryKey: key, exact: true });
  return query && blockedCameraQueries.get(query);
}
async function readCameraQuery<T>(client: QueryClient, key: QueryKey, signal: AbortSignal, read: () => Promise<T>, blocks: (error: unknown) => boolean): Promise<T> {
  const query = client.getQueryCache().find({ queryKey: key, exact: true });
  if (!query) throw new NetworkCenterRepositoryError("Chưa xác định được phạm vi camera.", { code: "CAMERA_SCOPE_MISMATCH" });
  try {
    const result = await read();
    if (!signal.aborted) blockedCameraQueries.delete(query);
    return result;
  } catch (error) {
    if (signal.aborted) throw error;
    if (blocks(error) && !blockedCameraQueries.has(query)) blockedCameraQueries.set(query, error instanceof Error ? error : new Error("Không thể xác minh dữ liệu camera."));
    throw blockedCameraQueries.get(query) ?? error;
  }
}

export interface BuildingCameraScope extends CameraScope {
  actorId: string;
  canView: boolean;
  mode: NetworkCenterMode;
}

export const cameraQueryKey = (scope: BuildingCameraScope) => [
  "network-center", scope.actorId, scope.organizationId, "building", scope.buildingId, "camera", scope.mode,
] as const;

export function useBuildingCameras(scope: BuildingCameraScope, repository?: CameraRepository) {
  const queryClient = useQueryClient();
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
    queryFn: ({ queryKey, signal }) => readCameraQuery(queryClient, queryKey, signal, () => service.getBuilding(scope), (error) => !isTemporaryCameraError(error)),
    enabled, refetchInterval: 30_000, retry: shouldRetryNetworkCenterQuery, retryOnMount: false,
    notifyOnChangeProps: "all",
  });
  const eventsQuery = useInfiniteQuery({
    queryKey: [...key, "events"],
    initialPageParam: undefined as CameraEventCursor | undefined,
    queryFn: ({ pageParam, queryKey, signal }) => readCameraQuery(queryClient, queryKey, signal, () => service.listEvents(scope, pageParam), (error) => error instanceof NetworkCenterRepositoryError && cameraAccessErrors.has(error.code ?? "")),
    getNextPageParam: (lastPage) => {
      const last = lastPage.items[lastPage.items.length - 1];
      return lastPage.hasMore && last ? { observedAt: last.observed_at, id: last.id } : undefined;
    },
    enabled: enabled && snapshotQuery.isSuccess,
    refetchInterval: 30_000, retry: shouldRetryNetworkCenterQuery, retryOnMount: false,
    // The permission barrier also changes when a successful response is equal
    // to cached data; status changes must still update a currently locked view.
    notifyOnChangeProps: "all",
  });
  return {
    now, enabled, snapshotQuery, eventsQuery,
    blockingError: cameraQueryBlock(queryClient, [...key, "snapshot"]) ?? cameraQueryBlock(queryClient, [...key, "events"]),
    recorders: snapshotQuery.data?.recorders ?? [],
    events: [...new Map(eventsQuery.data?.pages.flatMap((page) => page.items).map((event) => [event.id, event])).values()],
  };
}
