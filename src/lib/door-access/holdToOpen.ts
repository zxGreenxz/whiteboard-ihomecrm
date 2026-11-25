/**
 * Giữ để mở cửa (màn điện thoại, Bản A — chủ duyệt 25/11): thay hộp xác nhận bằng một lần GIỮ 1 giây
 * trên vòng vân tay. Buông sớm là huỷ. Lệnh gửi đúng một lần mỗi lần giữ đủ; kết quả "chưa rõ" KHÔNG
 * bao giờ tự gửi lại — người dùng xem Lịch sử ra vào rồi bấm "Đã hiểu" mới giữ lại được.
 *
 * File này chỉ có hàm thuần (bộ chuyển trạng thái + chữ/màu theo trạng thái) để test không cần DOM.
 * Phần gắn sự kiện con trỏ/bàn phím và đồng hồ nằm ở `src/hooks/door-access/useHoldToOpen.ts`.
 */

/** Thời gian phải giữ liên tục để gửi lệnh mở. */
export const HOLD_TO_OPEN_MS = 1000;
/** "Cửa đã mở" giữ trên màn chừng này rồi nút sẵn sàng lại. */
export const OPENED_RESET_MS = 5000;

export type HoldPhase =
  | "idle"
  | "hint"
  | "holding"
  | "sending"
  | "opened"
  | "failed"
  | "unknown"
  | "rate_limited";

/** Kết quả lệnh mở cửa, đã phân loại từ câu trả lời của hàm Edge. */
export type HoldOutcome =
  | { kind: "opened"; logPending: boolean }
  | { kind: "failed"; message: string; logPending: boolean }
  | { kind: "unknown"; message: string; logPending: boolean }
  | { kind: "rate_limited"; message: string };

export interface HoldState {
  phase: HoldPhase;
  /** Mốc bắt đầu giữ (ms, cùng đồng hồ với `at` của sự kiện). */
  startedAt: number | null;
  /** 0…1 khi đang giữ. */
  progress: number;
  /** Câu chi tiết của kết quả (lỗi máy chủ, chưa rõ…). */
  message: string | null;
  logPending: boolean;
}

export type HoldEvent =
  | { type: "press"; at: number }
  | { type: "tick"; at: number }
  | { type: "release"; at: number }
  /** Mất tiêu điểm, đổi tab, con trỏ bị huỷ khi chưa đủ giờ: coi như chưa giữ. */
  | { type: "cancel" }
  | { type: "result"; outcome: HoldOutcome }
  /** "Đã hiểu", hết 5 giây sau khi mở, hoặc đổi cửa. */
  | { type: "reset" };

export const INITIAL_HOLD_STATE: HoldState = { phase: "idle", startedAt: null, progress: 0, message: null, logPending: false };

/** Trạng thái được phép bắt đầu một lần giữ mới. "unknown"/"rate_limited" phải bấm "Đã hiểu" trước. */
export function canStartHold(phase: HoldPhase): boolean {
  return phase === "idle" || phase === "hint" || phase === "failed";
}

const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);

/**
 * Bộ chuyển trạng thái. `blocked` = nút đang khoá vì lý do ngoài (không có quyền, chỉ đọc, mất kết nối):
 * khi khoá, "press" không làm gì. Chuyển "holding" ⇒ "sending" xảy ra ĐÚNG MỘT lần mỗi lần giữ, ở
 * "tick" đầu tiên đạt đủ 1 giây — nơi gọi dùng chính chuyển này để gửi lệnh (xem `firedBy`).
 */
export function holdReducer(state: HoldState, event: HoldEvent, blocked = false): HoldState {
  switch (event.type) {
    case "press":
      if (blocked || !canStartHold(state.phase)) return state;
      return { phase: "holding", startedAt: event.at, progress: 0, message: null, logPending: false };
    case "tick": {
      if (state.phase !== "holding" || state.startedAt === null) return state;
      const progress = clamp01((event.at - state.startedAt) / HOLD_TO_OPEN_MS);
      if (progress >= 1) return { ...state, phase: "sending", startedAt: null, progress: 1 };
      return progress === state.progress ? state : { ...state, progress };
    }
    case "release": {
      if (state.phase !== "holding" || state.startedAt === null) return state;
      // Buông đúng lúc đủ giờ mà nhịp vẽ chưa kịp chạy: vẫn tính là giữ đủ.
      if (event.at - state.startedAt >= HOLD_TO_OPEN_MS) return { ...state, phase: "sending", startedAt: null, progress: 1 };
      return { ...INITIAL_HOLD_STATE, phase: "hint" };
    }
    case "cancel":
      return state.phase === "holding" ? INITIAL_HOLD_STATE : state;
    case "result": {
      if (state.phase !== "sending") return state;
      const { outcome } = event;
      switch (outcome.kind) {
        case "opened":
          return { phase: "opened", startedAt: null, progress: 1, message: null, logPending: outcome.logPending };
        case "failed":
          return { phase: "failed", startedAt: null, progress: 0, message: outcome.message, logPending: outcome.logPending };
        case "unknown":
          return { phase: "unknown", startedAt: null, progress: 1, message: outcome.message, logPending: outcome.logPending };
        case "rate_limited":
          return { phase: "rate_limited", startedAt: null, progress: 0, message: outcome.message, logPending: false };
      }
      return state;
    }
    case "reset":
      // Đang gửi lệnh thì không cho xoá trạng thái: kết quả phải về được tới màn hình.
      return state.phase === "sending" ? state : INITIAL_HOLD_STATE;
  }
}

