import { describe, expect, it } from "vitest";
import { isJsonObject, jsonArray, jsonProp } from "./jsonValue";

// Các test dưới đây khoá HÀNH VI, không khoá kiểu: mục đích của module là thay
// `(supabase.rpc as any)` mà KHÔNG đổi kết quả chạy thật. Nếu một hàm ở đây lệch
// khỏi lối viết cũ (`value?.key`, `Array.isArray(x) ? x : []`) thì đó là bug —
// nó sẽ âm thầm đổi số liệu lương/lợi nhuận ở chỗ gọi.

describe("isJsonObject", () => {
  it("nhận object thường", () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject({ a: 1 })).toBe(true);
  });

  it("từ chối mảng — mảng cũng là 'object' với typeof, đây là bẫy hay gặp nhất", () => {
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject([{ a: 1 }])).toBe(false);
  });

  it("từ chối null — typeof null === 'object' là lỗi lịch sử của JS", () => {
    expect(isJsonObject(null)).toBe(false);
  });

  it("từ chối các giá trị JSON nguyên thuỷ", () => {
    for (const v of ["chuỗi", 0, 42, true, false, undefined]) {
      expect(isJsonObject(v)).toBe(false);
    }
  });
});

describe("jsonProp", () => {
  it("đọc được trường có thật, kể cả khi giá trị là falsy", () => {
    expect(jsonProp({ attend_amount: 1500 }, "attend_amount")).toBe(1500);
    expect(jsonProp({ attend_amount: 0 }, "attend_amount")).toBe(0);
    expect(jsonProp({ locked: false }, "locked")).toBe(false);
    expect(jsonProp({ note: null }, "note")).toBe(null);
  });

  it("trả undefined cho trường không tồn tại", () => {
    expect(jsonProp({ a: 1 }, "b")).toBeUndefined();
  });

  it("trả undefined thay vì ném khi value không phải object", () => {
    for (const v of [null, undefined, 42, "x", true, []]) {
      expect(jsonProp(v, "bất_kỳ")).toBeUndefined();
    }
  });

  it("khớp hành vi `value?.key` cũ trên mọi dạng input", () => {
    const inputs: unknown[] = [null, undefined, 0, "", { k: 9 }, { other: 1 }];
    for (const v of inputs) {
      const cũ = (v as Record<string, unknown> | null | undefined)?.k;
      expect(jsonProp(v, "k")).toEqual(cũ === undefined ? undefined : cũ);
    }
  });
});

describe("jsonArray", () => {
  it("trả đúng mảng khi trường là mảng", () => {
    expect(jsonArray({ organizations: [{ id: "a" }] }, "organizations")).toEqual([{ id: "a" }]);
    expect(jsonArray({ organizations: [] }, "organizations")).toEqual([]);
  });

  it("trả mảng rỗng khi trường thiếu hoặc sai kiểu — chỗ gọi luôn .map() được", () => {
    expect(jsonArray({}, "organizations")).toEqual([]);
    expect(jsonArray({ organizations: null }, "organizations")).toEqual([]);
    expect(jsonArray({ organizations: "không phải mảng" }, "organizations")).toEqual([]);
    expect(jsonArray({ organizations: { 0: "giả mảng" } }, "organizations")).toEqual([]);
    expect(jsonArray(null, "organizations")).toEqual([]);
  });

  it("trả về CHÍNH mảng gốc, không sao chép — chỗ gọi map() ngay nên không cần tốn thêm", () => {
    const rows = [{ id: "a" }];
    expect(jsonArray({ organizations: rows }, "organizations")).toBe(rows);
  });
});
