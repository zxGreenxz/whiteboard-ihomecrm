import { describe, expect, it } from "vitest";
import {
  addDaysIso, buildCameraAlertPatch, CAMERA_ALERT_TYPE_INFO, cameraAlertFailure, cameraAlertFormSchema, cameraAlertFormValues,
  cameraChannelMuteSchema, deliveryOptionsFor, deliveryStatusView, isPlainSentence, snoozeUntilIso, startsLiveSending, testResultText,
} from "@/lib/network-center/cameraAlertForm";
import { CAMERA_ALERT_TYPE_CODES, type CameraAlertSettings } from "@/lib/network-center/cameraContracts";
import { DEMO_CAMERA_ALERT_TYPES } from "@/lib/network-center/cameraDemo";
import { NetworkCenterRepositoryError } from "@/lib/network-center/supabaseRepository";

const settings: CameraAlertSettings = {
  enabled: true, mode: "SHADOW", zaloAccountId: null, zaloConversationId: null,
  types: structuredClone(DEMO_CAMERA_ALERT_TYPES), nightStart: "22:00", nightEnd: "07:00", digestAt: "08:00",
  dailyZaloCap: 6, pushEnabled: false, liveSince: null, updatedBy: null, updatedAt: null, version: 2,
};

describe("form cài đặt cảnh báo camera", () => {
  it("đổi giây ⇄ phút ở lớp form; chập chờn giữ số lần", () => {
    const values = cameraAlertFormValues(settings, DEMO_CAMERA_ALERT_TYPES);
    expect(values.types.CAMERA_CHANNEL_LOST.threshold).toBe(15);
    expect(values.types.CAMERA_RECORDER_UNKNOWN.threshold).toBe(30);
    expect(values.types.CAMERA_STORAGE_ERROR.threshold).toBe(0);
    expect(values.types.CAMERA_CHANNEL_FLAPPING.threshold).toBe(5);
    expect(buildCameraAlertPatch(settings, values, DEMO_CAMERA_ALERT_TYPES)).toEqual({});
  });

  it("patch chỉ gồm khoá đổi; ngưỡng phút ra giây, chập chờn ra threshold_count", () => {
    const values = cameraAlertFormValues(settings, DEMO_CAMERA_ALERT_TYPES);
    values.types.CAMERA_CHANNEL_LOST.threshold = 1.5;
    values.types.CAMERA_CHANNEL_FLAPPING.threshold = 8;
    values.types.CAMERA_RECORDER_OFFLINE.enabled = false;
    values.digestAt = "08:30";
    expect(buildCameraAlertPatch(settings, values, DEMO_CAMERA_ALERT_TYPES)).toEqual({
      digestAt: "08:30",
      types: {
        CAMERA_CHANNEL_LOST: { threshold_seconds: 90 },
        CAMERA_CHANNEL_FLAPPING: { threshold_count: 8 },
        CAMERA_RECORDER_OFFLINE: { enabled: false },
      },
    });
  });

  it("cận giống máy chủ: ổ lỗi 0 hoặc 1–1440 phút, loại khác 1–1440, chập chờn 2–200, trần 1–20", () => {
    const base = cameraAlertFormValues(settings, DEMO_CAMERA_ALERT_TYPES);
    const issues = (mutate: (values: typeof base) => void) => {
      const values = structuredClone(base);
      mutate(values);
      const result = cameraAlertFormSchema.safeParse(values);
      return result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));
    };
    expect(issues(() => {})).toEqual([]);
    expect(issues((v) => { v.types.CAMERA_STORAGE_ERROR.threshold = 0.5; })).toEqual(["types.CAMERA_STORAGE_ERROR.threshold"]);
    expect(issues((v) => { v.types.CAMERA_RECORDER_OFFLINE.threshold = 0; })).toEqual(["types.CAMERA_RECORDER_OFFLINE.threshold"]);
    expect(issues((v) => { v.types.CAMERA_RECORDER_OFFLINE.threshold = 1441; })).toEqual(["types.CAMERA_RECORDER_OFFLINE.threshold"]);
    expect(issues((v) => { v.types.CAMERA_RECORDER_OFFLINE.threshold = 1.001; })).toEqual(["types.CAMERA_RECORDER_OFFLINE.threshold"]);
    expect(issues((v) => { v.types.CAMERA_RECORDER_OFFLINE.threshold = Number.NaN; })).toEqual(["types.CAMERA_RECORDER_OFFLINE.threshold"]);
    expect(issues((v) => { v.types.CAMERA_CHANNEL_FLAPPING.threshold = 201; })).toEqual(["types.CAMERA_CHANNEL_FLAPPING.threshold"]);
    expect(issues((v) => { v.types.CAMERA_CHANNEL_FLAPPING.delivery = "ZALO"; })).toEqual(["types.CAMERA_CHANNEL_FLAPPING.delivery"]);
    expect(issues((v) => { v.dailyZaloCap = 0; })).toEqual(["dailyZaloCap"]);
    expect(issues((v) => { v.nightEnd = "22:00"; })).toEqual(["nightEnd"]);
    expect(issues((v) => { v.mode = "LIVE"; })).toEqual(["zaloConversationId"]);
    expect(issues((v) => { v.mode = "LIVE"; v.enabled = false; })).toEqual([]);
  });

  it("chỉ hỏi xác nhận khi lần lưu này BẬT gửi thật", () => {
    expect(startsLiveSending(settings, { enabled: true, mode: "LIVE" })).toBe(true);
    expect(startsLiveSending({ enabled: false, mode: "LIVE" }, { enabled: true, mode: "LIVE" })).toBe(true);
    expect(startsLiveSending({ enabled: true, mode: "LIVE" }, { enabled: true, mode: "LIVE" })).toBe(false);
    expect(startsLiveSending(settings, { enabled: false, mode: "LIVE" })).toBe(false);
  });

  it("đủ nhãn cho mọi loại; chập chờn chỉ bản tin hoặc tắt", () => {
    for (const code of CAMERA_ALERT_TYPE_CODES) expect(CAMERA_ALERT_TYPE_INFO[code].label).not.toMatch(/CAMERA_/);
    expect(deliveryOptionsFor("CAMERA_CHANNEL_FLAPPING")).toEqual(["DIGEST", "OFF"]);
    expect(deliveryOptionsFor("CAMERA_CHANNEL_LOST")).toEqual(["ZALO", "DIGEST", "BELL", "OFF"]);
  });
});

