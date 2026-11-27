import { useEffect, useState, type MouseEvent } from "react";

import { useHoldToOpen, type UseHoldToOpen } from "@/hooks/door-access/useHoldToOpen";
import { useRemoteUnlock, useRemoteUnlockPending } from "@/hooks/door-access/useDoorAccessMutations";
import type { DoorDevice } from "@/lib/door-access/dto";
import type { DoorAccessCaller } from "@/lib/door-access/edge";
import { isDoorAccessError } from "@/lib/door-access/errors";
import { dialView, holdBlock, unlockErrorOutcome, unlockSuccessOutcome, type DialView, type HoldBlock } from "@/lib/door-access/holdToOpen";
import { doorLabel, formatClock } from "@/lib/door-access/mobile";

function usePrefersReducedMotion(): boolean {
  const query = "(prefers-reduced-motion: reduce)";
  const read = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  const [reduced, setReduced] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    const onChange = () => setReduced(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

export type DialHandlers = UseHoldToOpen["handlers"] & { onClick: (event: MouseEvent<HTMLElement>) => void };

export interface DoorDialState {
  view: DialView;
  badge: HoldBlock | "rate_limited" | null;
  label: string;
  handlers: DialHandlers;
  block: HoldBlock | null;
  /** Đang gửi lệnh hoặc chưa rõ kết quả: không cho đổi cửa (kết quả phải về đúng cửa đã gửi). */
  locksDevice: boolean;
  ack: () => void;
  /** Đường cho trình đọc màn hình: click không đi kèm con trỏ ⇒ hỏi xác nhận như màn máy tính. */
  confirmOpen: boolean;
  setConfirmOpen: (open: boolean) => void;
  confirm: () => void;
}

/**
 * Trạng thái vòng vân tay + lệnh mở cửa. Gọi ở VỎ TRANG (không ở mục Cửa) để đổi mục giữa lúc đang gửi
 * không làm mất kết quả: callback của mutation chỉ chạy khi component gọi nó còn trên màn, và mất kết quả
 * nghĩa là vòng về "sẵn sàng" trong khi lệnh cũ có thể đã mở cửa.
 */
export function useDoorDial({
  caller,
  device,
  writable,
  online,
}: {
  caller: DoorAccessCaller;
  device: DoorDevice | null;
  writable: boolean;
  online: boolean | null;
}): DoorDialState {
  const unlock = useRemoteUnlock(caller);
  // Lệnh cùng máy do một màn khác gửi (vd trước khi xoay máy qua mốc 768px) còn chạy: khoá, không gửi chồng.
  const pendingElsewhere = useRemoteUnlockPending(caller, device?.id ?? null) && !unlock.isPending;
  const block = device ? holdBlock({ canRemoteUnlock: device.can.remote_unlock, writable, online }) : "no_permission";
  const reducedMotion = usePrefersReducedMotion();
  const [openedAt, setOpenedAt] = useState<number | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const hold = useHoldToOpen({
    blocked: block !== null || pendingElsewhere,
    onFire: (report) => {
      if (!device) return;
      unlock.mutate(device.id, {
        onSuccess: (data) => {
          setOpenedAt(Date.now());
          report(unlockSuccessOutcome(data));
        },
        onError: (error) => report(unlockErrorOutcome(isDoorAccessError(error) ? error : null, "Chưa mở được cửa. Thử lại sau.")),
      });
    },
  });
  const { reset } = hold;
  const deviceId = device?.id ?? null;
  // Đổi cửa (chỉ được khi không gửi/không chờ "Đã hiểu"): vòng của cửa mới bắt đầu từ sẵn sàng.
  useEffect(() => {
    reset();
    setOpenedAt(null);
    setConfirmOpen(false);
  }, [deviceId, reset]);

  const label = device ? `Giữ để mở ${device.display_name}${device.building_name ? `, toà ${device.building_name}` : ""}` : "Giữ để mở cửa";
  const baseView = dialView(
    hold.state,
    block,
    { doorLabel: device ? doorLabel(device) : "", openedAtText: openedAt === null ? null : formatClock(openedAt) },
    reducedMotion,
  );
  const view: DialView =
    pendingElsewhere && hold.state.phase !== "sending"
      ? { ...baseView, tone: "sending", title: "Đang chờ kết quả lệnh trước…", sub: "Một lệnh mở cửa này vừa gửi còn đang chạy.", interactive: false, needsAck: false, ring: 0 }
      : baseView;
  const phase = hold.state.phase;
  return {
    view,
    badge: phase === "rate_limited" ? "rate_limited" : block,
    label,
    handlers: {
      ...hold.handlers,
      onClick: (event) => {
        // Chạm/nhấn chuột (detail ≥ 1) đã đi đường giữ; click "ảo" của trình đọc màn hình có detail 0.
        // Bàn phím không sinh click (keydown/keyup Space/Enter đã preventDefault).
        if (event.detail === 0 && view.interactive) setConfirmOpen(true);
      },
    },
    block,
    locksDevice: phase === "sending" || phase === "unknown" || pendingElsewhere,
    ack: reset,
    confirmOpen,
    setConfirmOpen,
    confirm: () => {
      setConfirmOpen(false);
      hold.trigger();
    },
  };
}
