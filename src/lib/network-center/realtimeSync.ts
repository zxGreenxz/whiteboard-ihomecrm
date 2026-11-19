import type { QueryClient } from "@tanstack/react-query";

import { networkCenterQueryKeys } from "@/lib/network-center/queryKeys";
import {
  NETWORK_CENTER_REALTIME_TABLES,
  resolveNetworkCenterRealtimeTarget,
} from "@/lib/network-center/runtime";
import { createBurstScheduler } from "@/lib/realtime/burstScheduler";
import { subscribeResilient } from "@/lib/realtime/subscribeResilient";

/**
 * Gom sự kiện realtime trước khi refetch. 150ms → 5000ms ngày 30/08/2026.
 *
 * Đo trên production: một vòng poll ghi ~40 dòng current-state rải ra hơn 150ms,
 * nên mỗi vòng sinh ~39 lần refetch thay vì 1 — 8.625 lượt gọi
 * `network_center_get_building_v1` trong 4 giờ, chiếm 28,8% CPU SQL của cả
 * database. Nhịp poll nay là 30 phút (xem migration 20260830165629) nên sự kiện
 * đến theo cụm; 5 giây gom trọn một cụm.
 *
 * Cái giá: bảng số trên màn hình cập nhật chậm thêm ~5 giây so với lúc dữ liệu
 * chạm database. Với dữ liệu 30 phút mới làm mới một lần thì không ai nhận ra —
 * và nút "Làm mới" ở header cho người dùng đường tắt khi cần ngay.
 *
 * 21/10/2026: thêm trần chờ 15 s (một vòng poll kéo dài vẫn nhả vài lần thay vì
 * im tới lúc xong) và hoãn khi tab ẩn — xem src/lib/realtime/burstScheduler.ts.
 */
export const NETWORK_CENTER_REALTIME_DEBOUNCE_MS = 5_000;
export const NETWORK_CENTER_REALTIME_MAX_WAIT_MS = NETWORK_CENTER_REALTIME_DEBOUNCE_MS * 3;

/** Thứ kênh cần đọc LÚC NHẢ — đổi theo màn mà không phải dựng lại kênh. */
export interface NetworkCenterRealtimeContext {
  /** Toà đang chọn, đã chuẩn hoá (rỗng = chưa chọn). */
  selectedBuildingId: string;
  fleetKey: readonly unknown[];
  organizationIdOf: (buildingId: string) => string;
}

export interface NetworkCenterRealtimeOptions {
  actorId: string;
  queryClient: QueryClient;
  getContext: () => NetworkCenterRealtimeContext;
}

/**
 * Kênh realtime của Network Center (21/10/2026, A7 — RT-OTHER-1/2/7).
 *
 * - Topic `network-center-<actorId>`, mở qua subscribeResilient (id
 *   'network-center'): rớt rồi nối lại / tab hiện lại sau ≥60 s ⇒ làm tươi mọi
 *   query NC đang hiện của actor (một lượt), bỏ việc chờ vì lượt đó đã phủ.
 * - Toà đang chọn, fleetKey, bản đồ toà → công ty đọc qua `getContext()` lúc nhả:
 *   bản cũ đưa chúng vào deps của effect nên MỖI LẦN ĐỔI TOÀ là leave/join kênh
 *   và vứt các invalidate đang chờ.
 * - Tab ẩn chỉ giữ cờ; dọn kênh thì nhả việc tồn thay vì làm rơi.
 */
export function subscribeNetworkCenterRealtime(options: NetworkCenterRealtimeOptions): () => void {
  const { actorId, queryClient, getContext } = options;
  let invalidateFleet = false;
  const pendingBuildingIds = new Set<string>();

  const flush = () => {
    const context = getContext();
    const promises: Array<Promise<unknown>> = [];
    if (invalidateFleet) {
      promises.push(queryClient.invalidateQueries({ queryKey: context.fleetKey, exact: true }));
    }
    for (const buildingId of pendingBuildingIds) {
      const organizationId = context.organizationIdOf(buildingId);
      promises.push(queryClient.invalidateQueries({
        queryKey: networkCenterQueryKeys.building(actorId, organizationId, buildingId),
        exact: true,
      }));
      promises.push(queryClient.invalidateQueries({
        queryKey: networkCenterQueryKeys.aruba(actorId, organizationId, buildingId),
        exact: true,
      }));
    }
    invalidateFleet = false;
    pendingBuildingIds.clear();
    void Promise.allSettled(promises);
  };

  const scheduler = createBurstScheduler({
    debounceMs: NETWORK_CENTER_REALTIME_DEBOUNCE_MS,
    maxWaitMs: NETWORK_CENTER_REALTIME_MAX_WAIT_MS,
    flush,
  });

  const stop = subscribeResilient({
    id: "network-center",
    topic: `network-center-${actorId}`,
    label: "network-center",
    bind: (channel) => {
      let ch = channel;
      for (const table of NETWORK_CENTER_REALTIME_TABLES) {
        ch = ch.on(
          "postgres_changes",
          { event: "*", schema: "public", table },
          (payload) => {
            const target = resolveNetworkCenterRealtimeTarget(
              table,
              payload,
              getContext().selectedBuildingId || undefined,
            );
            invalidateFleet ||= target.invalidateFleet;
            target.buildingIds.forEach((buildingId) => pendingBuildingIds.add(buildingId));
            scheduler.poke();
          },
        );
      }
      return ch;
    },
    onResync: () => {
      // Lượt này phủ mọi thứ việc chờ định làm — bỏ việc chờ để khỏi refetch đôi.
      scheduler.cancel();
      invalidateFleet = false;
      pendingBuildingIds.clear();
      void Promise.resolve(queryClient.invalidateQueries({
        queryKey: networkCenterQueryKeys.user(actorId),
        refetchType: "active",
      })).catch(() => { /* lỗi refetch nằm ở state từng query (throwOnError mặc định false), không có gì để xử lý thêm ở đây */ });
    },
  });

  return () => {
    scheduler.dispose({ flush: true });
    stop();
  };
}