/** Sự kiện này vừa làm nút chuyển sang gửi lệnh (gọi mở cửa đúng một lần). */
export function firedBy(before: HoldState, after: HoldState): boolean {
  return before.phase === "holding" && after.phase === "sending";
}

// ---------------------------------------------------------------------------------------------
// Kết quả của hàm Edge ⇒ HoldOutcome

export interface UnlockErrorLike {
  kind?: string;
  message?: string;
  outcomeUnknown?: boolean;
  logPending?: boolean;
}

export const UNLOCK_UNCONFIRMED = "SmartLife chưa xác nhận đã mở cửa. Xem lịch sử ra vào trước khi mở lại.";
export const UNLOCK_UNKNOWN = "Mạng chậm nên chưa nhận được trả lời. Xem lịch sử ra vào trước khi mở lại.";
export const UNLOCK_RATE_LIMITED = "Giới hạn tính trên mọi cửa, để chặn bấm nhầm liên tục. Thử lại sau ít phút.";
/** Trần của máy chủ: 10 lệnh mở cửa / 10 phút / người, đếm mọi lệnh (kể cả thất bại) trên mọi cửa. */
export const UNLOCK_RATE_LIMITED_TITLE = "Đã gửi 10 lệnh mở trong 10 phút";

/** `{unlocked}` của hàm Edge: false = SmartLife nhận lệnh nhưng chưa xác nhận ⇒ coi như chưa rõ. */
export function unlockSuccessOutcome(data: { unlocked: boolean; logPending?: boolean }): HoldOutcome {
  const logPending = data.logPending === true;
  return data.unlocked ? { kind: "opened", logPending } : { kind: "unknown", message: UNLOCK_UNCONFIRMED, logPending };
}

/** Lỗi ⇒ kết quả. `outcomeUnknown` (lệnh có thể đã chạy) luôn thắng: không bao giờ báo "chưa mở được". */
export function unlockErrorOutcome(error: UnlockErrorLike | null | undefined, fallback: string): HoldOutcome {
  const logPending = error?.logPending === true;
  if (error?.outcomeUnknown) return { kind: "unknown", message: UNLOCK_UNKNOWN, logPending };
  if (error?.kind === "rate_limited") return { kind: "rate_limited", message: UNLOCK_RATE_LIMITED };
  return { kind: "failed", message: error?.message || fallback, logPending };
}

// ---------------------------------------------------------------------------------------------
// Nút khoá vì lý do ngoài (bốn ô cuối của artboard Trạng thái)

export type HoldBlock = "no_permission" | "read_only" | "offline";

/** Ưu tiên: thiếu quyền > chỉ đọc > mất kết nối. `online === null` = chưa biết ⇒ không khoá. */
export function holdBlock(input: { canRemoteUnlock: boolean; writable: boolean; online: boolean | null }): HoldBlock | null {
  if (!input.canRemoteUnlock) return "no_permission";
  if (!input.writable) return "read_only";
  if (input.online === false) return "offline";
  return null;
}

// ---------------------------------------------------------------------------------------------
// Chữ và màu theo trạng thái (artboard "Trạng thái" — 10 ô)

export type DialTone = "ready" | "holding" | "sending" | "opened" | "failed" | "unknown" | "off";

export interface DialView {
  tone: DialTone;
  title: string;
  sub: string;
  /** Vòng ngoài: 0…1. */
  ring: number;
  /** Số đường vân sáng (0…RIDGE_COUNT). */
  litRidges: number;
  /** Nút nhận thao tác giữ không. */
  interactive: boolean;
  /** Hiện "Xem lịch sử" + "Đã hiểu" thay cho nút tạo mã. */
  needsAck: boolean;
}

export const RIDGE_COUNT = 9;

