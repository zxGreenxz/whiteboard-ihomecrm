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
 *
 * ── Về việc GHI LỖI (viết lại 31/08/2026) ──────────────────────────────────
 *
 * Ba lỗ hổng cũ làm nhật ký lỗi mỏng đến mức đọc xong không kết luận được gì:
 *
 *  1. Listener chỉ gắn SAU khi React mount xong chunk lazy của trang — tức là
 *     muộn khoảng 0,5–3 giây trên 4G. Mọi lỗi lúc tải tài liệu, đúng quãng mà
 *     WebView in-app tiêm script cầu nối vào, rơi vào khoảng mù. Nay `public/
 *     pt-boot.js` gắn listener ngay từ thẻ script đầu tiên và xếp hàng; tracker
 *     start thì rút hàng đợi rồi cắm hook để nhận trực tiếp. MỘT đường dẫn duy
 *     nhất: có hàng đợi thì KHÔNG gắn listener riêng, tránh ghi đúp.
 *
 *  2. `flush` xoá buffer TRƯỚC khi gọi mạng rồi nuốt lỗi — một lần rớt sóng là
 *     mất trắng cả lô, không dấu vết ở đâu cả. Nay lô được LẤY RA khỏi buffer
 *     bằng `splice` ngay lúc gửi (không ai lấy lại được nó), hỏng thì TRẢ VỀ
 *     đầu hàng; hỏng liên tiếp thì ký gửi phần sự kiện LỖI vào localStorage để
 *     lần tải sau gửi tiếp. Chỗ dễ sai nhất: `supabase.rpc` KHÔNG ném khi mạng
 *     hỏng hay máy chủ trả 5xx — nó fulfil kèm `{ error }`, nên phải soi `error`
 *     chứ không thể trông vào `try/catch`.
 *
 *  3. Lỗi lặp không được gộp: một script hỏng bắn mỗi giây có thể sinh hàng
 *     nghìn dòng giống hệt nhau. Nay mỗi vân tay chỉ ghi MỘT dòng kèm bộ đếm
 *     `n`, cập nhật lại `n` ở lần flush cuối; bên đọc lấy MAX(n) theo
 *     (phiên, vân tay) nên gửi trùng cũng không cộng dồn sai.
 */

import { supabase } from "@/integrations/supabase/client";
import { BUILD_SHA } from "@/buildMetadata";
import {
  fromEarlyRecord,
  getEarlyErrorQueue,
  normalizeError,
  type EarlyErrorQueue,
  type EarlyErrorRecord,
  type PtErrorInput,
  type PtErrorMeta,
} from "./errorTelemetry";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const ANON = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;

