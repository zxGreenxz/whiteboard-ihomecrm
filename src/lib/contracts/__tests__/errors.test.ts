import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  classifyDbError,
  extractCode,
  isRetryable,
  isUserActionable,
  type ErrorCategory,
} from "../errors";
import { retryOnlyConcurrency, toResult, unwrapOrThrow } from "../envelopes";

describe("phân loại lỗi ở biên RPC/Edge", () => {
  it("chỉ nhóm concurrency được thử lại", () => {
    const nhom: ErrorCategory[] = [
      "permission",
      "validation",
      "concurrency",
      "conflict",
      "not_found",
      "rate_limit",
      "internal_invariant",
      "unknown",
    ];
    expect(nhom.filter(isRetryable)).toEqual(["concurrency"]);
  });

  it("rate_limit KHÔNG được thử lại tự động, nhưng LÀ chuyện người dùng xử được", () => {
    // Ca này ghim đúng lý do `rate_limit` là nhóm riêng chứ không nhập vào
    // `concurrency`: tự động thử lại một lỗi giới hạn tốc độ là đổ thêm đúng thứ
    // đã làm nó kích hoạt, nên limiter sẽ không bao giờ hạ xuống.
    expect(classifyDbError({ code: "PT429" })).toBe("rate_limit");
    expect(isRetryable("rate_limit")).toBe(false);
    expect(isUserActionable("rate_limit")).toBe(true);
  });

  it("mã chưa biết rơi vào unknown và KHÔNG được thử lại", () => {
    // Mặc định lạc quan ở đây nghĩa là mọi mã chưa từng gặp sẽ được xử theo cách
    // rẻ nhất — mà mã chưa từng gặp thường xuất hiện đúng lúc có sự cố.
    expect(classifyDbError({ code: "XX999" })).toBe("unknown");
    expect(isRetryable("unknown")).toBe(false);
  });

  it.each([
    ["42501", "permission"],
    ["22023", "validation"],
    ["55000", "conflict"],
    ["23505", "conflict"],
    ["40001", "concurrency"],
    ["40P01", "concurrency"],
    ["P0001", "internal_invariant"],
    ["P0002", "not_found"],
    ["PGRST301", "permission"],
    ["PGRST116", "not_found"],
  ])("%s ⇒ %s", (code, mong) => {
    expect(classifyDbError({ code })).toBe(mong);
  });

  it("lấy được code cả khi lỗi bị bọc một lớp", () => {
    expect(extractCode({ code: "42501" })).toBe("42501");
    expect(extractCode({ error: { code: "40001" } })).toBe("40001");
    expect(extractCode(null)).toBeNull();
    expect(extractCode("chuỗi trần")).toBeNull();
  });

  it("55000 là lỗi của NGƯỜI DÙNG chứ không phải sự cố hệ thống", () => {
    // "phiếu đã duyệt rồi" / "sổ đã chốt rồi" — người dùng cần biết trạng thái
    // đã đổi, không phải nhìn một toast "Có lỗi xảy ra".
    expect(isUserActionable(classifyDbError({ code: "55000" }))).toBe(true);
    expect(isUserActionable(classifyDbError({ code: "P0001" }))).toBe(false);
  });

  /**
   * CHỐT CHẶN CHỐNG TRÔI: bảng mã trong errors.ts được xây từ số đo trên
   * migration. Nếu hệ bắt đầu ném một mã mới mà bảng không biết, nó rơi vào
   * `unknown` — im lặng và không thử lại. Test này biến việc đó thành nhìn thấy
   * được, và nó là lý do bảng kia không được phép ngủ quên.
   */
  it("mọi ERRCODE mà migration thật sự ném đều đã được phân loại", () => {
    const thuMuc = "supabase/migrations";
    const ma = new Map<string, number>();
    for (const f of readdirSync(thuMuc)) {
      if (!f.endsWith(".sql")) continue;
      const s = readFileSync(`${thuMuc}/${f}`, "utf8");
      for (const m of s.matchAll(/ERRCODE\s*=\s*'([A-Z0-9]+)'/gi)) {
        ma.set(m[1], (ma.get(m[1]) ?? 0) + 1);
      }
    }
    expect(ma.size, "không đọc được ERRCODE nào — phép đo hỏng").toBeGreaterThan(8);

    const chuaBiet = [...ma.entries()]
      .filter(([code]) => classifyDbError({ code }) === "unknown")
      .sort((a, b) => b[1] - a[1])
      .map(([code, n]) => `${code} (×${n})`);
    expect(chuaBiet, "ERRCODE migration ném ra mà errors.ts chưa phân loại").toEqual([]);
  });
});

describe("envelope kết quả", () => {
  it("giữ phân loại thay vì biến lỗi thành mảng rỗng", () => {
    const r = toResult<{ id: string }[]>({ data: null, error: { code: "42501" } });
    expect(r.kind).toBe("loi");
    if (r.kind === "loi") {
      expect(r.category).toBe("permission");
      expect(r.retryable).toBe(false);
    }
  });

  it("data null mà không error vẫn là ok (maybeSingle)", () => {
    const r = toResult<null>({ data: null, error: null });
    expect(r.kind).toBe("ok");
  });

  it("unwrapOrThrow gắn category lên chính lỗi gốc, không bọc lại", () => {
    const goc: Record<string, unknown> = { code: "40001", message: "serialization" };
    try {
      unwrapOrThrow(toResult({ data: null, error: goc }));
      throw new Error("phải ném");
    } catch (e) {
      expect(e).toBe(goc); // cùng đối tượng — friendlyError() và mọi chỗ đọc .code vẫn chạy
      expect((e as Record<string, unknown>).category).toBe("concurrency");
      expect((e as Record<string, unknown>).retryable).toBe(true);
    }
  });

  it("retry chỉ cho concurrency, và tối đa 2 lần", () => {
    expect(retryOnlyConcurrency(0, { code: "40001" })).toBe(true);
    expect(retryOnlyConcurrency(1, { code: "40001" })).toBe(true);
    expect(retryOnlyConcurrency(2, { code: "40001" })).toBe(false);
    // Ghi trùng bút toán bắt đầu từ đây: một lời gọi ĐÃ ghi xong rồi hỏng ở
    // đường về, nếu được gửi lại sẽ ghi hai lần.
    expect(retryOnlyConcurrency(0, { code: "23505" })).toBe(false);
    expect(retryOnlyConcurrency(0, { code: "55000" })).toBe(false);
    expect(retryOnlyConcurrency(0, {})).toBe(false);
  });
});
