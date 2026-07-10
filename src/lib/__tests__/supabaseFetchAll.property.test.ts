import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { fetchAllRows, SUPABASE_PAGE } from "../supabaseFetchAll";

// Giả lập một bảng N dòng và một builder trả đúng lát [from, to] (đóng 2 đầu),
// hệt PostgREST .range(). Khẳng định fetchAllRows luôn gộp đủ N dòng, đúng thứ
// tự, không sót/trùng — với mọi N kể cả bội số của trang.
//
// `serverMaxRows` mô phỏng cấu hình PostgREST/DB giới hạn max-rows THẤP HƠN
// pageSize: dù xin (to-from+1) dòng, server chỉ trả tối đa serverMaxRows.
function makeFakeTable(rows: number[], serverMaxRows = Infinity) {
  let calls = 0;
  const build = (from: number, to: number) => {
    calls++;
    // PostgREST range đóng 2 đầu: [from, to], tối đa (to-from+1) dòng, nhưng
    // server có thể cap thấp hơn (serverMaxRows).
    const width = to - from + 1;
    const take = Math.min(width, serverMaxRows);
    const slice = rows.slice(from, from + take);
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

  // REGRESSION: server max-rows < pageSize. Bản cũ dừng ở "trang ngắn = hết" nên
  // chỉ lấy 400/2500 dòng → hụt tiền. Bản mới tiến theo số dòng thực → đủ.
  it("không suy 'trang ngắn = hết' khi server max-rows < pageSize", async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => i);
    const { build } = makeFakeTable(rows, 400); // server chỉ trả tối đa 400 dù xin 1000
    const got = await fetchAllRows<number>(build);
    expect(got).not.toBeNull();
    expect(got!.length).toBe(2500);
    expect(got).toEqual(rows);
  });

  it("trả null khi query lỗi (caller phải coi null là lỗi, không phải rỗng)", async () => {
    const build = () => Promise.resolve({ data: null, error: new Error("boom") });
    const got = await fetchAllRows(build);
    expect(got).toBeNull();
  });

  it("tôn trọng pageSize nhỏ", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => i);
    const { build } = makeFakeTable(rows);
    const got = await fetchAllRows<number>(build, { pageSize: 10 });
    expect(got!.length).toBe(25);
    expect(got).toEqual(rows);
  });

  // FAIL-CLOSED: chạm hardCap phải THROW, tuyệt đối không trả mảng bị cắt.
  it("throw khi vượt hardCap (không cắt mảng)", async () => {
    const rows = Array.from({ length: 5000 }, (_, i) => i);
    const { build } = makeFakeTable(rows);
    await expect(
      fetchAllRows<number>(build, { pageSize: 1000, hardCap: 2000 }),
    ).rejects.toThrow(/hardCap/);
  });

  // Order không ổn định (build trả trùng dòng mãi) → phải throw nhờ hardCap,
  // KHÔNG lặp vô tận và KHÔNG trả số sai.
  it("throw khi order không ổn định gây lặp (bắt qua hardCap)", async () => {
    const build = () =>
      Promise.resolve({ data: Array.from({ length: 1000 }, (_, i) => i), error: null as unknown });
    await expect(
      fetchAllRows<number>(build, { pageSize: 1000, hardCap: 3000 }),
    ).rejects.toThrow(/hardCap/);
  });

  it("throw RangeError khi pageSize/hardCap không hợp lệ", async () => {
    const build = () => Promise.resolve({ data: [], error: null as unknown });
    await expect(fetchAllRows(build, { pageSize: 0 })).rejects.toThrow(RangeError);
    await expect(fetchAllRows(build, { pageSize: 1.5 })).rejects.toThrow(RangeError);
    await expect(fetchAllRows(build, { pageSize: -10 })).rejects.toThrow(RangeError);
    await expect(fetchAllRows(build, { hardCap: 0 })).rejects.toThrow(RangeError);
    await expect(fetchAllRows(build, { pageSize: 1000, hardCap: 500 })).rejects.toThrow(RangeError);
  });

  it("SUPABASE_PAGE là 1000", () => {
    expect(SUPABASE_PAGE).toBe(1000);
  });
});
