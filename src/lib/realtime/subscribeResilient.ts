// =============================================================
// subscribeResilient — vòng đời kênh realtime DÙNG CHUNG: theo dõi trạng thái,
// bắt kịp sau gián đoạn, dựng lại kênh bị server đóng. (21/10/2026, mục A1;
// sửa theo review chéo 22/10/2026: RT-CLIENT-1, -3, -4, -5.)
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
//   - SUBSCRIBED mà trước đó KHÔNG có gián đoạn nào (lần join đầu suôn sẻ, hoặc
//     SUBSCRIBED lặp): không làm gì thêm (dữ liệu vừa tải là mới).
//   - SUBSCRIBED sau CHANNEL_ERROR/TIMED_OUT/CLOSED — KỂ CẢ khi lỗi xảy ra trước
//     lần SUBSCRIBED đầu tiên (join đầu TIMED_OUT trên 4G yếu rồi join lại được):
//     gọi onResync() một lần. Điều kiện là `needResync`, không phải "đã từng
//     SUBSCRIBED" (RT-CLIENT-4: bản cũ bỏ sót mọi thay đổi từ lúc query HTTP tải
//     tới lúc join lại thành công, trong khi dải cảnh báo đã hiện rồi tự ẩn).
//   - Tab ẩn ≥ hiddenThresholdMs rồi hiện lại, hoặc window 'online': onResync().
//     (Trình duyệt hãm timer heartbeat ở tab nền; iOS treo hẳn JS.)
//   - Các nguồn trên hay bắn cùng lúc ⇒ giãn cách GIAN_CACH_BAT_KIP_MS chống dồn.
//     Lượt bắt kịp SAU GIÁN ĐOẠN bị giãn cách chặn thì HOÃN tới
//     lastResyncAt + GIAN_CACH_BAT_KIP_MS (một timer trailing), không vứt
//     (RT-CLIENT-3). Ca điển hình: tab hiện lại ⇒ visibility bắt kịp lúc T1 (HTTP
//     đọc DB lúc T1), phoenix join lại kênh lúc T1+1,5 s — thay đổi commit trong
//     [T1, T1+1,5 s] không có trong lượt fetch và cũng không được realtime giao.
//     Chọn trailing thay vì "đang gián đoạn thì visibility/online nhường cho
//     SUBSCRIBED" vì: (a) hai lần rớt cách nhau < 10 s là ca SUBSCRIBED↔SUBSCRIBED,
//     cách nhường không chữa được; (b) WebSocket bị chặn mà HTTP vẫn chạy thì
//     visibility/online vẫn phải làm tươi được bằng HTTP.
//   - Server báo lỗi postgres_changes qua `system` (status 'error', extension
//     'postgres_changes'): coi như gián đoạn (RT-CLIENT-1). Đây là lỗi IM LẶNG:
//     thiếu MỘT bảng trong publication thì server rollback subscription của CẢ
//     kênh, callback vẫn báo SUBSCRIBED nhưng không bảng nào có event. Báo
//     'interrupted' để dải cảnh báo hiện; `system` 'ok' sau đó ⇒ về 'connected'
//     và bắt kịp. Lần join lại trong lúc lỗi chưa gỡ thì vẫn giữ 'interrupted'
//     (mốc cũ) cho tới khi server báo 'ok' cho postgres_changes.
//   - CLOSED ngoài ý muốn: dựng lại kênh với backoff, topic thêm hậu tố ':r<n>'.
//     Hậu tố là BẮT BUỘC: RealtimeClient.channel() trả lại kênh cũ nếu trùng
//     topic, mà trong lúc leave kênh cũ vẫn còn trong danh sách ⇒ subscribe() lên
//     kênh đó là no-op và kênh chết im lặng.
//     Backoff chỉ về đầu sau khi kênh giữ SUBSCRIBED liền ON_DINH_SAU_MS
//     (RT-CLIENT-5): server nhận join rồi đóng ngay, lặp lại, thì không thành vòng
//     dựng lại ~1 s/lần. Trong vòng dựng lại store giữ 'interrupted' với mốc của
//     lần rớt đầu (open() của vòng dựng lại không báo 'connecting'), để gián đoạn
//     kéo dài vẫn đủ 10 s liên tục cho dải cảnh báo.
//   - Nút "Tải lại dữ liệu" (requestResyncAll) gọi onResync() ngay, không giãn.
//   - Teardown chủ động: không cảnh báo, không dựng lại, rời store sức khoẻ, huỷ
//     mọi timer (dựng lại, trailing, ổn định).
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
/** Kênh giữ SUBSCRIBED liền mạch bao lâu thì backoff dựng lại về mức đầu. */
export const ON_DINH_SAU_MS = 30_000;

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

/** Hình dạng payload `system` (realtime-js RealtimeSystemPayload) — đọc phòng thủ. */
interface SystemPayload {
  extension?: unknown;
  status?: unknown;
  message?: unknown;
}