const FLUSH_INTERVAL_MS = 8000;
const FLUSH_AT_N = 20;
/** Trần buffer khi mất mạng dài — vượt thì bỏ sự kiện CŨ NHẤT, giữ lại cái mới. */
const MAX_BUFFER = 200;
/** Hỏng liên tiếp bao nhiêu lần thì ngừng giữ lô trong RAM và ký gửi phần lỗi. */
const MAX_FAIL_STREAK = 5;
/** Trần số vân tay lỗi khác nhau trong một phiên — chặn phiên "lỗi vô hạn kiểu mới". */
const MAX_ERROR_KINDS = 100;
/** Trần sự kiện lỗi ký gửi qua localStorage. */
const PERSIST_MAX = 25;

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
  /** Ghi 1 LỖI: tự chuẩn hoá, phân loại nguồn, gộp trùng theo vân tay. */
  trackError(input: PtErrorInput): void;
  /** Đẩy buffer hiện tại qua supabase.rpc (non-final). */
  flush(): void;
  /** Gửi NGAY kiểu keepalive — dùng khi trang sắp reload/đóng (ErrorBoundary). */
  flushNow(): void;
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
  trackError() {},
  flush() {},
  flushNow() {},
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
  const PERR_KEY = `pt_perr_${token}`;
  let sessionId = "";
  try { sessionId = sessionStorage.getItem(SID_KEY) || ""; } catch { /* privacy mode: không có sessionStorage */ }
  if (!sessionId) {
    sessionId =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `s-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    try { sessionStorage.setItem(SID_KEY, sessionId); } catch { /* privacy mode: bỏ qua, session vẫn chạy trong RAM */ }
  }

  let buffer: QueuedEvent[] = [];
  let timer: number | undefined;
  let running = false; // reversible: StrictMode mount→unmount→mount để lại tracker SỐNG
  let inFlight = false;
  let failStreak = 0;
  const seenImpressions = new Set<string>();
  /** vân tay lỗi → số lần gặp (`n`) và số lần đã báo về máy chủ (`sent`). */
  const errSeen = new Map<string, { n: number; sent: number; meta: PtErrorMeta }>();
  let errOverflowed = false;
  /** Hàng đợi bắt sớm khi đang cắm hook (null nếu dùng listener dự phòng). */
  let earlyBag: EarlyErrorQueue | null = null;
  let fallbackListeners = false;

  // ----- active (visible) time -----
  let activeMs = 0;
  let lastResume: number | null = null;

  const ua = () => (typeof navigator !== "undefined" ? navigator.userAgent : null);
  const href = () => (typeof location !== "undefined" ? location.href : undefined);
  const origin = () => (typeof location !== "undefined" ? location.origin : undefined);
  const viewport = () =>
    typeof window !== "undefined" && window.innerWidth
      ? `${window.innerWidth}x${window.innerHeight}`
      : undefined;

  function pushToBuffer(e: QueuedEvent) {
    // Mất mạng dài: thà bỏ sự kiện cũ nhất còn hơn để buffer phình vô hạn.
    if (buffer.length >= MAX_BUFFER) buffer.shift();
    buffer.push(e);
  }

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
    pushToBuffer(e);
    if (buffer.length >= FLUSH_AT_N) flush(false);
  }

  /* ── Ghi lỗi ─────────────────────────────────────────────────────────────── */

  function trackError(input: PtErrorInput) {
    const meta = normalizeError(
      {
        ...input,
        ua: input.ua ?? ua(),
        href: input.href ?? href(),
        vp: input.vp ?? viewport(),
        build: input.build ?? (BUILD_SHA || undefined),
        ts: input.ts ?? Date.now(),
      },
      origin(),
    );

    const prev = errSeen.get(meta.fp);
    if (prev) {
      prev.n += 1; // đã có một dòng cho vân tay này; chỉ đếm thêm
      return;
    }
    if (errSeen.size >= MAX_ERROR_KINDS) {
      if (errOverflowed) return;
      errOverflowed = true;
      // Ghi đúng một dòng nói rằng đã cắt — im lặng cắt là cách tạo ra báo cáo
      // trông đầy đủ mà thật ra thiếu.
      enqueue("error", {
        metadata: {
          kind: "js",
          msg: `[đã cắt] phiên vượt ${MAX_ERROR_KINDS} loại lỗi khác nhau`,
          source: "app",
          fp: "overflow0",
          n: 1,
        },
      });
      return;
    }

    errSeen.set(meta.fp, { n: 1, sent: 1, meta });
    enqueue("error", {
      room_id: input.room_id,
      metadata: { ...meta } as unknown as Record<string, unknown>,
    });
  }

  /** Gửi lại các vân tay có `n` tăng thêm kể từ lần báo trước. */
  function flushErrorCounters() {
    errSeen.forEach((rec) => {
      if (rec.n <= rec.sent) return;
      rec.sent = rec.n;
      enqueue("error", {
        metadata: { ...rec.meta, n: rec.n } as unknown as Record<string, unknown>,
      });
    });
  }

  /* ── Ký gửi qua localStorage khi mạng hỏng ───────────────────────────────── */

  /**
   * Chỉ ký gửi sự kiện LỖI. Sự kiện khác (session/impression) mà gửi lại ở lần
   * tải sau sẽ đếm đúp lượt xem — còn lỗi thì bên đọc gộp theo (phiên, vân tay)
   * và lấy MAX(n), nên gửi trùng vô hại.
   */
  function persistErrors(batch: QueuedEvent[]) {
    const errs = batch.filter((e) => e.event_type === "error");
    if (!errs.length) return;
    try {
      const raw = localStorage.getItem(PERR_KEY);
      const old: QueuedEvent[] = raw ? (JSON.parse(raw) as QueuedEvent[]) : [];
      const merged = [...old, ...errs].slice(-PERSIST_MAX);
      localStorage.setItem(PERR_KEY, JSON.stringify(merged));
    } catch {
      /* hết quota / privacy mode: ký gửi là nỗ lực thêm, hỏng thì thôi */
    }
  }

  function drainPersisted() {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(PERR_KEY);
      if (raw) localStorage.removeItem(PERR_KEY);
    } catch {
      /* không đọc được kho ký gửi thì coi như không có */
    }
    if (!raw) return;
    try {
      const old = JSON.parse(raw) as QueuedEvent[];
      if (!Array.isArray(old)) return;
      // Giữ NGUYÊN session_id cũ: lỗi đó thuộc về phiên đã sinh ra nó.
      for (const e of old.slice(-PERSIST_MAX)) {
        if (e && e.event_type === "error" && typeof e.session_id === "string") pushToBuffer(e);
      }
    } catch {
      /* kho ký gửi hỏng định dạng: bỏ, đã xoá khoá ở trên */
    }
  }

  /* ── Gửi ─────────────────────────────────────────────────────────────────── */

  async function flush(final: boolean) {
    if (inFlight && !final) return; // tránh hai lô cùng bay, gửi đúp
    if (!buffer.length) return;
    // LẤY LÔ RA KHỎI buffer NGAY, không "đọc rồi cắt sau".
    //
    // Bản trước chụp `buffer.slice(0, 50)` rồi mới cắt bằng `slice(batch.length)`
    // sau khi await. Hai thao tác đó chạy lệch pha nhau trên một mảng vẫn đang
    // đổi, và điều đó hỏng theo hai đường đã tái hiện được: (a) khách rời trang
    // giữa chừng → flush cuối lấy LẠI đúng lô đang bay, gửi đúp toàn bộ rồi cắt
    // lấn sang phần chưa ai gửi; (b) buffer chạm trần → mỗi `shift()` trong cửa
    // sổ chờ làm phép cắt trượt đi một ô, đánh rơi đúng bấy nhiêu sự kiện. Cả
    // hai đều im lặng, và phía báo cáo thì impression/room_open đếm COUNT(*)
    // nên gửi đúp là số liệu phồng gấp đôi.
    const batch = buffer.splice(0, 50); // RPC ghi cắt cứng 50/lô
    const body = JSON.stringify({ p_token: token, p_events: batch });

    if (final) {
      // Đang rời trang: không có cơ hội đợi kết quả. Offline thì keepalive chắc
      // chắn hỏng → ký gửi thẳng thay vì ném vào hư không.
      const offline = typeof navigator !== "undefined" && navigator.onLine === false;
      if (offline || typeof fetch === "undefined") {
        persistErrors(batch);
        return;
      }
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
      }).catch(() => {
        // Trang có thể đã đóng nên nhánh này không chắc chạy. Khi nó CHẠY (tab
        // vừa ẩn, chưa đóng) thì phần lỗi vẫn được ký gửi cho lần tải sau.
        persistErrors(batch);
      });
      return;
    }

    inFlight = true;
    try {
      // periodic: supabase.rpc tự set apikey/Authorization/Content-Profile.
      // PHẢI await — PostgREST builder lazy, chỉ gửi request khi .then().
      const res = await (
        supabase.rpc as unknown as (
          fn: string,
          params: unknown,
        ) => PromiseLike<{ data: unknown; error: unknown }>
      )("log_public_room_events", { p_token: token, p_events: batch });

      // postgrest-js KHÔNG BAO GIỜ ném với client này (`shouldThrowOnError`
      // mặc định false, và nó bắt luôn cả lỗi fetch cấp mạng). Mọi hỏng hóc —
      // mất sóng, 4xx, 5xx — đều về dưới dạng promise ĐÃ FULFIL kèm `error`.
      // Bọc try/catch không thôi là bắt hụt: nhánh giữ lô sẽ không bao giờ chạy.
      const { error } = (res ?? {}) as { data: unknown; error: unknown };
      if (error) throw error;
      failStreak = 0;
      // `data` là số dòng máy chủ ghi THẬT. Ít hơn kích thước lô nghĩa là có
      // dòng dị dạng bị bỏ, hoặc token đã thu hồi (trả 0) — gửi lại cũng ra kết
      // quả y hệt, nên KHÔNG giữ lô lại: giữ chỉ tạo vòng lặp vô ích.
    } catch {
      // Nuốt ở đây là cố ý: khách không bao giờ được thấy sự cố của bộ đo đếm.
      failStreak += 1;
      if (failStreak >= MAX_FAIL_STREAK) {
        // Hỏng dai dẳng: giữ mãi thì buffer nghẽn và mọi sự kiện sau đều kẹt.
        persistErrors(batch);
        failStreak = 0;
      } else {
        // Trả lô về ĐẦU hàng, giữ nguyên thứ tự thời gian.
        buffer = batch.concat(buffer);
        // Chạm trần thì bỏ phần MỚI nhất — lô vừa trả về là thứ đã đếm vào bộ
        // đếm lỗi, mất nó là mất luôn con số đó.
        if (buffer.length > MAX_BUFFER) buffer.length = MAX_BUFFER;
      }
    } finally {
      inFlight = false;
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
      flushErrorCounters();
      flush(true);
    } else if (lastResume == null) {
      lastResume = nowMs();
    }
  };
  const onPageHide = () => {
    emitDuration();
    flushErrorCounters();
    flush(true);
  };

  /** Cầu nối nhận bản ghi thô từ pt-boot.js. */
  const earlyHook = (rec: EarlyErrorRecord) => {
    const input = fromEarlyRecord(rec);
    if (input) trackError(input);
  };

  /** Listener dự phòng khi pt-boot.js không chạy (điều hướng SPA, test). */
  const onError = (ev: Event) => {
    const e = ev as ErrorEvent;
    const target = ev.target as (Element & { src?: string; href?: string }) | null;
    if (target && typeof target.tagName === "string") {
      // Pha capture bắt cả tài nguyên hỏng (<img>/<script>/<link>) — chúng KHÔNG
      // nổi bọt nên listener không-capture của bản cũ chẳng bao giờ thấy.
      trackError({
        kind: "resource",
        msg: `resource load failed: ${target.tagName}`,
        src: target.src || target.href,
      });
      return;
    }
    trackError({
      kind: "js",
      msg: e.message,
      src: e.filename,
      line: e.lineno,
      col: e.colno,
      stack: (e.error as Error | undefined)?.stack,
    });
  };
  const onRejection = (ev: PromiseRejectionEvent) => {
    const reason = ev.reason as unknown;
    trackError({
      kind: "unhandledrejection",
      msg: String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  };

  return {
    enabled: true,
    sessionId,
    track: enqueue,
    trackError,
    flush: () => flush(false),
    flushNow() {
      flushErrorCounters();
      flush(true);
    },
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
      drainPersisted(); // lỗi còn nợ từ lần tải trước
      // page_view: 1 lần / session (chống StrictMode double-mount + refetch focus).
      let pvDone = false;
      try { pvDone = sessionStorage.getItem(PV_KEY) === sessionId; } catch { /* privacy mode: coi như chưa ghi */ }
      if (!pvDone) {
        try { sessionStorage.setItem(PV_KEY, sessionId); } catch { /* privacy mode: chấp nhận ghi lại ở tab sau */ }
        enqueue("session", {
          metadata: {
            _session: {
              ua: ua(),
              referrer: typeof document !== "undefined" ? document.referrer || null : null,
              viewport: viewport() ?? null,
              lang: typeof navigator !== "undefined" ? navigator.language : null,
              build: BUILD_SHA || null,
            },
          },
        });
      }
      if (typeof window !== "undefined") {
        timer = window.setInterval(() => flush(false), FLUSH_INTERVAL_MS);
        document.addEventListener("visibilitychange", onVisibility);
        window.addEventListener("pagehide", onPageHide);

        const early = getEarlyErrorQueue();
        if (early) {
          // Rút hàng đợi rồi cắm hook. MỘT đường dẫn duy nhất — không gắn thêm
          // listener, nếu không mỗi lỗi sẽ vào hai lần.
          earlyBag = early;
          const queued = early.q.splice(0, early.q.length);
          for (const rec of queued) earlyHook(rec);
          early.hook = earlyHook;
        } else {
          window.addEventListener("error", onError, true);
          window.addEventListener("unhandledrejection", onRejection);
          fallbackListeners = true;
        }
      }
    },
    stop() {
      if (!running) return;
      running = false;
      if (timer != null && typeof window !== "undefined") window.clearInterval(timer);
      if (typeof window !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener("pagehide", onPageHide);
        if (fallbackListeners) {
          window.removeEventListener("error", onError, true);
          window.removeEventListener("unhandledrejection", onRejection);
          fallbackListeners = false;
        }
      }
      if (earlyBag) {
        // Chỉ gỡ hook của CHÍNH mình — tracker khác có thể đã cắm hook mới.
        if (earlyBag.hook === earlyHook) earlyBag.hook = null;
        earlyBag = null;
      }
      emitDuration();
      flushErrorCounters();
      flush(true);
    },
  };
}