describe("nhãn nhật ký gửi và lỗi", () => {
  it("trạng thái và lý do bằng tiếng Việt, mã lạ không hiện", () => {
    expect(deliveryStatusView({ status: "SHADOW", reason: "WOULD_NOTIFY", recipients: 2, channel: "IN_APP" }))
      .toEqual({ label: "Chạy thử", tone: "info", detail: "Lẽ ra báo chuông CRM cho 2 người." });
    expect(deliveryStatusView({ status: "SUPPRESSED", reason: "REPEAT_24H", recipients: null, channel: "ZALO" }).label).toBe("Bỏ qua vì trùng 24 giờ");
    expect(deliveryStatusView({ status: "SUPPRESSED", reason: "DAILY_CAP", recipients: null, channel: "ZALO" }).label).toBe("Bỏ qua vì chạm trần ngày");
    expect(deliveryStatusView({ status: "DEFERRED", reason: "NIGHT", recipients: null, channel: "ZALO" }).detail).toMatch(/ban đêm/);
    expect(deliveryStatusView({ status: "FAILED", reason: "Nick Zalo chưa kết nối", recipients: null, channel: "ZALO" }).detail).toBe("Nick Zalo chưa kết nối");
    expect(deliveryStatusView({ status: "FAILED", reason: "PROVIDER_TIMEOUT", recipients: null, channel: "ZALO" }).detail).toBe("Máy gửi Zalo báo lỗi.");
    expect(deliveryStatusView({ status: "QUEUED", reason: null, recipients: null, channel: "ZALO" }).label).toBe("Đã xếp hàng");
  });

  it("chỉ giữ câu viết cho người dùng", () => {
    expect(isPlainSentence("Chọn nhóm Zalo nhận cảnh báo trước khi chuyển sang gửi thật")).toBe(true);
    expect(isPlainSentence("Giá trị cài đặt không hợp lệ: types.CAMERA_CHANNEL_LOST.threshold_seconds")).toBe(false);
    expect(isPlainSentence("Giá trị cài đặt không hợp lệ: enabled")).toBe(false);
    expect(isPlainSentence("WOULD_QUEUE")).toBe(false);
    expect(isPlainSentence("zaloConversationId missing")).toBe(false);
  });

  it("tách xung đột, quyền, dữ liệu nhập; không có mã trong câu", () => {
    const fail = (code: string, message = "x") => cameraAlertFailure(new NetworkCenterRepositoryError(message, { code }), "lưu");
    expect(fail("PT409")).toMatchObject({ kind: "conflict", text: expect.stringContaining("Có người vừa sửa") });
    expect(fail("42501")).toEqual({ kind: "permission", text: "Chỉ chủ công ty hoặc superadmin sửa được." });
    expect(fail("22023", "Giá trị cài đặt không hợp lệ: dailyZaloCap").text).toBe("Giá trị chưa hợp lệ. Kiểm tra lại các ô đã nhập.");
    expect(fail("22023", "Tạm ẩn cần ngày kết thúc trong 90 ngày tới").text).toBe("Tạm ẩn cần ngày kết thúc trong 90 ngày tới");
    expect(fail("PGRST202").kind).toBe("unavailable");
    expect(fail("PGRST301")).toEqual({ kind: "session", text: "Phiên đăng nhập đã hết hạn. Đăng nhập lại để tiếp tục." });
    expect(cameraAlertFailure(new NetworkCenterRepositoryError("x", { code: "42501" }), "xem", "Bạn không có quyền xem nhật ký gửi của công ty này.").text)
      .toBe("Bạn không có quyền xem nhật ký gửi của công ty này.");
    // Sai hợp đồng dữ liệu không phải lỗi mạng.
    expect(fail("CAMERA_ALERT_INVALID_DATA", "Dữ liệu cảnh báo camera chưa hợp lệ.")).toMatchObject({ kind: "data", text: expect.not.stringMatching(/mạng/) });
    expect(cameraAlertFailure(new TypeError("Failed to fetch"), "lưu").text).toBe("Chưa lưu được. Kiểm tra mạng rồi thử lại.");
    for (const code of ["PT409", "42501", "22023", "P0002", "PGRST202", "XX000"]) expect(fail(code).text).not.toMatch(/PT409|42501|22023|P0002|PGRST|CAMERA_/);
  });

  it("kết quả tin thử bằng lời", () => {
    expect(testResultText({ deliveryId: "d1000000-0000-4000-8000-000000000001", status: "FAILED", reason: "Nick Zalo chưa kết nối" }).text)
      .toBe("Không gửi được tin thử: Nick Zalo chưa kết nối");
    expect(testResultText({ deliveryId: "d1000000-0000-4000-8000-000000000001", status: "SUPPRESSED", reason: "DAILY_CAP" }).text).toMatch(/chạm trần/);
  });
});