/**
 * Đường vân sáng theo tiến độ giữ: vân thứ i (0-based) sáng khi progress ≥ (i+1)/9. Dùng làm bậc cho
 * vòng ngoài khi người dùng bật "giảm chuyển động" — vòng nhảy theo vân thay vì chạy mượt.
 */
export function ridgesLit(progress: number): number {
  return Math.min(RIDGE_COUNT, Math.floor(clamp01(progress) * RIDGE_COUNT + 1e-9));
}

export interface DialContext {
  doorLabel: string;
  /** "14:05" — giờ máy nhận lệnh, cho dòng "Đã ghi vào nhật ký lúc …". */
  openedAtText: string | null;
}

const BLOCK_TEXT: Record<HoldBlock, { title: string; sub: string }> = {
  no_permission: {
    title: "Chưa có quyền mở từ xa",
    sub: "Vẫn dùng mã tạm, lịch sử nếu được cấp. Chủ công ty bật ở Phân quyền.",
  },
  read_only: {
    title: "Chưa thao tác được trên máy",
    sub: "Hệ thống đang ở chế độ chỉ đọc. Vẫn xem được lịch sử ra vào.",
  },
  offline: {
    title: "Cửa đang mất kết nối",
    sub: "Máy cửa đang mất Wi-Fi. Lệnh từ xa và mã tạm chưa tới được máy.",
  },
};

export const LOG_PENDING_MOBILE = "Nhật ký thao tác chưa chốt được — kiểm lại ở Quản lý › Nhật ký.";

export function dialView(state: HoldState, block: HoldBlock | null, context: DialContext, reducedMotion = false): DialView {
  const off = (title: string, sub: string, needsAck = false): DialView => ({
    tone: "off",
    title,
    sub,
    ring: 0,
    litRidges: 0,
    interactive: false,
    needsAck,
  });
  // Kết quả đang chờ người dùng đọc thắng lý do khoá (vd vừa mở xong thì máy báo mất kết nối).
  if (state.phase === "rate_limited") return off(UNLOCK_RATE_LIMITED_TITLE, state.message ?? UNLOCK_RATE_LIMITED, true);
  if (block && state.phase !== "unknown" && state.phase !== "opened" && state.phase !== "sending") {
    return off(BLOCK_TEXT[block].title, BLOCK_TEXT[block].sub);
  }
  const withLog = (sub: string) => (state.logPending ? `${sub} ${LOG_PENDING_MOBILE}` : sub);
  switch (state.phase) {
    case "idle":
      return { tone: "ready", title: "Giữ để mở cửa", sub: "Giữ khoảng 1 giây. Buông tay sớm là huỷ.", ring: 0, litRidges: 0, interactive: true, needsAck: false };
    case "hint":
      return {
        tone: "ready",
        title: "Giữ lâu hơn một chút",
        sub: "Bạn buông tay sớm nên cửa chưa mở. Giữ khoảng 1 giây.",
        ring: 0,
        litRidges: 0,
        interactive: true,
        needsAck: false,
      };
    case "holding": {
      const lit = ridgesLit(state.progress);
      return {
        tone: "holding",
        title: "Giữ thêm chút nữa…",
        sub: "Buông tay bây giờ là huỷ.",
        ring: reducedMotion ? lit / RIDGE_COUNT : state.progress,
        litRidges: lit,
        interactive: true,
        needsAck: false,
      };
    }
    case "sending":
      return { tone: "sending", title: "Đang gửi lệnh tới cửa…", sub: context.doorLabel, ring: 0, litRidges: RIDGE_COUNT, interactive: false, needsAck: false };
    case "opened":
      return {
        tone: "opened",
        title: "Cửa đã mở",
        sub: withLog(context.openedAtText ? `Đã ghi vào nhật ký lúc ${context.openedAtText}.` : "Đã ghi vào nhật ký."),
        ring: 1,
        litRidges: RIDGE_COUNT,
        interactive: false,
        needsAck: false,
      };
    case "failed":
      return {
        tone: "failed",
        title: "Chưa mở được cửa",
        sub: withLog(`${state.message ?? "Máy cửa từ chối lệnh."} Giữ lại để thử.`),
        ring: 1,
        litRidges: RIDGE_COUNT,
        interactive: true,
        needsAck: false,
      };
    case "unknown":
      return {
        tone: "unknown",
        title: "Chưa rõ cửa đã mở chưa",
        sub: withLog(state.message ?? UNLOCK_UNKNOWN),
        ring: 1,
        litRidges: RIDGE_COUNT,
        interactive: false,
        needsAck: true,
      };
  }
  return off("Giữ để mở cửa", "");
}
