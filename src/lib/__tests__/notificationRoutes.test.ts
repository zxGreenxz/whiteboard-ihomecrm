// Allow-list URL thông báo là CỔNG DUY NHẤT giữa `notifications.metadata.url`
// (JSONB do trigger ghi) và `navigate()`. Hai kiểu hỏng đều IM LẶNG:
//   - quên khai route  → `resolveNotificationUrl` trả null → bấm thông báo
//     không đi đâu, không lỗi, không log.
//   - khai lỏng tay    → mở đường ra ngoài app.
// Nên phải có test, đặc biệt cho E6c: biên bản chốt sổ là route DUY NHẤT dùng
// khoá BIGINT, matcher gốc chỉ nhận UUID.

import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_FALLBACK_URL,
  notificationRawUrl,
  resolveNotificationUrl,
} from "@/lib/notificationRoutes";

/** Quyền: mọi module đều xem được. `canUse` đọc bản đồ dạng `{key: {view: true}}`. */
const ALL: any = new Proxy({}, { get: () => ({ view: true }) });
/** Không có quyền nào. */
const NONE: any = {};

const BOOK = "f21f1cb7-e9af-4b2d-99d4-e24f2a605889";
const REQ = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

describe("resolveNotificationUrl — PA4 (E6a/E6b/E6c)", () => {
  it("E6a: ?close=<uuid> đi qua và giữ param", () => {
    expect(resolveNotificationUrl(`/finance/cashbooks?close=${BOOK}`, ALL)).toBe(
      `/finance/cashbooks?close=${BOOK}`,
    );
  });

  it("E6b: ?confirm=<uuid> đi qua và giữ param", () => {
    expect(resolveNotificationUrl(`/finance/cashbooks?confirm=${REQ}`, ALL)).toBe(
      `/finance/cashbooks?confirm=${REQ}`,
    );
  });

  it("param rác bị bỏ nhưng vẫn tới được trang", () => {
    expect(resolveNotificationUrl("/finance/cashbooks?close=not-a-uuid", ALL)).toBe(
      "/finance/cashbooks",
    );
  });

  it("E6c: biên bản dùng khoá BIGINT, không phải uuid", () => {
    expect(resolveNotificationUrl("/finance/cashbooks/closure/35", ALL)).toBe(
      "/finance/cashbooks/closure/35",
    );
  });

  it("E6c: chặn khoá số vô nghĩa và chuỗi lạ", () => {
    for (const bad of ["0", "-1", "1.5", "abc", "1e3", "0123456789012345"]) {
      expect(resolveNotificationUrl(`/finance/cashbooks/closure/${bad}`, ALL)).toBeNull();
    }
  });

  it("E6c: chặn đi sâu hơn một đoạn", () => {
    expect(resolveNotificationUrl("/finance/cashbooks/closure/35/edit", ALL)).toBeNull();
  });

  it("thiếu quyền cashbooks → về đích dự phòng, không phải null", () => {
    expect(resolveNotificationUrl(`/finance/cashbooks?close=${BOOK}`, NONE)).toBe(
      NOTIFICATION_FALLBACK_URL,
    );
    expect(resolveNotificationUrl("/finance/cashbooks/closure/35", NONE)).toBe(
      NOTIFICATION_FALLBACK_URL,
    );
  });

  it("không nhận đường ra ngoài app dù mang tiền tố đúng", () => {
    for (const bad of [
      "//evil.tld/finance/cashbooks",
      "https://evil.tld/finance/cashbooks",
      "javascript:alert(1)",
      "/finance/cashbooks\\@evil.tld",
      "finance/cashbooks",
    ]) {
      expect(resolveNotificationUrl(bad, ALL)).toBeNull();
    }
  });

  it("route cũ (E1/E5) không bị hồi quy", () => {
    expect(
      resolveNotificationUrl(
        "/income-expense?approval_status=UNAPPROVED&layer=PENDING",
        ALL,
      ),
    ).toBe("/income-expense?approval_status=UNAPPROVED&layer=PENDING");
    expect(resolveNotificationUrl(`/thu-tien?handover=${REQ}`, ALL)).toBe(
      `/thu-tien?handover=${REQ}`,
    );
  });
});

describe("resolveNotificationUrl — cảnh báo Zalo mất kết nối", () => {
  it("/chat-zalo đi qua, bỏ param lạ; thiếu quyền chat_zalo thì về đích dự phòng", () => {
    expect(resolveNotificationUrl("/chat-zalo", ALL)).toBe("/chat-zalo");
    expect(resolveNotificationUrl("/chat-zalo?x=1", ALL)).toBe("/chat-zalo");
    expect(resolveNotificationUrl("/chat-zalo", NONE)).toBe(NOTIFICATION_FALLBACK_URL);
    expect(resolveNotificationUrl(`/chat-zalo/${REQ}`, ALL)).toBeNull();
  });
});

describe("notificationRawUrl — loại nơi phát không gắn metadata.url", () => {
  it("đơn xin nghỉ (v5 leave_request, không url) mở /my-day — nơi super admin duyệt ngay", () => {
    const raw = notificationRawUrl({ v5: "leave_request", staff_id: REQ, date: "2026-11-18" });
    expect(raw).toBe("/my-day");
    expect(resolveNotificationUrl(raw, NONE)).toBe("/my-day");
  });

  it("metadata.url do nơi phát gắn luôn thắng nhãn v5, kể cả url bị allow-list loại", () => {
    expect(notificationRawUrl({ v5: "leave_request", url: "/finance/salary" })).toBe("/finance/salary");
    const evil = notificationRawUrl({ v5: "leave_request", url: "//evil.tld" });
    expect(evil).toBe("//evil.tld");
    expect(resolveNotificationUrl(evil, ALL)).toBeNull();
  });

  it("loại khác không url vẫn không đi đâu như cũ; metadata rác không vỡ", () => {
    expect(notificationRawUrl({ v5: "device_issue", session_id: REQ })).toBeUndefined();
    expect(notificationRawUrl({})).toBeUndefined();
    expect(notificationRawUrl(null)).toBeUndefined();
    expect(notificationRawUrl("leave_request")).toBeUndefined();
    expect(notificationRawUrl({ v5: "leave_request", url: "" })).toBe("/my-day");
  });
});