/** Mở kênh theo hợp đồng ở đầu file. Trả về hàm dọn (idempotent). */
export function subscribeResilient(options: ResilientChannelOptions): () => void {
  const label = options.label ?? options.id;
  const hiddenThresholdMs = options.hiddenThresholdMs ?? AN_TAB_TOI_THIEU_MS;

  let disposed = false;
  let generation = 0;
  let current: RealtimeChannel | null = null;
  let everSubscribed = false;
  let needResync = false;
  /** Server đã báo postgres_changes của kênh hiện tại lỗi và chưa báo 'ok' lại. */
  let postgresChangesError = false;
  let lastResyncAt = Number.NEGATIVE_INFINITY;
  let hiddenAt: number | null = null;
  let rebuildAttempt = 0;
  let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  let trailingTimer: ReturnType<typeof setTimeout> | null = null;
  let stableTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTrailing = () => {
    if (trailingTimer === null) return;
    clearTimeout(trailingTimer);
    trailingTimer = null;
  };
  const clearStable = () => {
    if (stableTimer === null) return;
    clearTimeout(stableTimer);
    stableTimer = null;
  };

  /**
   * `trailing`: lượt này bù cho một gián đoạn thật — bị giãn cách chặn thì hẹn
   * lại đúng lúc hết giãn cách thay vì bỏ (RT-CLIENT-3). Một timer là đủ: nó
   * chạy SAU mọi thay đổi mà lượt bị chặn lẽ ra phải phủ.
   */
  const resync = (force: boolean, trailing = false) => {
    if (disposed) return;
    const now = Date.now();
    const waitMs = lastResyncAt + GIAN_CACH_BAT_KIP_MS - now;
    if (!force && waitMs > 0) {
      if (trailing && trailingTimer === null) {
        trailingTimer = setTimeout(() => {
          trailingTimer = null;
          // force: timer có thể chạy sớm 1 ms hoặc đồng hồ máy lùi — lượt bù này không được bị giãn cách vứt lần nữa.
          resync(true);
        }, waitMs);
      }
      return;
    }
    // Lượt nào chạy cũng phủ luôn việc trailing đang chờ (nó đọc DB muộn hơn).
    clearTrailing();
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
      if (old) await goKenh(old, label);
      if (disposed) return;
      generation += 1;
      open();
    }, delay);
  };

  /** Kênh nhận được event trở lại: về 'connected' và bắt kịp nếu đã có gián đoạn. */
  const markHealthy = () => {
    reportChannelState(options.id, "connected");
    const missed = needResync;
    needResync = false;
    if (missed) resync(false, true);
  };

  const handleStatus = (channel: RealtimeChannel, status: ChannelStatus, err?: Error) => {
    if (disposed || channel !== current) return;
    if (status === "SUBSCRIBED") {
      everSubscribed = true;
      // RT-CLIENT-5: chỉ coi là ổn định khi giữ được SUBSCRIBED một quãng.
      clearStable();
      stableTimer = setTimeout(() => {
        stableTimer = null;
        rebuildAttempt = 0;
      }, ON_DINH_SAU_MS);
      // Server vẫn đang báo postgres_changes lỗi ⇒ join được nhưng chưa có event:
      // giữ 'interrupted' (mốc cũ) và chờ `system` 'ok'.
      if (postgresChangesError) return;
      markHealthy();
      return;
    }
    clearStable();
    reportChannelState(options.id, "interrupted");
    needResync = true;
    if (status === "CLOSED") {
      console.warn(`[realtime] ${label} CLOSED ngoài ý muốn — dựng lại kênh`);
      scheduleRebuild();
      return;
    }
    console.warn(`[realtime] ${label} ${status}`, err?.message ?? "");
  };

  const handleSystem = (channel: RealtimeChannel, payload: SystemPayload | null | undefined) => {
    if (disposed || channel !== current) return;
    if (!payload || payload.extension !== "postgres_changes") return;
    if (payload.status === "error") {
      // RT-CLIENT-1: thiếu một bảng trong publication (hoặc binding sai) làm CẢ
      // kênh mất postgres_changes trong khi callback vẫn là SUBSCRIBED.
      console.warn(
        `[realtime] ${label} postgres_changes lỗi — kênh SUBSCRIBED nhưng không nhận event`,
        typeof payload.message === "string" ? payload.message : "",
      );
      postgresChangesError = true;
      needResync = true;
      reportChannelState(options.id, "interrupted");
      return;
    }
    if (payload.status === "ok" && postgresChangesError) {
      postgresChangesError = false;
      markHealthy();
    }
  };

  function open() {
    const topic = generation === 0 ? options.topic : `${options.topic}:r${generation}`;
    const channel = options.bind(supabase.channel(topic));
    current = channel;
    // Gắn TRƯỚC subscribe(). Mock/webview rút gọn có thể thiếu .on — khi đó chỉ
    // mất đường báo lỗi postgres_changes, không được làm vỡ kênh.
    if (typeof channel.on === "function") {
      channel.on("system", {}, (payload: SystemPayload) => handleSystem(channel, payload));
    }
    // Vòng dựng lại (generation > 0) giữ nguyên 'interrupted' với mốc cũ.
    if (generation === 0) reportChannelState(options.id, "connecting");
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
    clearTrailing();
    clearStable();
    if (hasDocument) document.removeEventListener("visibilitychange", onVisibility);
    if (hasWindow) window.removeEventListener("online", onOnline);
    stopManual();
    forgetChannel(options.id);
    const channel = current;
    current = null;
    if (channel) void goKenh(channel, label);
  };
}

/** Gỡ kênh khỏi socket. Lỗi gỡ không chặn dựng lại/dọn — kênh cũ đã bị bỏ khỏi
 *  vòng đời — nhưng phải để lại vết, không nuốt câm. */
async function goKenh(channel: RealtimeChannel, label: string): Promise<void> {
  try {
    await supabase.removeChannel(channel);
  } catch (error) {
    console.warn(`[realtime] ${label} gỡ kênh lỗi`, error);
  }
}
