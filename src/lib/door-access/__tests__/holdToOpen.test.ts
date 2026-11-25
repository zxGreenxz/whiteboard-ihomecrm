import { describe, expect, it } from "vitest";

import {
  HOLD_TO_OPEN_MS,
  INITIAL_HOLD_STATE,
  RIDGE_COUNT,
  UNLOCK_RATE_LIMITED,
  UNLOCK_UNCONFIRMED,
  UNLOCK_UNKNOWN,
  canStartHold,
  dialView,
  firedBy,
  holdBlock,
  holdReducer,
  ridgesLit,
  unlockErrorOutcome,
  unlockSuccessOutcome,
  type HoldEvent,
  type HoldState,
} from "../holdToOpen";

/** Chạy một chuỗi sự kiện, đếm số lần chuyển sang gửi lệnh. */
function run(events: HoldEvent[], blocked = false, from: HoldState = INITIAL_HOLD_STATE) {
  let state = from;
  let fired = 0;
  for (const event of events) {
    const next = holdReducer(state, event, blocked);
    if (firedBy(state, next)) fired += 1;
    state = next;
  }
  return { state, fired };
}

const ctx = { doorLabel: "Cổng chính · Tòa A", openedAtText: "14:05" };

describe("giữ để mở — bộ chuyển trạng thái", () => {
  it("giữ đủ 1 giây ⇒ gửi lệnh đúng một lần, kể cả khi nhịp vẽ còn chạy tiếp", () => {
    const { state, fired } = run([
      { type: "press", at: 0 },
      { type: "tick", at: 400 },
      { type: "tick", at: HOLD_TO_OPEN_MS },
      { type: "tick", at: HOLD_TO_OPEN_MS + 16 },
      { type: "release", at: HOLD_TO_OPEN_MS + 30 },
    ]);
    expect(state.phase).toBe("sending");
    expect(fired).toBe(1);
  });

  it("buông sớm là huỷ: không gửi lệnh, nhắc giữ lâu hơn", () => {
    const { state, fired } = run([
      { type: "press", at: 0 },
      { type: "tick", at: 500 },
      { type: "release", at: HOLD_TO_OPEN_MS - 1 },
    ]);
    expect(state.phase).toBe("hint");
    expect(state.progress).toBe(0);
    expect(fired).toBe(0);
  });

  it("buông đúng lúc đủ giờ mà chưa có nhịp vẽ ⇒ vẫn tính là giữ đủ", () => {
    const { state, fired } = run([
      { type: "press", at: 0 },
      { type: "release", at: HOLD_TO_OPEN_MS },
    ]);
    expect(state.phase).toBe("sending");
    expect(fired).toBe(1);
  });

  it("đang gửi lệnh: nhấn thêm, buông, huỷ, đặt lại đều không đổi gì", () => {
    const sending = run([{ type: "press", at: 0 }, { type: "tick", at: HOLD_TO_OPEN_MS }]).state;
    const { state, fired } = run(
      [{ type: "press", at: 2000 }, { type: "tick", at: 4000 }, { type: "release", at: 4100 }, { type: "cancel" }, { type: "reset" }],
      false,
      sending,
    );
    expect(state).toBe(sending);
    expect(fired).toBe(0);
  });

  it("nút khoá (thiếu quyền, chỉ đọc, mất kết nối) ⇒ nhấn không bắt đầu giữ", () => {
    const { state, fired } = run([{ type: "press", at: 0 }, { type: "tick", at: HOLD_TO_OPEN_MS }], true);
    expect(state.phase).toBe("idle");
    expect(fired).toBe(0);
  });

  it("mất tiêu điểm / rời tab khi đang giữ ⇒ về sẵn sàng, không gửi", () => {
    const { state, fired } = run([{ type: "press", at: 0 }, { type: "tick", at: 900 }, { type: "cancel" }, { type: "tick", at: 1500 }]);
    expect(state.phase).toBe("idle");
    expect(fired).toBe(0);
  });

  it("chưa rõ kết quả: KHÔNG giữ lại được cho tới khi bấm Đã hiểu", () => {
    const sending = run([{ type: "press", at: 0 }, { type: "tick", at: HOLD_TO_OPEN_MS }]).state;
    const unknown = holdReducer(sending, { type: "result", outcome: { kind: "unknown", message: UNLOCK_UNKNOWN, logPending: false } });
    expect(unknown.phase).toBe("unknown");
    expect(canStartHold(unknown.phase)).toBe(false);

    const retry = run([{ type: "press", at: 5000 }, { type: "tick", at: 6500 }], false, unknown);
    expect(retry.state.phase).toBe("unknown");
    expect(retry.fired).toBe(0);

    const acked = holdReducer(unknown, { type: "reset" });
    expect(acked).toEqual(INITIAL_HOLD_STATE);
    expect(run([{ type: "press", at: 7000 }, { type: "tick", at: 8000 }], false, acked).fired).toBe(1);
  });

  it("chạm trần 10 lần/10 phút: chặn giữ cho tới khi bấm Đã hiểu", () => {
    const sending = run([{ type: "press", at: 0 }, { type: "tick", at: HOLD_TO_OPEN_MS }]).state;
    const limited = holdReducer(sending, { type: "result", outcome: { kind: "rate_limited", message: UNLOCK_RATE_LIMITED } });
    expect(limited.phase).toBe("rate_limited");
    expect(run([{ type: "press", at: 2000 }, { type: "tick", at: 3000 }], false, limited).fired).toBe(0);
  });

  it("không mở được ⇒ giữ lại được ngay (người dùng tự thử lại)", () => {
    const sending = run([{ type: "press", at: 0 }, { type: "tick", at: HOLD_TO_OPEN_MS }]).state;
    const failed = holdReducer(sending, { type: "result", outcome: { kind: "failed", message: "SmartLife từ chối (mã 2001).", logPending: false } });
    expect(failed.phase).toBe("failed");
    expect(run([{ type: "press", at: 3000 }, { type: "tick", at: 4000 }], false, failed).fired).toBe(1);
  });

  it("kết quả chỉ nhận khi đang gửi lệnh (kết quả muộn sau khi đổi cửa bị bỏ qua)", () => {
    const outcome = { kind: "opened", logPending: false } as const;
    expect(holdReducer(INITIAL_HOLD_STATE, { type: "result", outcome })).toBe(INITIAL_HOLD_STATE);
  });
});

