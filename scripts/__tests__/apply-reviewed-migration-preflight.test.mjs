import { describe, expect, it, vi } from "vitest";

import { kiemTraCoApplySom, kiemTraHaiLuotTruocApply } from "../apply-reviewed-migration.mjs";

describe("kiểm tra hai lượt bắt buộc trước apply", () => {
  it("gửi đúng hai thân migration và luôn ROLLBACK", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => "[]" }));
    const result = await kiemTraHaiLuotTruocApply("BEGIN;\nSELECT 'marker';\nCOMMIT;", {
      pat: "pat-test", ref: "ref-test", fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(result.query.match(/SELECT 'marker';/g)).toHaveLength(2);
    expect(result.query.match(/^\s*COMMIT\s*;\s*$/gm) ?? []).toHaveLength(0);
    expect(result.query.match(/^\s*ROLLBACK\s*;\s*$/gm)).toHaveLength(1);
    const [, options] = fetchImpl.mock.calls[0];
    expect(JSON.parse(options.body).query).toBe(result.query);
  });

  it("trả nguyên thất bại để caller dừng trước backup/apply", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 400, text: async () => "second pass failed" }));
    await expect(kiemTraHaiLuotTruocApply("SELECT 1;", { pat: "p", ref: "r", fetchImpl })).resolves.toMatchObject({
      ok: false, status: 400, body: "second pass failed",
    });
  });
});

describe("cửa quyền chạy trước khi kết nối production", () => {
  it("từ chối bỏ backup thiếu token trước khi caller có thể chạy preflight", () => {
    expect(kiemTraCoApplySom(["node", "file.sql", "--apply", "--khong-backup", "khẩn"], {})).toEqual({
      ok: false, vi: "khong-token",
    });
  });

  it("từ chối lý do rỗng ngay cả khi có token", () => {
    expect(kiemTraCoApplySom(["node", "file.sql", "--apply", "--khong-backup"], { IHOMECRM_PROMOTION_TOKEN: "x" })).toEqual({
      ok: false, vi: "thieu-ly-do",
    });
  });
});
