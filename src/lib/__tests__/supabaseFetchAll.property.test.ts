import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { fetchAllRows, SUPABASE_PAGE } from "../supabaseFetchAll";

// Giả lập một bảng N dòng và một builder trả đúng lát [from, to] (đóng 2 đầu),
// hệt PostgREST .range(). Khẳng định fetchAllRows luôn gộp đủ N dòng, đúng thứ
// tự, không sót/trùng — với mọi N kể cả bội số của trang.
function makeFakeTable(rows: number[], pageSize = SUPABASE_PAGE) {
  let calls = 0;
  const build = (from: number, to: number) => {
    calls++;
    // PostgREST range đóng 2 đầu: [from, to], tối đa (to-from+1) dòng.
    const slice = rows.slice(from, to + 1);
    return Promise.resolve({ data: slice, error: null as unknown });
  };
  return { build, getCalls: () => calls };
}

describe("fetchAllRows", () => {
  it("gộp đủ mọi dòng với N tuỳ ý (0..3500), đúng thứ tự", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 3500 }), async (n) => {
        const rows = Array.from({ length: n }, (_, i) => i);
        const { build } = makeFakeTable(rows);
        const got = await fetchAllRows<number>(build);
        expect(got).not.toBeNull();
        expect(got!.length).toBe(n);
        expect(got).toEqual(rows);
      }),
      { numRuns: 60 },
    );
  });

  it("N là bội số đúng của trang vẫn dừng đúng (cần 1 trang rỗng cuối)", async () => {
    const rows = Array.from({ length: 2000 }, (_, i) => i);
    const { build, getCalls } = makeFakeTable(rows);
    const got = await fetchAllRows<number>(build);
    expect(got!.length).toBe(2000);
    // 2000 = 2 trang đầy → cần trang thứ 3 (rỗng) để biết đã hết.
    expect(getCalls()).toBe(3);
  });

  it("trả null khi query lỗi", async () => {
    const build = () => Promise.resolve({ data: null, error: new Error("boom") });
    const got = await fetchAllRows(build);
    expect(got).toBeNull();
  });

  it("tôn trọng pageSize nhỏ", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => i);
    const build = (from: number, to: number) =>
      Promise.resolve({ data: rows.slice(from, to + 1), error: null as unknown });
    const got = await fetchAllRows<number>(build, { pageSize: 10 });
    expect(got!.length).toBe(25);
    expect(got).toEqual(rows);
  });
});
