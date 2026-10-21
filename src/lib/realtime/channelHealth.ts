// =============================================================
// Sức khoẻ kênh realtime — MỘT store cho mọi kênh (hub nghiệp vụ, chuông thông
// báo, Zalo, Network Center). (21/10/2026, plan realtime + thông báo, mục A1.)
//
// Các kênh đi chung một WebSocket nên thường rớt cùng lúc. Người dùng cần MỘT
// tín hiệu "đang mất cập nhật tự động", không phải bốn dòng console. Store này
// gom trạng thái từng kênh về một giá trị tổng hợp cho dải cảnh báo ở layout,
// và giữ một cửa "bắt kịp ngay" để nút "Tải lại dữ liệu" đánh thức mọi kênh.
//
// Store thuần module (không React context): kênh được mở từ các hook mount ở
// nhiều tầng khác nhau, còn dải cảnh báo nằm ở layout — không có cây chung nào
// đủ gần để truyền props.
// =============================================================

import { useSyncExternalStore } from "react";

export type RealtimeLinkState = "connecting" | "connected" | "interrupted";

export interface RealtimeHealthSnapshot {
  /** Trạng thái tổng hợp: có một kênh rớt là cả cụm coi như rớt. */
  state: RealtimeLinkState;
  /** Mốc (ms) kênh rớt SỚM NHẤT trong số kênh đang rớt; null khi không kênh nào rớt. */
  interruptedSince: number | null;
  channels: Readonly<Record<string, RealtimeLinkState>>;
}

const CONNECTED: RealtimeHealthSnapshot = Object.freeze({
  state: "connected",
  interruptedSince: null,
  channels: Object.freeze({}),
});

const channelStates = new Map<string, { state: RealtimeLinkState; since: number }>();
const listeners = new Set<() => void>();
const resyncListeners = new Set<() => void>();
let snapshot: RealtimeHealthSnapshot = CONNECTED;

function recompute() {
  if (channelStates.size === 0) {
    snapshot = CONNECTED;
  } else {
    const channels: Record<string, RealtimeLinkState> = {};
    let interruptedSince: number | null = null;
    let connecting = false;
    for (const [id, entry] of channelStates) {
      channels[id] = entry.state;
      if (entry.state === "interrupted") {
        interruptedSince = interruptedSince === null ? entry.since : Math.min(interruptedSince, entry.since);
      } else if (entry.state === "connecting") {
        connecting = true;
      }
    }
    snapshot = {
      state: interruptedSince !== null ? "interrupted" : connecting ? "connecting" : "connected",
      interruptedSince,
      channels,
    };
  }
  listeners.forEach((listener) => listener());
}

/** Kênh báo trạng thái mới. Báo lặp cùng trạng thái giữ nguyên mốc `since`. */
export function reportChannelState(id: string, state: RealtimeLinkState, now: number = Date.now()): void {
  const prev = channelStates.get(id);
  if (prev?.state === state) return;
  channelStates.set(id, { state, since: now });
  recompute();
}

/** Kênh đã được dọn chủ động — không còn tính vào trạng thái tổng hợp. */
export function forgetChannel(id: string): void {
  if (!channelStates.delete(id)) return;
  recompute();
}

export function getRealtimeHealth(): RealtimeHealthSnapshot {
  return snapshot;
}

export function subscribeRealtimeHealth(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useRealtimeHealth(): RealtimeHealthSnapshot {
  return useSyncExternalStore(subscribeRealtimeHealth, getRealtimeHealth, () => CONNECTED);
}

/** Đăng ký nhận yêu cầu "bắt kịp ngay" (nút Tải lại dữ liệu). Trả hàm huỷ. */
export function onResyncAll(listener: () => void): () => void {
  resyncListeners.add(listener);
  return () => {
    resyncListeners.delete(listener);
  };
}

/** Mọi kênh đang sống làm tươi dữ liệu của mình ngay, bỏ qua giãn cách chống dồn. */
export function requestResyncAll(): void {
  resyncListeners.forEach((listener) => listener());
}

export function __resetChannelHealthForTest(): void {
  channelStates.clear();
  listeners.clear();
  resyncListeners.clear();
  snapshot = CONNECTED;
}