describe("phân loại kết quả mở cửa", () => {
  it("unlocked:true ⇒ đã mở; unlocked:false ⇒ chưa rõ (không phải thất bại)", () => {
    expect(unlockSuccessOutcome({ unlocked: true })).toEqual({ kind: "opened", logPending: false });
    expect(unlockSuccessOutcome({ unlocked: false, logPending: true })).toEqual({ kind: "unknown", message: UNLOCK_UNCONFIRMED, logPending: true });
  });

  it("outcomeUnknown luôn là chưa rõ, kể cả khi kèm loại lỗi khác", () => {
    expect(unlockErrorOutcome({ kind: "unavailable", outcomeUnknown: true, message: "x" }, "fb").kind).toBe("unknown");
    expect(unlockErrorOutcome({ kind: "rate_limited", outcomeUnknown: true }, "fb").kind).toBe("unknown");
  });

  it("rate_limited ⇒ trạng thái Quá số lần; lỗi khác ⇒ không mở được kèm câu máy chủ", () => {
    expect(unlockErrorOutcome({ kind: "rate_limited", message: "Quá nhiều" }, "fb")).toEqual({ kind: "rate_limited", message: UNLOCK_RATE_LIMITED });
    expect(unlockErrorOutcome({ kind: "tuya_rejected", message: "SmartLife từ chối (mã 2001)." }, "fb")).toEqual({
      kind: "failed",
      message: "SmartLife từ chối (mã 2001).",
      logPending: false,
    });
    expect(unlockErrorOutcome(null, "Chưa mở được cửa.")).toEqual({ kind: "failed", message: "Chưa mở được cửa.", logPending: false });
  });
});

