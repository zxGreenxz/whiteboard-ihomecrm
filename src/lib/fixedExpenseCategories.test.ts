import { describe, it, expect } from "vitest";
import { FIXED_EXPENSE_CATEGORIES, expenseRankOf, nrm } from "./fixedExpenseCategories";

describe("nrm", () => {
  it("bỏ dấu + thường hoá + đ→d", () => {
    expect(nrm("Vệ Sinh")).toBe("ve sinh");
    expect(nrm("Điện")).toBe("dien");
    expect(nrm("Tiền nhà")).toBe("tien nha");
    expect(nrm("Đồng")).toBe("dong");
    expect(nrm(null)).toBe("");
  });
});

describe("FIXED_EXPENSE_CATEGORIES", () => {
  it("đủ 9 hạng mục, chỉ Thang máy cần has_elevator", () => {
    expect(FIXED_EXPENSE_CATEGORIES).toHaveLength(9);
    const elevator = FIXED_EXPENSE_CATEGORIES.filter((c) => c.requiresElevator);
    expect(elevator.map((c) => c.key)).toEqual(["thang_may"]);
  });

  it("mỗi hạng mục tự khớp bằng nhãn của chính nó (đảm bảo placeholder slot đúng)", () => {
    // Bỏ qua vế "Vệ sinh": nhãn hiển thị 'Vệ sinh tòa nhà định kỳ' khớp qua fallback
    // tên; category thật là 'Vệ sinh'. Kiểm riêng ở dưới.
    FIXED_EXPENSE_CATEGORIES.forEach((cat, i) => {
      if (cat.key === "ve_sinh") return;
      expect(expenseRankOf(cat.label, cat.label)).toBe(i);
    });
  });
});

describe("expenseRankOf — 9 hạng mục cố định về đúng vị trí", () => {
  // Dữ liệu thật: dòng có cả category lẫn typeName cùng mang từ khoá → truyền cả
  // hai. (Quản Lý / Rác / Thang máy khớp theo TÊN; các mục còn lại theo category.)
  const cases: Array<[string, number]> = [
    ["Tiền nhà", 0],
    ["Điện", 1],
    ["Nước", 2],
    ["Internet", 3],
    ["Quản lý", 4],
    ["Vệ sinh", 5],
    ["CA", 6],
    ["Rác", 7],
    ["Bảo trì thang máy", 8],
  ];
  it.each(cases)("%s → rank %i", (label, rank) => {
    expect(expenseRankOf(label, label)).toBe(rank);
  });

  it("Điện/Nước/Internet khớp cả khi chỉ có category (tên trống)", () => {
    expect(expenseRankOf("Điện", "—")).toBe(1);
    expect(expenseRankOf("Nước", "—")).toBe(2);
    expect(expenseRankOf("Tiền nhà", "—")).toBe(0);
  });
});

describe("expenseRankOf — biên", () => {
  it("không khớp hạng mục cố định nào → xuống cuối (9)", () => {
    expect(expenseRankOf("Sửa chữa", "Thay bóng đèn")).toBe(9);
    expect(expenseRankOf(null, "—")).toBe(9);
  });

  it("Vệ sinh máy lạnh (category Bảo Trì) KHÔNG lọt nhóm Vệ Sinh #5", () => {
    expect(expenseRankOf("Bảo Trì", "Vệ sinh máy lạnh")).not.toBe(5);
    expect(expenseRankOf("Bảo Trì", "Vệ sinh máy lạnh")).toBe(9);
  });

  it("Rác không bị nuốt vào nhóm Vệ Sinh dù cùng category 'Vệ sinh'", () => {
    expect(expenseRankOf("Vệ sinh", "Tiền rác")).toBe(7);
  });

  it("fixedRank được ưu tiên tuyệt đối", () => {
    expect(expenseRankOf("không-khớp-gì", "không-khớp-gì", 3)).toBe(3);
    expect(expenseRankOf("Tiền nhà", "Tiền nhà", 8)).toBe(8);
  });
});
