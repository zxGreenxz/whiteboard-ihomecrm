// Allow-list URL thông báo là CỔNG DUY NHẤT giữa `notifications.metadata.url`
// (JSONB do trigger ghi) và `navigate()`. Hai kiểu hỏng đều IM LẶNG:
//   - quên khai route  → `resolveNotificationUrl` trả null → bấm thông báo
//     không đi đâu, không lỗi, không log.
//   - khai lỏng tay    → mở đường ra ngoài app.
// Nên phải có test, đặc biệt cho E6c: biên bản chốt sổ là route DUY NHẤT dùng
// khoá BIGINT, matcher gốc chỉ nhận UUID.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_FALLBACK_URL,
  resolveNotificationUrl,
} from "@/lib/notificationRoutes";
import type { PermsLike } from "@/lib/permissionCheck";

/** Quyền: mọi module đều xem được. `canUse` đọc bản đồ dạng `{key: {view: true}}`. */
const ALL = new Proxy({}, { get: () => ({ view: true }) }) as PermsLike;
/** Không có quyền nào. */
const NONE = {} as PermsLike;

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

describe("mọi url thông báo do SQL/edge phát ra phải resolve được (NOTIF-CLIENT-5)", () => {
  // Quét literal url trong migration (hàm SQL sinh thông báo/push) + edge function. Thiếu một
  // route trong allow-list thì bấm push khi app đang mở KHÔNG đi đâu (cầu nối chỉ còn đích dự
  // phòng /my-day), còn mở tab mới lại tới đúng trang — hai đường lệch nhau. Đây là cổng.
  const root = process.cwd();
  const doc = (dir: string, re: RegExp) => readdirSync(join(root, dir), { recursive: true, encoding: "utf8" })
    .filter((f) => re.test(f))
    .map((f) => readFileSync(join(root, dir, f), "utf8"));
  const sqls = doc("supabase/migrations", /\.sql$/);
  // Bỏ file test của edge (fixture dùng url giả như '/approvals').
  const edges = doc("supabase/functions", /(?<!\.test)\.ts$/);

  /** Literal nội bộ (bắt đầu `/`), bỏ URL tuyệt đối (http_post tới edge). */
  function thuUrl(): Set<string> {
    const out = new Set<string>();
    for (const src of sqls) {
      // jsonb_build_object(..., 'url', '/x?k=' || id, ...)
      for (const m of src.matchAll(/'url'\s*,\s*'(\/[^']*)'/g)) out.add(m[1]!);
      // route := '/x' | v_url := CASE … THEN '/a' ELSE '/b' END | url := '/my-day'
      for (const m of src.matchAll(/\b(?:route|v_url|url)\s*:=\s*([^;]*)/g))
        for (const lit of m[1]!.matchAll(/'(\/[^']*)'/g)) out.add(lit[1]!);
    }
    for (const src of edges) for (const m of src.matchAll(/\burl\b[^\n]{0,80}?:\s*'(\/[^']*)'/g)) out.add(m[1]!);
    return out;
  }
  /** Literal kết thúc bằng `=` hoặc `/` là tiền tố nối với id (`|| p_job::text`). */
  const dien = (lit: string) =>
    lit.endsWith("/closure/") ? `${lit}35` : (lit.endsWith("=") || (lit.endsWith("/") && lit.length > 1)) ? `${lit}${BOOK}` : lit;

  it("tìm thấy đủ nhóm url đã biết (bộ quét không xanh rỗng)", () => {
    const urls = thuUrl();
    for (const known of [
      "/settings/hermes", "/chat-zalo", "/my-day", "/tasks?job=", "/thu-tien?handover=",
      "/income-expense?approval_status=UNAPPROVED&layer=PENDING", "/income-expense/voucher/",
      "/finance/cashbooks?close=", "/finance/cashbooks?confirm=", "/finance/cashbooks/closure/",
      "/contracts", "/rooms", "/invoices",
    ]) expect(urls, known).toContain(known);
  });

  it("mỗi url resolve khác null (đủ quyền), và về đích dự phòng chứ không null khi thiếu quyền", () => {
    const urls = [...thuUrl(), "/"]; // send-push mặc định url '/' (gửi thử)
    for (const lit of urls) {
      const url = dien(lit);
      expect(resolveNotificationUrl(url, ALL), url).not.toBeNull();
      expect(resolveNotificationUrl(url, NONE), url).not.toBeNull();
    }
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