describe("lý do khoá nút", () => {
  it("thiếu quyền > chỉ đọc > mất kết nối; chưa biết trạng thái mạng thì không khoá", () => {
    expect(holdBlock({ canRemoteUnlock: false, writable: false, online: false })).toBe("no_permission");
    expect(holdBlock({ canRemoteUnlock: true, writable: false, online: false })).toBe("read_only");
    expect(holdBlock({ canRemoteUnlock: true, writable: true, online: false })).toBe("offline");
    expect(holdBlock({ canRemoteUnlock: true, writable: true, online: null })).toBeNull();
    expect(holdBlock({ canRemoteUnlock: true, writable: true, online: true })).toBeNull();
  });
});

describe("nút vân tay — chữ và vòng theo trạng thái", () => {
  it("đủ 10 trạng thái của artboard", () => {
    const at = (phase: HoldState["phase"], extra: Partial<HoldState> = {}): HoldState => ({ ...INITIAL_HOLD_STATE, phase, ...extra });
    const titles = [
      dialView(at("idle"), null, ctx).title,
      dialView(at("holding", { startedAt: 0, progress: 0.55 }), null, ctx).title,
      dialView(at("sending"), null, ctx).title,
      dialView(at("opened"), null, ctx).title,
      dialView(at("failed", { message: "Máy cửa từ chối lệnh." }), null, ctx).title,
      dialView(at("unknown", { message: UNLOCK_UNKNOWN }), null, ctx).title,
      dialView(at("idle"), "offline", ctx).title,
      dialView(at("idle"), "read_only", ctx).title,
      dialView(at("rate_limited", { message: UNLOCK_RATE_LIMITED }), null, ctx).title,
      dialView(at("idle"), "no_permission", ctx).title,
    ];
    expect(titles).toEqual([
      "Giữ để mở cửa",
      "Giữ thêm chút nữa…",
      "Đang gửi lệnh tới cửa…",
      "Cửa đã mở",
      "Chưa mở được cửa",
      "Chưa rõ cửa đã mở chưa",
      "Cửa đang mất kết nối",
      "Chưa thao tác được trên máy",
      "Đã gửi 10 lệnh mở trong 10 phút",
      "Chưa có quyền mở từ xa",
    ]);
  });

  it("chưa rõ kết quả: không nhận giữ, hiện Xem lịch sử + Đã hiểu", () => {
    const view = dialView({ ...INITIAL_HOLD_STATE, phase: "unknown", message: UNLOCK_UNKNOWN }, null, ctx);
    expect(view.interactive).toBe(false);
    expect(view.needsAck).toBe(true);
    expect(view.sub).toBe(UNLOCK_UNKNOWN);
  });

  it("kết quả đang hiện thắng lý do khoá mới đến (không nuốt câu Chưa rõ)", () => {
    const view = dialView({ ...INITIAL_HOLD_STATE, phase: "unknown", message: UNLOCK_UNKNOWN }, "offline", ctx);
    expect(view.title).toBe("Chưa rõ cửa đã mở chưa");
  });

  it("nhật ký chưa chốt được thì nói thêm", () => {
    const view = dialView({ ...INITIAL_HOLD_STATE, phase: "opened", logPending: true }, null, ctx);
    expect(view.sub).toContain("Nhật ký thao tác chưa chốt được");
  });

  it("vân sáng dần theo tiến độ; giảm chuyển động ⇒ vòng ngoài nhảy theo vân", () => {
    expect(ridgesLit(0)).toBe(0);
    expect(ridgesLit(1 / RIDGE_COUNT)).toBe(1);
    expect(ridgesLit(0.5)).toBe(4);
    expect(ridgesLit(1)).toBe(RIDGE_COUNT);
    const holding: HoldState = { ...INITIAL_HOLD_STATE, phase: "holding", startedAt: 0, progress: 0.5 };
    expect(dialView(holding, null, ctx, false).ring).toBe(0.5);
    expect(dialView(holding, null, ctx, true).ring).toBeCloseTo(4 / RIDGE_COUNT);
  });
});
