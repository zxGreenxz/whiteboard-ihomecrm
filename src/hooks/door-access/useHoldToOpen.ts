import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import {
  HOLD_TO_OPEN_MS,
  INITIAL_HOLD_STATE,
  OPENED_RESET_MS,
  firedBy,
  holdReducer,
  type HoldEvent,
  type HoldOutcome,
  type HoldState,
} from "@/lib/door-access/holdToOpen";

/**
 * Gắn bộ chuyển trạng thái giữ-để-mở (src/lib/door-access/holdToOpen.ts) vào con trỏ, bàn phím và
 * đồng hồ khung hình.
 *
 * - Chạm/nhấn chuột: giữ con trỏ (pointer capture) để trượt ngón ra ngoài vòng vẫn tính là đang giữ;
 *   nhấc/huỷ con trỏ là buông.
 * - Bàn phím: giữ Space hoặc Enter; phím lặp (giữ lâu) không bắt đầu lại.
 * - Rời tab / mất tiêu điểm khi đang giữ ⇒ huỷ (không mở).
 * - `onFire` chạy ĐÚNG MỘT lần mỗi lần giữ đủ, trong chính lượt chuyển "holding" ⇒ "sending"; kết quả
 *   báo lại qua `report(outcome)`. Không có đường nào tự gọi lại `onFire`.
 */
export interface UseHoldToOpen {
  state: HoldState;
  report: (outcome: HoldOutcome) => void;
  reset: () => void;
  /**
   * Gửi lệnh như một lần giữ đủ — CHỈ dùng sau một bước xác nhận riêng (đường cho trình đọc màn hình, nơi
   * "chạm hai lần" là một cú click, không giữ được). Nút khoá hoặc chưa được giữ lại thì không làm gì.
   */
  trigger: () => void;
  handlers: {
    onPointerDown: (event: PointerEvent<HTMLElement>) => void;
    onPointerUp: (event: PointerEvent<HTMLElement>) => void;
    onPointerCancel: (event: PointerEvent<HTMLElement>) => void;
    onPointerLeave: (event: PointerEvent<HTMLElement>) => void;
    onLostPointerCapture: (event: PointerEvent<HTMLElement>) => void;
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
    onKeyUp: (event: KeyboardEvent<HTMLElement>) => void;
    onBlur: () => void;
    onContextMenu: (event: { preventDefault: () => void }) => void;
  };
}

const HOLD_KEYS = new Set([" ", "Enter"]);

export function useHoldToOpen({
  blocked,
  onFire,
  now = () => performance.now(),
}: {
  /** Nút khoá (thiếu quyền, chỉ đọc, mất kết nối): không bắt đầu giữ được. */
  blocked: boolean;
  /** Gửi lệnh mở; báo kết quả bằng `report` (một lần). */
  onFire: (report: (outcome: HoldOutcome) => void) => void;
  /** Đồng hồ — test truyền đồng hồ giả. */
  now?: () => number;
}): UseHoldToOpen {
  const [state, setState] = useState<HoldState>(INITIAL_HOLD_STATE);
  // Bản sao đồng bộ để hai sự kiện liền nhau (tick + release) không đọc trạng thái cũ.
  const ref = useRef<HoldState>(INITIAL_HOLD_STATE);
  const frame = useRef<number | null>(null);
  const fireRef = useRef(onFire);
  fireRef.current = onFire;
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const nowRef = useRef(now);
  nowRef.current = now;

  const stopFrame = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);

  const dispatch = useCallback(
    (event: HoldEvent) => {
      const before = ref.current;
      const after = holdReducer(before, event, blockedRef.current);
      if (after === before) return;
      ref.current = after;
      setState(after);
      if (after.phase !== "holding") stopFrame();
      if (firedBy(before, after)) fireRef.current((outcome) => dispatchRef.current({ type: "result", outcome }));
    },
    [stopFrame],
  );
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  const tick = useCallback(() => {
    frame.current = null;
    dispatch({ type: "tick", at: nowRef.current() });
    if (ref.current.phase === "holding") frame.current = requestAnimationFrame(tick);
  }, [dispatch]);

  const press = useCallback(() => {
    const before = ref.current;
    dispatch({ type: "press", at: nowRef.current() });
    if (before.phase !== "holding" && ref.current.phase === "holding" && frame.current === null) {
      frame.current = requestAnimationFrame(tick);
    }
  }, [dispatch, tick]);

  const release = useCallback(() => dispatch({ type: "release", at: nowRef.current() }), [dispatch]);
  const cancel = useCallback(() => dispatch({ type: "cancel" }), [dispatch]);

  const report = useCallback((outcome: HoldOutcome) => dispatch({ type: "result", outcome }), [dispatch]);
  const trigger = useCallback(() => {
    const at = nowRef.current();
    dispatch({ type: "press", at });
    dispatch({ type: "release", at: at + HOLD_TO_OPEN_MS });
  }, [dispatch]);
  const reset = useCallback(() => dispatch({ type: "reset" }), [dispatch]);

  // "Cửa đã mở" tự về sẵn sàng sau 5 giây.
  useEffect(() => {
    if (state.phase !== "opened") return;
    const timer = window.setTimeout(() => dispatch({ type: "reset" }), OPENED_RESET_MS);
    return () => window.clearTimeout(timer);
  }, [state.phase, dispatch]);

  // Rời tab giữa chừng ⇒ huỷ lần giữ (không để vòng tự chạy đủ khi người dùng không nhìn).
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === "hidden") cancel();
    };
    document.addEventListener("visibilitychange", onHidden);
    return () => document.removeEventListener("visibilitychange", onHidden);
  }, [cancel]);

  // Đang giữ mà nút bị khoá (vd quyền vừa đổi) ⇒ huỷ.
  useEffect(() => {
    if (blocked) cancel();
  }, [blocked, cancel]);

  useEffect(() => stopFrame, [stopFrame]);

  return {
    state,
    report,
    reset,
    trigger,
    handlers: {
      onPointerDown: (event) => {
        // Chỉ nút chính (chạm, chuột trái, bút): chuột phải/giữa không mở cửa.
        if (event.button !== 0) return;
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          /* Trình duyệt không cho giữ con trỏ: vẫn chạy, chỉ là trượt ra ngoài thì mất. */
        }
        press();
      },
      onPointerUp: () => release(),
      onPointerCancel: () => cancel(),
      // Không giữ được con trỏ (trình duyệt từ chối) mà ngón trượt ra ngoài vòng: huỷ, không để vòng tự chạy
      // đủ rồi mở cửa. Khi giữ được con trỏ, hai sự kiện này chỉ đến SAU lúc nhấc tay ⇒ không còn "đang giữ".
      onPointerLeave: () => cancel(),
      onLostPointerCapture: () => cancel(),
      onKeyDown: (event) => {
        if (!HOLD_KEYS.has(event.key)) return;
        event.preventDefault();
        if (!event.repeat) press();
      },
      onKeyUp: (event) => {
        if (!HOLD_KEYS.has(event.key)) return;
        event.preventDefault();
        release();
      },
      onBlur: () => cancel(),
      onContextMenu: (event) => event.preventDefault(),
    },
  };
}
