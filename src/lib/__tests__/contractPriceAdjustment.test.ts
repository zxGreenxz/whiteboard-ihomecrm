import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  DEPOSIT_ADJUSTMENT_TAG,
  applyDepositAdjustmentNote,
  buildDepositAdjustmentNote,
  depositAdjustmentHint,
  describeDepositAdjustment,
  stripDepositAdjustmentNote,
} from "@/lib/contractPriceAdjustment";

describe("describeDepositAdjustment", () => {
  it("cọc = tiền thuê → không coi là điều chỉnh", () => {
    expect(describeDepositAdjustment(4_500_000, 4_500_000)).toMatchObject({
      direction: "NONE",
      diff: 0,
    });
  });

  it("cọc thấp hơn tiền thuê → GIẢM", () => {
    expect(describeDepositAdjustment(4_500_000, 3_000_000)).toMatchObject({
      direction: "DECREASE",
      diff: 1_500_000,
    });
  });

  it("cọc cao hơn tiền thuê → TĂNG", () => {
    expect(describeDepositAdjustment(4_500_000, 9_000_000)).toMatchObject({
      direction: "INCREASE",
      diff: 4_500_000,
    });
  });

  it("chênh dưới ngưỡng làm tròn 0,01đ → NONE (không sinh ghi chú rác)", () => {
    expect(describeDepositAdjustment(4_500_000, 4_500_000.005).direction).toBe(
      "NONE",
    );
  });

  it("null/undefined/NaN quy về 0 thay vì vỡ số", () => {
    expect(describeDepositAdjustment(null, undefined).direction).toBe("NONE");
    expect(describeDepositAdjustment(Number.NaN, 1_000_000)).toMatchObject({
      direction: "INCREASE",
      diff: 1_000_000,
    });
  });
});

describe("depositAdjustmentHint", () => {
  it("nói rõ GIẢM khi cọc nhỏ hơn mặc định", () => {
    const hint = depositAdjustmentHint(
      describeDepositAdjustment(4_500_000, 3_000_000),
    );
    expect(hint).toContain("GIẢM");
    expect(hint).toContain("1.500.000 đ");
  });

  it("nói rõ TĂNG khi cọc lớn hơn mặc định", () => {
    const hint = depositAdjustmentHint(
      describeDepositAdjustment(4_500_000, 6_000_000),
    );
    expect(hint).toContain("TĂNG");
    expect(hint).toContain("1.500.000 đ");
  });

  it("không có hint khi cọc đúng mặc định", () => {
    expect(
      depositAdjustmentHint(describeDepositAdjustment(4_500_000, 4_500_000)),
    ).toBeNull();
  });
});

describe("buildDepositAdjustmentNote", () => {
  it("gắn thẻ lọc được ở đầu dòng", () => {
    const note = buildDepositAdjustmentNote(4_500_000, 3_000_000);
    expect(note?.startsWith(DEPOSIT_ADJUSTMENT_TAG)).toBe(true);
    expect(note).toContain("giảm");
  });

  it("không sinh dòng khi cọc = tiền thuê", () => {
    expect(buildDepositAdjustmentNote(4_500_000, 4_500_000)).toBeNull();
  });
});

describe("applyDepositAdjustmentNote", () => {
  it("giữ nguyên ghi chú user và thêm dòng thẻ", () => {
    const result = applyDepositAdjustmentNote(
      "Khách hẹn dọn vào ngày 5",
      4_500_000,
      3_000_000,
    );
    expect(result).toContain("Khách hẹn dọn vào ngày 5");
    expect(result).toContain(DEPOSIT_ADJUSTMENT_TAG);
  });

  it("sửa HĐ nhiều lần chỉ còn ĐÚNG MỘT dòng thẻ", () => {
    let notes = applyDepositAdjustmentNote("Ghi chú gốc", 4_500_000, 3_000_000);
    notes = applyDepositAdjustmentNote(notes, 4_500_000, 2_000_000);
    notes = applyDepositAdjustmentNote(notes, 4_500_000, 1_000_000);
    const tagLines = (notes ?? "")
      .split("\n")
      .filter((l) => l.startsWith(DEPOSIT_ADJUSTMENT_TAG));
    expect(tagLines).toHaveLength(1);
    expect(tagLines[0]).toContain("3.500.000 đ");
    expect(notes).toContain("Ghi chú gốc");
  });

  it("cọc quay về = tiền thuê → gỡ hẳn dòng thẻ", () => {
    const tagged = applyDepositAdjustmentNote("Ghi chú gốc", 4_500_000, 3_000_000);
    const cleared = applyDepositAdjustmentNote(tagged, 4_500_000, 4_500_000);
    expect(cleared).toBe("Ghi chú gốc");
  });

  it("ghi chú rỗng + cọc đúng mặc định → null (cột nullable)", () => {
    expect(applyDepositAdjustmentNote("", 4_500_000, 4_500_000)).toBeNull();
    expect(applyDepositAdjustmentNote(null, 4_500_000, 4_500_000)).toBeNull();
  });

  it("dữ liệu cũ có nhiều dòng thẻ chồng chất → dọn còn 1", () => {
    const messy = [
      "Ghi chú gốc",
      `${DEPOSIT_ADJUSTMENT_TAG} cũ 1`,
      `${DEPOSIT_ADJUSTMENT_TAG} cũ 2`,
    ].join("\n");
    const result = applyDepositAdjustmentNote(messy, 4_500_000, 3_000_000);
    expect(
      (result ?? "").split("\n").filter((l) => l.startsWith(DEPOSIT_ADJUSTMENT_TAG)),
    ).toHaveLength(1);
  });
});

describe("bất biến (property-based)", () => {
  const money = fc.integer({ min: 0, max: 500_000_000 });

  it("apply luôn idempotent: chạy lại cùng input không đổi kết quả", () => {
    fc.assert(
      fc.property(fc.string(), money, money, (notes, rent, deposit) => {
        const once = applyDepositAdjustmentNote(notes, rent, deposit);
        const twice = applyDepositAdjustmentNote(once, rent, deposit);
        expect(twice).toBe(once);
      }),
    );
  });

  it("phần ghi chú do user viết không bao giờ bị mất", () => {
    fc.assert(
      fc.property(fc.string(), money, money, (notes, rent, deposit) => {
        const stripped = stripDepositAdjustmentNote(notes);
        const result = applyDepositAdjustmentNote(notes, rent, deposit) ?? "";
        if (stripped) expect(result).toContain(stripped);
      }),
    );
  });

  it("số dòng thẻ trong kết quả luôn ≤ 1", () => {
    fc.assert(
      fc.property(fc.string(), money, money, (notes, rent, deposit) => {
        const result = applyDepositAdjustmentNote(notes, rent, deposit) ?? "";
        const count = result
          .split("\n")
          .filter((l) => l.trimStart().startsWith(DEPOSIT_ADJUSTMENT_TAG)).length;
        expect(count).toBeLessThanOrEqual(1);
      }),
    );
  });
});
