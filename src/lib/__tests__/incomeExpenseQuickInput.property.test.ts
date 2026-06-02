import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  parseIncomeExpenseQuickInput,
  parseQuickAmount,
  countTokens,
  type IeTypeRef,
} from "../incomeExpenseQuickInput";
import type { BuildingRef, RoomRef } from "../textMatch";

const buildings: BuildingRef[] = [
  { id: "b-1", name: "1392QT", code: "1392qt, QT, 1392" },
  { id: "b-2", name: "Tòa A", code: "TA" },
];

const rooms: RoomRef[] = [
  { id: "r-1", name: "201", code: "201", building_id: "b-1" },
  { id: "r-2", name: "202", code: "202", building_id: "b-1" },
];

const types: IeTypeRef[] = [
  { id: "t-1", name: "Tiền điện", category: "Điện nước", type: "expense" },
  { id: "t-2", name: "Sửa máy lạnh", category: "Bảo trì", type: "expense" },
  { id: "t-3", name: "Phí 2 chiều", category: "Phí", type: "expense" },
];

const endFor = (name: string) => 2 + countTokens(name);

const parse = (raw: string, lock?: { id: string; end: number }) =>
  parseIncomeExpenseQuickInput({
    raw,
    buildings,
    rooms,
    types,
    lockedTypeId: lock?.id ?? null,
    categoryEndIndex: lock?.end ?? null,
  });

describe("parseQuickAmount", () => {
  it("treats bare number and 'k' suffix identically as thousands", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 99999 }), (n) => {
        const bare = parseQuickAmount(String(n));
        const k = parseQuickAmount(`${n}k`);
        expect(bare).toBe(n * 1000);
        expect(k).toBe(n * 1000);
        expect(bare! % 1000).toBe(0);
      }),
    );
  });

  it("examples: 200 and 200k both = 200000", () => {
    expect(parseQuickAmount("200")).toBe(200000);
    expect(parseQuickAmount("200k")).toBe(200000);
    expect(parseQuickAmount("200K")).toBe(200000);
  });

  it("rejects non-numeric / zero / negative / separators / decimals", () => {
    for (const bad of ["", "  ", "abc", "0", "-5", "12.5", "1,000", "1.000", "k", "20x"]) {
      expect(parseQuickAmount(bad)).toBeNull();
    }
  });
});

describe("parseIncomeExpenseQuickInput", () => {
  it("is deterministic for the same inputs", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(parse(s)).toEqual(parse(s));
      }),
    );
  });

  it("flags structure error when fewer than 2 tokens", () => {
    expect(parse("").errors.structure).toBeTruthy();
    expect(parse("201").errors.structure).toBeTruthy();
    expect(parse("201").hasAnyError).toBe(true);
  });

  it("flags buildingNotFound for an unknown building token", () => {
    const r = parse("201 zzz tiền điện 200");
    expect(r.buildingId).toBeNull();
    expect(r.errors.buildingNotFound).toBeTruthy();
  });

  it("resolves building + room, including alias codes", () => {
    const r = parse("201 QT Tiền điện 200", { id: "t-1", end: endFor("Tiền điện") });
    expect(r.buildingId).toBe("b-1");
    expect(r.roomId).toBe("r-1");
    expect(r.amount).toBe(200000);
  });

  it("treats 'tn' as building-wide (no room, no roomNotFound)", () => {
    const r = parse("tn 1392qt Tiền điện 200", { id: "t-1", end: endFor("Tiền điện") });
    expect(r.isBuildingWide).toBe(true);
    expect(r.roomId).toBeNull();
    expect(r.buildingId).toBe("b-1");
    expect(r.errors.roomNotFound).toBeUndefined();
  });

  it("flags roomNotFound when room is not in the building", () => {
    const r = parse("999 1392qt Tiền điện 200", { id: "t-1", end: endFor("Tiền điện") });
    expect(r.buildingId).toBe("b-1");
    expect(r.roomId).toBeNull();
    expect(r.errors.roomNotFound).toBeTruthy();
  });

  describe("category lock", () => {
    it("stays locked across any appended note + amount", () => {
      fc.assert(
        fc.property(
          fc.array(fc.constantFrom("thay", "gas", "ống", "nước", "gấp"), {
            maxLength: 4,
          }),
          fc.integer({ min: 1, max: 9999 }),
          (noteWords, amt) => {
            const raw = [
              "201",
              "1392qt",
              "Sửa",
              "máy",
              "lạnh",
              ...noteWords,
              String(amt),
            ].join(" ");
            const r = parse(raw, { id: "t-2", end: endFor("Sửa máy lạnh") });
            expect(r.typeId).toBe("t-2");
            expect(r.categoryLocked).toBe(true);
            expect(r.noteText).toBe(noteWords.join(" "));
            expect(r.amount).toBe(amt * 1000);
            expect(r.buildingId).toBe("b-1");
            expect(r.roomId).toBe("r-1");
          },
        ),
      );
    });

    it("unlocks when the category region is edited away from canonical", () => {
      const r = parse("201 1392qt Sua dien lanh thay gas 200", {
        id: "t-2",
        end: endFor("Sửa máy lạnh"),
      });
      expect(r.categoryLocked).toBe(false);
      expect(r.typeId).toBeNull();
      expect(r.categorySearch).not.toBeNull();
      expect(r.errors.categoryMissing).toBeTruthy();
    });

    it("matches canonical region ignoring diacritics/case", () => {
      const r = parse("201 1392qt sua may lanh thay gas 200", {
        id: "t-2",
        end: endFor("Sửa máy lạnh"),
      });
      expect(r.categoryLocked).toBe(true);
      expect(r.typeId).toBe("t-2");
      expect(r.noteText).toBe("thay gas");
    });
  });

  describe("amount never steals an interior numeric token of the category", () => {
    it("does not treat the category's trailing number as amount", () => {
      const r = parse("201 1392qt Phí 2 chiều", {
        id: "t-3",
        end: endFor("Phí 2 chiều"),
      });
      expect(r.typeId).toBe("t-3");
      expect(r.amount).toBeNull();
      expect(r.amountToken).toBeNull();
      expect(r.errors.amountMissing).toBeTruthy();
    });

    it("still parses a real trailing amount after such a category", () => {
      const r = parse("201 1392qt Phí 2 chiều 500", {
        id: "t-3",
        end: endFor("Phí 2 chiều"),
      });
      expect(r.typeId).toBe("t-3");
      expect(r.amount).toBe(500000);
      expect(r.noteText).toBe("");
    });
  });

  describe("categorySearch (unlocked → drives dropdown)", () => {
    it("is set once the user starts typing the category", () => {
      expect(parse("201 1392qt tien").categorySearch).toBe("tien");
      expect(parse("201 1392qt tien dien").categorySearch).toBe("tien dien");
    });

    it("is empty-string right after building + trailing space", () => {
      expect(parse("201 1392qt ").categorySearch).toBe("");
    });

    it("is null before the category zone", () => {
      expect(parse("201 1392qt").categorySearch).toBeNull();
      expect(parse("201").categorySearch).toBeNull();
    });
  });
});
