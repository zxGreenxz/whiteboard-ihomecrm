// =============================================================
// subscribeResilient — vòng đời kênh realtime DÙNG CHUNG: theo dõi trạng thái,
// bắt kịp sau gián đoạn, dựng lại kênh bị server đóng. (21/10/2026, mục A1.)
//
// VẤN ĐỀ ĐO ĐƯỢC (kiểm 21/10)
//   postgres_changes KHÔNG phát lại event đã lỡ. realtime-js tự nối lại socket
//   và join lại kênh sau CHANNEL_ERROR/TIMED_OUT (callback nhận SUBSCRIBED lần
//   nữa), nhưng mọi thay đổi xảy ra trong lúc rớt — máy ngủ, PWA vào nền, Wi-Fi
//   chập chờn, Realtime khởi động lại — thì mất hẳn. Bốn họ kênh của app đều bỏ
//   qua SUBSCRIBED lần hai, còn refetchOnWindowFocus tắt toàn cục, nên màn hình
//   giữ số cũ mà không ai biết. Khi server gửi phx_close (CLOSED) thì kênh bị gỡ
//   khỏi socket và KHÔNG BAO GIỜ join lại — đồng bộ tắt tới lúc F5.
//
// HỢP ĐỒNG
//   - SUBSCRIBED lần đầu: không làm gì thêm (dữ liệu vừa tải là mới).
//   - SUBSCRIBED sau CHANNEL_ERROR/TIMED_OUT/CLOSED: gọi onResync() một lần.
//   - Tab ẩn ≥ hiddenThresholdMs rồi hiện lại, hoặc window 'online': onResync().
//     (Trình duyệt hãm timer heartbeat ở tab nền; iOS treo hẳn JS.)
//   - Các nguồn trên hay bắn cùng lúc ⇒ giãn cách GIAN_CACH_BAT_KIP_MS chống dồn.
//   - CLOSED ngoài ý muốn: dựng lại kênh với backoff, topic thêm hậu tố ':r<n>'.
//     Hậu tố là BẮT BUỘC: RealtimeClient.channel() trả lại kênh cũ nếu trùng
//     topic, mà trong lúc leave kênh cũ vẫn còn trong danh sách ⇒ subscribe() lên
//     kênh đó là no-op và kênh chết im lặng.
//   - Nút "Tải lại dữ liệu" (requestResyncAll) gọi onResync() ngay, không giãn.
//   - Teardown chủ động: không cảnh báo, không dựng lại, rời store sức khoẻ.
//
// Callback của kênh CŨ (đã bị thay khi dựng lại) bị bỏ qua: CLOSED do chính ta
// removeChannel không được kích hoạt thêm một vòng dựng lại nữa.
// =============================================================

import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { forgetChannel, onResyncAll, reportChannelState } from "@/lib/realtime/channelHealth";

/** Tab ẩn lâu hơn ngưỡng này thì coi như có thể đã lỡ event. */
export const AN_TAB_TOI_THIEU_MS = 60_000;
/** Khoảng tối thiểu giữa hai lượt bắt kịp tự động của CÙNG một kênh. */
export const GIAN_CACH_BAT_KIP_MS = 10_000;
/** Lịch chờ trước mỗi lần dựng lại kênh bị server đóng. */
export const BACKOFF_DUNG_LAI_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

export interface ResilientChannelOptions {
  /** Khoá trong store sức khoẻ; duy nhất theo kênh (vd 'hub', 'notif'). */
  id: string;
  /** Topic gốc. Lần dựng lại thứ n dùng `${topic}:r${n}`. */
  topic: string;
  /** Gắn các binding .on(...) lên kênh vừa tạo rồi trả lại chính kênh đó. */
  bind: (channel: RealtimeChannel) => RealtimeChannel;
  /** Làm tươi dữ liệu sau một khoảng có thể đã lỡ event. Không được ném. */
  onResync: () => void;
  /** Nhãn cho console.warn; mặc định là id. */
  label?: string;
  hiddenThresholdMs?: number;
}

type ChannelStatus = "SUBSCRIBED" | "TIMED_OUT" | "CLOSED" | "CHANNEL_ERROR";

