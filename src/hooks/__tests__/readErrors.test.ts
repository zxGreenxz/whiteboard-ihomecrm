// `.single()` trả PGRST116 khi 0 dòng. Nếu đổi hết `return null` thành `throw`
// một cách máy móc thì "bản ghi đã bị xoá" biến thành màn hình lỗi đỏ — sửa một
// lỗi bằng cách tạo ra lỗi ngược lại.
//
// nullIfNotFound tách đúng hai ca đó: KHÔNG TÌM THẤY là dữ liệu (null), mọi mã
// khác — mất quyền, đứt mạng, schema trôi — là lỗi và phải ném.
import { describe, expect, it, vi } from "vitest";

import { nullIfNotFound } from "../readErrors";

describe("nullIfNotFound", () => {
  it("PGRST116 (.single() 0 dòng) → null, không ném", () => {
    expect(nullIfNotFound({ code: "PGRST116", message: "0 rows" }, "useArea")).toBeNull();
  });

  it("P0002 (no_data_found từ RPC) → null", () => {
    expect(nullIfNotFound({ code: "P0002", message: "no data" }, "useArea")).toBeNull();
  });

  it("42501 mất quyền → NÉM, không trả null", () => {
    expect(() => nullIfNotFound({ code: "42501", message: "RLS" }, "useArea")).toThrow();
  });

  it("lỗi mạng không có code → NÉM (mặc định không phải không-tìm-thấy)", () => {
    expect(() => nullIfNotFound({ message: "Failed to fetch" }, "useArea")).toThrow();
  });

  it("ném đúng đối tượng lỗi gốc để QueryCache.onError phân loại được", () => {
    const goc = { code: "42501", message: "RLS" };
    expect(() => nullIfNotFound(goc, "useArea")).toThrow(expect.objectContaining({ code: "42501" }));
  });

  it("ghi log kèm nhãn khi ném, im lặng khi không tìm thấy", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      nullIfNotFound({ code: "PGRST116" }, "useArea");
      expect(log).not.toHaveBeenCalled();
      expect(() => nullIfNotFound({ code: "42501" }, "useArea")).toThrow();
      expect(log).toHaveBeenCalledWith("useArea error:", { code: "42501" });
    } finally {
      log.mockRestore();
    }
  });
});
