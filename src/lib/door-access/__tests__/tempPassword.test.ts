import { describe, expect, it } from "vitest";

import {
  deliveryHint,
  logDetailText,
  logStatus,
} from "../format";
import {
  defaultTempPasswordValues,
  indexTempPasswordLogs,
  tempPasswordFormSchema,
  tempPasswordNameProblem,
} from "../tempPassword";
import { log } from "./fixtures";

// 14:05 ngày 21/10/2026 giờ Việt Nam = 07:05 UTC.
const NOW = Date.UTC(2026, 9, 21, 7, 5, 30);

describe("Form tạo mật khẩu tạm (zod)", () => {
  const schema = tempPasswordFormSchema(() => NOW);

  it("mặc định 2 giờ, mục đích Xem phòng", () => {
    expect(defaultTempPasswordValues(NOW)).toMatchObject({ preset: "2h", purpose: "XEM_PHONG", name: "" });
  });

  it("tên bắt buộc, tối đa 20 ký tự (đếm ký tự có dấu là 1), không ký tự điều khiển", () => {
    expect(tempPasswordNameProblem("  ")).toBe("Nhập tên mật khẩu.");
    expect(tempPasswordNameProblem("Xem phòng P302")).toBeNull();
    expect(tempPasswordNameProblem("Ẩ".repeat(20))).toBeNull();
    expect(tempPasswordNameProblem("Ẩ".repeat(21))).toBe("Tên tối đa 20 ký tự.");
    expect(tempPasswordNameProblem("Thợ\u0007")).toBe("Tên có ký tự không hợp lệ.");
  });

  it("lỗi gắn đúng ô", () => {
    const result = schema.safeParse({ name: "", purpose: "THO", preset: "custom", from: "2026-10-21T15:00", to: "2026-11-01T15:00" });
    expect(result.success).toBe(false);
    const paths = result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));
    expect(paths).toEqual(["name", "to"]);
  });

  it("mục đích ngoài danh sách ⇒ lỗi", () => {
    expect(schema.safeParse({ name: "Thợ điện", purpose: "KHONG_RO", preset: "2h", from: "", to: "" }).success).toBe(false);
  });

  it("hợp lệ", () => {
    expect(schema.safeParse({ name: "Thợ điện", purpose: "THO", preset: "1h", from: "", to: "" }).success).toBe(true);
  });
});

describe("Nhật ký", () => {
  it("ai tạo mật khẩu nào: theo tuya_password_id, bản mới nhất", () => {
    const index = indexTempPasswordLogs([
      log({ actor_name: "Mới" }),
      log({ id: "00000000-0000-4000-8000-0000000002a9", actor_name: "Cũ" }),
      log({ id: "00000000-0000-4000-8000-0000000002aa", action: "REMOTE_UNLOCK", tuya_password_id: "9" }),
    ]);
    expect(index.get("3001")?.actor_name).toBe("Mới");
    expect(index.has("9")).toBe(false);
  });

  it("PENDING quá 2 phút ⇒ chưa rõ kết quả", () => {
    const created = "2026-10-21T07:00:00+00:00";
    expect(logStatus({ status: "PENDING", created_at: created }, Date.UTC(2026, 9, 21, 7, 1))).toEqual({ label: "Đang chạy", tone: "pending" });
    expect(logStatus({ status: "PENDING", created_at: created }, Date.UTC(2026, 9, 21, 7, 3))).toEqual({ label: "Chưa rõ kết quả", tone: "unknown" });
    expect(logStatus({ status: "UNKNOWN", created_at: created }, Date.UTC(2026, 9, 21, 7, 1)).label).toBe("Chưa rõ kết quả");
  });

  it("tóm tắt detail không bao giờ lộ mật khẩu, trường lạ bỏ qua", () => {
    expect(logDetailText(log())).toContain("“Xem phòng P302”");
    expect(logDetailText(log({ action: "KEY_DELETE", detail: { unlock_type: "fingerprint", unlock_sn: 12, tuya_user_id: "u1", user_type: 1 } }))).toBe("Vân tay #12");
    expect(logDetailText(log({ action: "DEVICE_SAVE", detail: {} }))).toBeNull();
    expect(logDetailText(log({ detail: { password: "1234567" } }))).toBeNull();
  });

  it("trạng thái gửi xuống máy: trung tính khi chưa rõ mã", () => {
    expect(deliveryHint(null)).toBeNull();
    expect(deliveryHint(1)).toBe("Đang gửi xuống máy");
    expect(deliveryHint(7)).toBe("Trạng thái gửi: 7");
  });
});
