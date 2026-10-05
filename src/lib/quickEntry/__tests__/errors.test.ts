import { describe, it, expect } from "vitest";
import { classifyAiError } from "../errors";

describe("classifyAiError", () => {
  it.each([
    [403, "quick_entry_disabled", "disabled", false],
    [503, "quick_entry_unconfigured", "disabled", false],
    [403, "not_permitted", "not_permitted", false],
    [403, "not_entitled", "not_permitted", false],
    [403, "organization_forbidden", "not_permitted", false],
    [400, "organization_required", "organization_required", true],
    [403, "quick_entry_daily_cap", "daily_cap", false],
    [403, "daily_quota", "daily_cap", false],
    [403, "daily_token_quota", "daily_cap", false],
    [429, "rate_limited", "rate_limited", true],
    [429, "quick_entry_attempts_exhausted", "rate_limited", true],
    [502, "quick_entry_all_failed", "all_failed", true],
    [413, "payload_too_large", "too_large", false],
    [400, "too_many_images", "too_large", false],
    [0, null, "network", true],
    [500, "something_new", "unknown", true],
  ])("HTTP %i %s ⇒ %s (thử lại được: %s)", (status, code, kind, retryable) => {
    const r = classifyAiError({ status, code });
    expect(r.kind).toBe(kind);
    expect(r.retryable).toBe(retryable);
  });

  it("mọi lỗi đều để người dùng nhập tay, lời báo tiếng Việt không rỗng", () => {
    for (const status of [0, 400, 403, 413, 429, 500, 502, 503]) {
      const r = classifyAiError({ status, code: null });
      expect(r.allowManual).toBe(true);
      expect(r.message.length).toBeGreaterThan(10);
    }
  });

  it("hết lượt trong ngày nói rõ là hết lượt, không đổ lỗi mạng", () => {
    expect(classifyAiError({ status: 403, code: "quick_entry_daily_cap" }).message).toMatch(/lượt/);
  });
  it("thiếu công ty yêu cầu chọn lại, không kết luận tài khoản thiếu quyền", () => {
    const error = classifyAiError({ status: 400, code: "organization_required" });
    expect(error.message).toMatch(/Chọn công ty/);
    expect(error.message).not.toMatch(/chưa được dùng AI/);
  });
});
