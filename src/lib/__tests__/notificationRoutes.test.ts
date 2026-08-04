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
