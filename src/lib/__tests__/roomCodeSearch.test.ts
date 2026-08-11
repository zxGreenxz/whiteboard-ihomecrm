import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  isRoomCodeQuery,
  resolveSearch,
  ROOM_LOOKUP_PENDING_SENTINEL,
} from "@/lib/roomCodeSearch";

describe("isRoomCodeQuery", () => {
  it("nhận diện đúng các mã phòng thật trong DB", () => {
    const codes = [
      "MB", "MB02", "MB1", "MB2",
      "G01", "G02", "G04",
      "L01", "L03", "L06",
      "01", "02", "09", "10",
      "101", "102", "201", "302", "406", "506",
    ];
    for (const c of codes) {
      expect(isRoomCodeQuery(c)).toBe(true);
      expect(isRoomCodeQuery(c.toLowerCase())).toBe(true); // không phân biệt hoa thường
      expect(isRoomCodeQuery(`  ${c}  `)).toBe(true); // chịu được khoảng trắng
    }
  });

  it("KHÔNG nhận các chuỗi không phải mã phòng", () => {
    const notCodes = [
      "", "   ",
      "tiền nhà", "Hóa đơn", "Nguyễn",
      "1000", "5000", "500000", "1234", // số tiền thật ≥ 4 chữ số
      "MB%", "G", "L", "P01", "T1", "ST",
      "101A", "12 34",
    ];
    for (const s of notCodes) {
      expect(isRoomCodeQuery(s)).toBe(false);
    }
  });

  it("số ≥ 4 chữ số luôn KHÔNG phải mã phòng (giữ tìm-theo-tiền)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1000, max: 1_000_000_000 }), (n) => {
        expect(isRoomCodeQuery(String(n))).toBe(false);
      }),
    );
  });
});

describe("resolveSearch", () => {
  it("rỗng → mode none", () => {
    expect(resolveSearch("", undefined).mode).toBe("none");
    expect(resolveSearch("   ", undefined).mode).toBe("none");
  });

  it("mã phòng + đang tra cứu (undefined) → pending, sentinel rỗng", () => {
    const r = resolveSearch("201", undefined);
    expect(r.mode).toBe("room");
    expect(r.pending).toBe(true);
    expect(r.roomIds).toEqual([ROOM_LOOKUP_PENDING_SENTINEL]);
    expect(r.amountTarget).toBeNull();
    expect(r.text).toBeUndefined();
  });

  it("mã phòng + có phòng khớp → lọc theo room_ids", () => {
    const ids = ["a", "b", "c"];
    const r = resolveSearch("MB", ids);
    expect(r.mode).toBe("room");
    expect(r.pending).toBe(false);
    expect(r.roomIds).toBe(ids);
    expect(r.amountTarget).toBeNull();
  });

  it("mã phòng dạng SỐ nhưng không có phòng → rơi về tìm theo tiền", () => {
    const r = resolveSearch("201", []);
    expect(r.mode).toBe("amount");
    expect(r.roomIds).toBeNull();
    expect(r.amountTarget).toBe(201);
  });

  it("mã phòng dạng CHỮ (MB) nhưng không có phòng → rơi về tìm theo text", () => {
    const r = resolveSearch("MB", []);
    expect(r.mode).toBe("text");
    expect(r.roomIds).toBeNull();
    expect(r.text).toBe("MB");
  });

  it("số tiền thật (≥4 chữ số) → amount, bỏ qua dấu chấm/phẩy/đ", () => {
    expect(resolveSearch("500000", undefined).mode).toBe("amount");
    expect(resolveSearch("500.000đ", undefined).amountTarget).toBe(500000);
    expect(resolveSearch("1,500,000", undefined).amountTarget).toBe(1500000);
  });

  it("chuỗi chữ → text", () => {
    const r = resolveSearch("tiền nhà", undefined);
    expect(r.mode).toBe("text");
    expect(r.text).toBe("tiền nhà");
  });

  it("số tiền lớn LUÔN ra amount bất kể có roomLookup hay không", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1000, max: 1_000_000_000 }),
        fc.oneof(fc.constant(undefined), fc.constant<string[]>([]), fc.constant<string[]>(["x"])),
        (n, lookup) => {
          const r = resolveSearch(String(n), lookup);
          expect(r.mode).toBe("amount");
          expect(r.amountTarget).toBe(n);
          expect(r.roomIds).toBeNull();
        },
      ),
    );
  });
});