describe("tạm ẩn kênh", () => {
  it("hết ngày đã chọn theo giờ Việt Nam; chỉ nhận từ hôm nay tới 89 ngày sau", () => {
    expect(snoozeUntilIso("2026-12-01")).toBe("2026-12-01T16:59:59.000Z");
    expect(addDaysIso("2026-12-30", 3)).toBe("2027-01-02");
    const schema = cameraChannelMuteSchema("2026-11-25");
    expect(schema.safeParse({ kind: "SNOOZE", untilDay: "2026-11-25", note: "" }).success).toBe(true);
    expect(schema.safeParse({ kind: "SNOOZE", untilDay: "2027-02-22", note: "" }).success).toBe(true);
    expect(schema.safeParse({ kind: "SNOOZE", untilDay: "2027-02-23", note: "" }).success).toBe(false);
    expect(schema.safeParse({ kind: "SNOOZE", untilDay: "2026-11-24", note: "" }).success).toBe(false);
    expect(schema.safeParse({ kind: "SNOOZE", untilDay: "", note: "" }).success).toBe(false);
    expect(schema.safeParse({ kind: "IGNORE", untilDay: "", note: "x".repeat(500) }).success).toBe(true);
    expect(schema.safeParse({ kind: "IGNORE", untilDay: "", note: "x".repeat(501) }).success).toBe(false);
  });
});
