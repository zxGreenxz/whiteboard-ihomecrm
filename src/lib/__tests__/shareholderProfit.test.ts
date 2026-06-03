import { describe, it, expect } from "vitest";
import { computeShareholderSummary } from "@/lib/shareholderProfit";

describe("computeShareholderSummary", () => {
  it("trả về 0 cho cổ đông không có dữ liệu", () => {
    const out = computeShareholderSummary(["a"], [], []);
    expect(out.a).toEqual({ shareholder_id: "a", accrued: 0, paid: 0, remaining: 0 });
  });

  it("cộng dồn được chia và đã ứng, còn lại = được chia - đã ứng", () => {
    const out = computeShareholderSummary(
      ["a", "b"],
      [
        { shareholder_id: "a", amount: 1_000_000 },
        { shareholder_id: "a", amount: 500_000 },
        { shareholder_id: "b", amount: 2_000_000 },
      ],
      [
        { shareholder_id: "a", total_amount: 600_000 },
        { shareholder_id: "b", total_amount: 2_500_000 },
      ]
    );
    expect(out.a).toEqual({ shareholder_id: "a", accrued: 1_500_000, paid: 600_000, remaining: 900_000 });
    // b ứng vượt phần được chia → còn lại âm (đã ứng trước)
    expect(out.b).toEqual({ shareholder_id: "b", accrued: 2_000_000, paid: 2_500_000, remaining: -500_000 });
  });

  it("tự thêm cổ đông xuất hiện trong allocations/distributions dù không có trong danh sách id", () => {
    const out = computeShareholderSummary(
      [],
      [{ shareholder_id: "x", amount: 300_000 }],
      [{ shareholder_id: "y", total_amount: 100_000 }]
    );
    expect(out.x.remaining).toBe(300_000);
    expect(out.y.remaining).toBe(-100_000);
  });

  it("bỏ qua giá trị không hợp lệ (NaN/undefined) coi như 0", () => {
    const out = computeShareholderSummary(
      ["a"],
      [{ shareholder_id: "a", amount: Number.NaN as unknown as number }],
      [{ shareholder_id: "a", total_amount: undefined as unknown as number }]
    );
    expect(out.a).toEqual({ shareholder_id: "a", accrued: 0, paid: 0, remaining: 0 });
  });
});
