/**
 * Bộ đo đếm trang công khai "Phòng trống" (/r/:token) — CORE (framework-agnostic).
 *
 * - Ghi sự kiện ẩn danh qua RPC `log_public_room_events` (SECURITY DEFINER, anon).
 * - Buffer trong RAM, flush theo: timer 8s / buffer ≥ 20 / khi rời trang (page-hide).
 * - Flush thường dùng supabase.rpc; flush CUỐI (unload) dùng fetch(keepalive) vì
 *   sendBeacon KHÔNG set được header apikey/Authorization mà PostgREST yêu cầu.
 * - No-op khi không có token. Mọi lỗi log đều bị nuốt — không bao giờ lộ cho khách.
 * - Thời gian xem trang = thời gian ĐANG HIỂN THỊ (Page Visibility), gửi qua event
 *   'session'.duration_ms; báo cáo lấy MAX duration / session (an toàn nhiều dòng).
 */

import { supabase } from "@/integrations/supabase/client";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const ANON = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;

const FLUSH_INTERVAL_MS = 8000;
const FLUSH_AT_N = 20;

export type TrackType =
  | "session"
  | "impression"
  | "building_select"
  | "view_mode"
  | "room_open"
  | "image_view"
  | "floorplan_view"
  | "contact_click"
  | "share"
  | "download"
  | "directions"
  | "favorite"
  | "deposit_dialog"
  | "error";

export interface TrackPayload {
  room_id?: string;
  room_name?: string;
  room_code?: string;
  building_id?: string;
  building_name?: string;
  dwell_ms?: number;
  duration_ms?: number;
  metadata?: Record<string, unknown>;
}

interface QueuedEvent {
  event_type: TrackType;
  session_id: string;
  room_id?: string;
  room_name?: string;
  room_code?: string;
  building_id?: string;
  building_name?: string;
  dwell_ms?: number;
  duration_ms?: number;
  metadata: Record<string, unknown>;
}

export interface Tracker {
  readonly enabled: boolean;
  readonly sessionId: string;
  /** Ghi 1 sự kiện (đẩy vào buffer; không block UI). */
  track(type: TrackType, payload?: TrackPayload): void;
  /** Đẩy buffer hiện tại qua supabase.rpc (non-final). */
  flush(): void;
  /** Cập nhật cờ nhân viên nội bộ (session/perms nạp trễ sau page_view). */
  setStaff(v: boolean): void;
  /** Gắn listener + page_view + timer (gọi trong useEffect mount). */
  start(): void;
  /** Flush cuối + gỡ listener (gọi trong cleanup unmount / rời trang). Idempotent. */
  stop(): void;
}

export const NOOP_TRACKER: Tracker = {
  enabled: false,
  sessionId: "",
  track() {},
  flush() {},
  setStaff() {},
  start() {},
  stop() {},
};

const isUuid = (v?: string): v is string => !!v && /^[0-9a-fA-F-]{36}$/.test(v);

const nowMs = (): number =>
  typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();

