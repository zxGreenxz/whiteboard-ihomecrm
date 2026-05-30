import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  roomNameGroupRank,
  compareRoomNames,
  compareBuildingThenRoom,
  uniqueRoomNames,
} from "@/lib/roomSort";

const sortNames = (names: string[]) => [...names].sort(compareRoomNames);

describe("roomNameGroupRank", () => {
  it("phân nhóm theo tiền tố MB < G < L < số", () => {
    expect(roomNameGroupRank("MB")).toBe(0);
    expect(roomNameGroupRank("MB1")).toBe(0);
    expect(roomNameGroupRank("G02")).toBe(1);
    expect(roomNameGroupRank("L03")).toBe(2);
    expect(roomNameGroupRank("205")).toBe(3);
    expect(roomNameGroupRank("101")).toBe(3);
  });

  it("không phân biệt hoa/thường, bỏ khoảng trắng đầu/cuối", () => {
    expect(roomNameGroupRank(" mb ")).toBe(0);
    expect(roomNameGroupRank("g1")).toBe(1);
    expect(roomNameGroupRank("l5")).toBe(2);
  });
});

describe("compareRoomNames", () => {
  it("thứ tự ví dụ thực tế (toà 111PVC)", () => {
    expect(sortNames(["205", "L05", "L04", "L03", "403", "305"])).toEqual([
      "L03",
      "L04",
      "L05",
      "205",
      "305",
      "403",
    ]);
  });

  it("MB → G → L → số", () => {
    expect(sortNames(["301", "L01", "G02", "MB", "G01", "101"])).toEqual([
      "MB",
      "G01",
      "G02",
      "L01",
      "101",
      "301",
    ]);
  });

  it("so số theo giá trị (natural), không theo ký tự", () => {
    expect(sortNames(["L10", "L2", "L1"])).toEqual(["L1", "L2", "L10"]);
    expect(sortNames(["10", "2", "1", "100"])).toEqual(["1", "2", "10", "100"]);
  });

  it("nhiều phòng cùng nhóm số: tăng dần", () => {
    expect(sortNames(["403", "101", "205", "102"])).toEqual([
      "101",
      "102",
      "205",
      "403",
    ]);
  });

  it("là một comparator hợp lệ: nhóm luôn không giảm sau khi sort (property)", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.constantFrom("MB", "MB1", "MB2"),
            fc.constantFrom("G01", "G1", "G10"),
            fc.constantFrom("L01", "L1", "L10"),
            fc
              .integer({ min: 1, max: 999 })
              .map((n) => String(n)),
          ),
          { maxLength: 30 },
        ),
        (names) => {
          const sorted = [...names].sort(compareRoomNames);
          const ranks = sorted.map(roomNameGroupRank);
          for (let i = 1; i < ranks.length; i++) {
            expect(ranks[i]).toBeGreaterThanOrEqual(ranks[i - 1]);
          }
        },
      ),
    );
  });

  it("đối xứng dấu: compare(a,b) và compare(b,a) ngược dấu (property)", () => {
    const pool = ["MB", "G01", "G10", "L01", "L10", "101", "205", "9", "10"];
    fc.assert(
      fc.property(
        fc.constantFrom(...pool),
        fc.constantFrom(...pool),
        (a, b) => {
          // `+ 0` để chuẩn hoá -0 → 0 (tránh sai khác Object.is khi a tương đương b)
          const ab = Math.sign(compareRoomNames(a, b)) + 0;
          const ba = Math.sign(compareRoomNames(b, a)) + 0;
          expect(ab).toBe(-ba + 0);
        },
      ),
    );
  });
});

describe("uniqueRoomNames", () => {
  it("gộp tên phòng trùng (nhiều toà cùng '101' → 1 mục) và sắp đúng thứ tự", () => {
    const rooms = [
      { name: "101" }, // 1392QT
      { name: "205" },
      { name: "101" }, // 80DS3
      { name: "L03" },
      { name: "101" }, // 417LVT
      { name: "L05" },
    ];
    expect(uniqueRoomNames(rooms)).toEqual(["L03", "L05", "101", "205"]);
  });

  it("bỏ qua tên rỗng/null", () => {
    expect(
      uniqueRoomNames([{ name: "" }, { name: null }, { name: "101" }]),
    ).toEqual(["101"]);
  });
});

describe("compareBuildingThenRoom", () => {
  it("gom theo toà nhà trước, rồi mới theo tên phòng", () => {
    const rows = [
      { b: "111PVC", r: "205" },
      { b: "102LVT", r: "401" },
      { b: "111PVC", r: "L03" },
      { b: "102LVT", r: "G01" },
    ];
    const sorted = [...rows].sort((x, y) =>
      compareBuildingThenRoom(x.b, x.r, y.b, y.r),
    );
    expect(sorted.map((s) => `${s.b}:${s.r}`)).toEqual([
      "102LVT:G01",
      "102LVT:401",
      "111PVC:L03",
      "111PVC:205",
    ]);
  });
});
