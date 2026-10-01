import { describe, it, expect } from "vitest";
import { findDateHint, findPeriodHint } from "../dateWords";
import { normalizeForParse } from "../amount";

// Mốc cố định: 01/10/2026 (thứ Năm). Kết quả mong đợi tính tay.
const TODAY = "2026-10-01";
const date = (text: string) => findDateHint(text, TODAY)?.date ?? null;
const period = (text: string) => {
  const p = findPeriodHint(text, TODAY);
  return p ? [p.start, p.end] : null;
};

describe("findDateHint — từ chỉ ngày", () => {
  it.each([
    ["hôm nay ăn trưa 50k", "2026-10-01"],
    ["tối nay", "2026-10-01"],
    ["hôm qua mua sơn", "2026-09-30"],
    ["tối qua", "2026-09-30"],
    ["hom qua", "2026-09-30"],
    ["hôm kia sửa vòi", "2026-09-29"],
  ])("%s → %s", (text, want) => {
    expect(date(text)).toBe(want);
  });
});

describe("findDateHint — ngày số", () => {
  it("ngày D trong tháng này; nếu thành ngày tương lai thì lùi về tháng trước", () => {
    expect(date("ngày 1 mua nước")).toBe("2026-10-01");
    expect(date("ngày 25 mua nước")).toBe("2026-09-25");
  });

  it.each([
    ["25/9", "2026-09-25"],
    ["25-9", "2026-09-25"],
    ["ngày 25/09 mua sơn 300k", "2026-09-25"],
    ["25/09/2025", "2025-09-25"],
  ])("%s → %s", (text, want) => {
    expect(date(text)).toBe(want);
  });

  it("ngày-tháng không ghi năm mà thành tương lai ⇒ lùi về năm trước", () => {
    expect(date("3/10")).toBe("2025-10-03");
  });

  it("ngày không tồn tại bị bỏ qua", () => {
    expect(date("31/2")).toBeNull();
  });

  it("câu có hai mốc ngày ⇒ mốc nhắc TRƯỚC thắng (ngày phát sinh thường nói đầu câu)", () => {
    expect(date("hôm qua trả tiền điện hoá đơn ngày 25/9")).toBe("2026-09-30");
    expect(date("25/9 sửa vòi, hôm qua mới trả")).toBe("2026-09-25");
  });

  it("câu không có ngày ⇒ null", () => {
    expect(date("mua sơn 300k")).toBeNull();
  });

  it("trả vị trí trên chuỗi đã chuẩn hoá", () => {
    const text = "Mua sơn Hôm Qua 300k";
    const hint = findDateHint(text, TODAY);
    expect(hint && normalizeForParse(text).slice(hint.textStart, hint.textEnd)).toBe("hôm qua");
  });
});

describe("findPeriodHint — kỳ tháng", () => {
  it.each([
    ["tiền điện tháng 9", ["2026-09-01", "2026-09-30"]],
    ["tiền điện tháng 09", ["2026-09-01", "2026-09-30"]],
    ["nước T9 1tr2", ["2026-09-01", "2026-09-30"]],
    ["tháng 2 tiền rác", ["2026-02-01", "2026-02-28"]],
    ["tháng 9/2025", ["2025-09-01", "2025-09-30"]],
    ["internet tháng này", ["2026-10-01", "2026-10-31"]],
    ["tháng trước tiền rác", ["2026-09-01", "2026-09-30"]],
  ])("%s → %j", (text, want) => {
    expect(period(text)).toEqual(want);
  });

  it("tháng chưa tới năm nay ⇒ hiểu là năm trước (không tự ra kỳ tương lai)", () => {
    expect(period("tiền điện tháng 12")).toEqual(["2025-12-01", "2025-12-31"]);
  });

  it("không nhầm chữ có t+số bên trong một từ khác", () => {
    expect(period("mua đt9 300k")).toBeNull();
  });

  it("câu không có kỳ ⇒ null", () => {
    expect(period("mua sơn 300k")).toBeNull();
  });
});
