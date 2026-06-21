/**
 * React binding cho bộ đo đếm /r/:token.
 * - <TrackingProvider tracker>: bọc subtree để con gọi useTrack() không cần prop-drill.
 * - useTracking(token, isStaff): tạo tracker + vòng đời (start mount / stop unmount).
 * - useRoomImpression(room): IntersectionObserver → 'impression' khi phòng hiện ≥50%.
 * Mọi listener/timer mount/unmount theo trang → zero impact phần còn lại của app.
 */
import React, { createContext, useContext, useEffect, useRef } from "react";
import { createTracker, NOOP_TRACKER, type Tracker } from "./tracking";

const TrackingContext = createContext<Tracker>(NOOP_TRACKER);

export const TrackingProvider = ({
  tracker,
  children,
}: {
  tracker: Tracker;
  children: React.ReactNode;
}) => <TrackingContext.Provider value={tracker}>{children}</TrackingContext.Provider>;

/** Lấy tracker hiện hành (NOOP nếu ngoài provider / không có token). */
export const useTrack = (): Tracker => useContext(TrackingContext);

/** Tạo tracker 1 lần/mount + quản vòng đời. token đổi → tracker mới. */
export function useTracking(token: string | undefined, isStaff: boolean): Tracker {
  const ref = useRef<{ token?: string; tracker: Tracker }>();
  if (!ref.current || ref.current.token !== token) {
    ref.current = { token, tracker: createTracker(token, { isStaff }) };
  }
  const tracker = ref.current.tracker;

  useEffect(() => {
    tracker.start();
    return () => tracker.stop();
  }, [tracker]);

  useEffect(() => {
    tracker.setStaff(isStaff);
  }, [tracker, isStaff]);

  return tracker;
}

type ImpressionRoom = {
  id: string;
  code?: string;
  no?: number | string;
  buildingId?: string;
  buildingName?: string;
};

/**
 * Ref gắn vào card/hàng phòng → ghi 'impression' lần đầu phòng hiển thị ≥50%.
 * Dedupe (1/phòng/session) do tracker tự lo.
 */
export function useRoomImpression<T extends HTMLElement = HTMLDivElement>(
  room: ImpressionRoom,
) {
  const track = useTrack();
  const ref = useRef<T | null>(null);
  const roomId = room.id;
  useEffect(() => {
    const el = ref.current;
    if (!el || !track.enabled || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && e.intersectionRatio >= 0.5) {
            track.track("impression", {
              room_id: room.id,
              room_code: room.code,
              room_name: room.no != null ? String(room.no) : undefined,
              building_id: room.buildingId,
              building_name: room.buildingName,
            });
            io.disconnect();
            break;
          }
        }
      },
      { threshold: [0, 0.5, 1] },
    );
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, track]);
  return ref;
}