export function createTracker(
  token: string | undefined,
  opts: { isStaff: boolean },
): Tracker {
  if (!token) return NOOP_TRACKER;

  const RPC_URL = `${SUPABASE_URL}/rest/v1/rpc/log_public_room_events`;
  let isStaff = !!opts.isStaff;

  // session_id: 1 / lượt truy cập / tab (giữ qua sessionStorage để StrictMode remount
  // + refetchOnWindowFocus không tạo session mới).
  const SID_KEY = `pt_sid_${token}`;
  const PV_KEY = `pt_pv_${token}`;
  let sessionId = "";
  try { sessionId = sessionStorage.getItem(SID_KEY) || ""; } catch { /* */ }
  if (!sessionId) {
    sessionId =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `s-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    try { sessionStorage.setItem(SID_KEY, sessionId); } catch { /* */ }
  }

  let buffer: QueuedEvent[] = [];
  let timer: number | undefined;
  let running = false; // reversible: StrictMode mount→unmount→mount để lại tracker SỐNG
  const seenImpressions = new Set<string>();

  // ----- active (visible) time -----
  let activeMs = 0;
  let lastResume: number | null = null;

  const ua = () => (typeof navigator !== "undefined" ? navigator.userAgent : null);

  function enqueue(type: TrackType, payload: TrackPayload = {}) {
    // Dedupe impression: tối đa 1 / phòng / session.
    if (type === "impression" && payload.room_id) {
      if (seenImpressions.has(payload.room_id)) return;
      seenImpressions.add(payload.room_id);
    }
    const e: QueuedEvent = {
      event_type: type,
      session_id: sessionId,
      metadata: { ...(payload.metadata || {}), is_staff: isStaff },
    };
    if (isUuid(payload.room_id)) e.room_id = payload.room_id;
    if (payload.room_name) e.room_name = payload.room_name.slice(0, 200);
    if (payload.room_code) e.room_code = payload.room_code.slice(0, 64);
    if (isUuid(payload.building_id)) e.building_id = payload.building_id;
    if (payload.building_name) e.building_name = payload.building_name.slice(0, 200);
    if (typeof payload.dwell_ms === "number" && isFinite(payload.dwell_ms))
      e.dwell_ms = Math.max(0, Math.round(payload.dwell_ms));
    if (typeof payload.duration_ms === "number" && isFinite(payload.duration_ms))
      e.duration_ms = Math.max(0, Math.round(payload.duration_ms));
    buffer.push(e);
    if (buffer.length >= FLUSH_AT_N) flush(false);
  }

  async function flush(final: boolean) {
    if (!buffer.length) return;
    const batch = buffer;
    buffer = [];
    const body = JSON.stringify({ p_token: token, p_events: batch });
    try {
      if (final && typeof fetch !== "undefined") {
        // keepalive sống sót qua unload; KHÔNG dùng sendBeacon (không set được header).
        fetch(RPC_URL, {
          method: "POST",
          keepalive: true,
          headers: {
            apikey: ANON,
            Authorization: `Bearer ${ANON}`,
            "Content-Type": "application/json",
            "Content-Profile": "public",
          },
          body,
        }).catch(() => {});
      } else {
        // periodic: supabase.rpc tự set apikey/Authorization/Content-Profile.
        // PHẢI await — PostgREST builder lazy, chỉ gửi request khi .then().
        await (supabase.rpc as unknown as (fn: string, params: unknown) => PromiseLike<unknown>)(
          "log_public_room_events",
          { p_token: token, p_events: batch },
        );
      }
    } catch {
      /* nuốt — không bao giờ lộ cho khách */
    }
  }

  function accumulate() {
    if (lastResume != null) {
      activeMs += nowMs() - lastResume;
      lastResume = null;
    }
  }

  function emitDuration() {
    accumulate();
    enqueue("session", { duration_ms: activeMs, metadata: { ua: ua() } });
    // nếu khách quay lại (visible) thì tiếp tục đếm
    if (typeof document !== "undefined" && document.visibilityState === "visible") {
      lastResume = nowMs();
    }
  }

  // ----- listeners -----
  const onVisibility = () => {
    if (typeof document === "undefined") return;
    if (document.visibilityState === "hidden") {
      emitDuration();
      flush(true);
    } else if (lastResume == null) {
      lastResume = nowMs();
    }
  };
  const onPageHide = () => {
    emitDuration();
    flush(true);
  };
  const onError = (ev: ErrorEvent) =>
    enqueue("error", {
      metadata: { kind: "window", msg: String(ev.message).slice(0, 500), src: ev.filename, ua: ua() },
    });
  const onRejection = (ev: PromiseRejectionEvent) =>
    enqueue("error", {
      metadata: { kind: "unhandledrejection", msg: String(ev.reason).slice(0, 500), ua: ua() },
    });

  return {
    enabled: true,
    sessionId,
    track: enqueue,
    flush: () => flush(false),
    setStaff(v: boolean) {
      isStaff = !!v;
    },
    start() {
      if (running) return;
      running = true;
      lastResume =
        typeof document === "undefined" || document.visibilityState === "visible"
          ? nowMs()
          : null;
      // page_view: 1 lần / session (chống StrictMode double-mount + refetch focus).
      let pvDone = false;
      try { pvDone = sessionStorage.getItem(PV_KEY) === sessionId; } catch { /* */ }
      if (!pvDone) {
        try { sessionStorage.setItem(PV_KEY, sessionId); } catch { /* */ }
        enqueue("session", {
          metadata: {
            _session: {
              ua: ua(),
              referrer: typeof document !== "undefined" ? document.referrer || null : null,
              viewport:
                typeof window !== "undefined" ? `${window.innerWidth}x${window.innerHeight}` : null,
              lang: typeof navigator !== "undefined" ? navigator.language : null,
            },
          },
        });
      }
      if (typeof window !== "undefined") {
        timer = window.setInterval(() => flush(false), FLUSH_INTERVAL_MS);
        document.addEventListener("visibilitychange", onVisibility);
        window.addEventListener("pagehide", onPageHide);
        window.addEventListener("error", onError);
        window.addEventListener("unhandledrejection", onRejection);
      }
    },
    stop() {
      if (!running) return;
      running = false;
      if (timer != null && typeof window !== "undefined") window.clearInterval(timer);
      if (typeof window !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener("pagehide", onPageHide);
        window.removeEventListener("error", onError);
        window.removeEventListener("unhandledrejection", onRejection);
      }
      emitDuration();
      flush(true);
    },
  };
}