/** Mở kênh theo hợp đồng ở đầu file. Trả về hàm dọn (idempotent). */
export function subscribeResilient(options: ResilientChannelOptions): () => void {
  const label = options.label ?? options.id;
  const hiddenThresholdMs = options.hiddenThresholdMs ?? AN_TAB_TOI_THIEU_MS;

  let disposed = false;
  let generation = 0;
  let current: RealtimeChannel | null = null;
  let everSubscribed = false;
  let needResync = false;
  let lastResyncAt = Number.NEGATIVE_INFINITY;
  let hiddenAt: number | null = null;
  let rebuildAttempt = 0;
  let rebuildTimer: ReturnType<typeof setTimeout> | null = null;

  const resync = (force: boolean) => {
    const now = Date.now();
    if (!force && now - lastResyncAt < GIAN_CACH_BAT_KIP_MS) return;
    lastResyncAt = now;
    try {
      options.onResync();
    } catch (error) {
      console.warn(`[realtime] ${label} bắt kịp lỗi`, error);
    }
  };

  const scheduleRebuild = () => {
    if (rebuildTimer !== null || disposed) return;
    const delay = BACKOFF_DUNG_LAI_MS[Math.min(rebuildAttempt, BACKOFF_DUNG_LAI_MS.length - 1)];
    rebuildAttempt += 1;
    rebuildTimer = setTimeout(async () => {
      rebuildTimer = null;
      if (disposed) return;
      const old = current;
      current = null;
      if (old) await Promise.resolve(supabase.removeChannel(old)).catch(() => undefined);
      if (disposed) return;
      generation += 1;
      open();
    }, delay);
  };

  const handleStatus = (channel: RealtimeChannel, status: ChannelStatus, err?: Error) => {
    if (disposed || channel !== current) return;
    if (status === "SUBSCRIBED") {
      rebuildAttempt = 0;
      reportChannelState(options.id, "connected");
      if (everSubscribed && needResync) resync(false);
      everSubscribed = true;
      needResync = false;
      return;
    }
    reportChannelState(options.id, "interrupted");
    needResync = true;
    if (status === "CLOSED") {
      console.warn(`[realtime] ${label} CLOSED ngoài ý muốn — dựng lại kênh`);
      scheduleRebuild();
      return;
    }
    console.warn(`[realtime] ${label} ${status}`, err?.message ?? "");
  };

  function open() {
    const topic = generation === 0 ? options.topic : `${options.topic}:r${generation}`;
    const channel = options.bind(supabase.channel(topic));
    current = channel;
    reportChannelState(options.id, "connecting");
    channel.subscribe((status, err) => handleStatus(channel, status as ChannelStatus, err));
  }

  const onVisibility = () => {
    if (document.visibilityState === "hidden") {
      hiddenAt = Date.now();
      return;
    }
    if (hiddenAt === null) return;
    const hiddenFor = Date.now() - hiddenAt;
    hiddenAt = null;
    if (everSubscribed && hiddenFor >= hiddenThresholdMs) resync(false);
  };
  const onOnline = () => {
    if (everSubscribed) resync(false);
  };

  // Kiểm cả hàm chứ không chỉ đối tượng: môi trường test (và vài webview) có
  // `document`/`window` dạng rút gọn không có addEventListener — thiếu nghe
  // visibility/online thì chỉ mất hai nguồn bắt kịp phụ, không được làm vỡ kênh.
  const hasDocument = typeof document !== "undefined" && typeof document.addEventListener === "function";
  const hasWindow = typeof window !== "undefined" && typeof window.addEventListener === "function";
  if (hasDocument) document.addEventListener("visibilitychange", onVisibility);
  if (hasWindow) window.addEventListener("online", onOnline);
  const stopManual = onResyncAll(() => resync(true));

  open();

  return () => {
    if (disposed) return;
    disposed = true;
    if (rebuildTimer !== null) clearTimeout(rebuildTimer);
    if (hasDocument) document.removeEventListener("visibilitychange", onVisibility);
    if (hasWindow) window.removeEventListener("online", onOnline);
    stopManual();
    forgetChannel(options.id);
    const channel = current;
    current = null;
    if (channel) void Promise.resolve(supabase.removeChannel(channel)).catch(() => undefined);
  };
}
