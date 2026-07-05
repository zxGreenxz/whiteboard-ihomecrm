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
    expect(expenseRankOf("không-khớp-gì", "không-khớp-gì", undefined, 3)).toBe(3);
    expect(expenseRankOf("Tiền nhà", "Tiền nhà", undefined, 8)).toBe(8);
  });
});

describe("expenseRankOf — ánh xạ theo MÔ TẢ phiếu (loại/không có item chung)", () => {
  it("phiếu 'tự động lập'/không item mang loại chung nhưng TÊN nói rõ hạng mục → khớp đúng", () => {
    // typeName = 'Không có hạng mục' (phiếu trống item) nhưng mô tả rõ hạng mục.
    expect(expenseRankOf(null, "Không có hạng mục", "Tiền nhà (tự động lập)")).toBe(0);
    expect(expenseRankOf(null, "Không có hạng mục", "Đóng tiền điện tháng 6")).toBe(1);
    expect(expenseRankOf(null, "Chi phí khác", "Tiền nước kỳ T6/2026")).toBe(2);
    expect(expenseRankOf(null, "—", "Đóng tiền internet (tự động lập)")).toBe(3);
    expect(expenseRankOf(null, "—", "tiền công an T6, T7")).toBe(6);
    expect(expenseRankOf(null, "—", "tiền rác tháng 7")).toBe(7);
  });

  it("KHÔNG khớp nhầm: điện lạnh / vệ sinh máy lạnh không phải hạng mục cố định", () => {
    // 'điện lạnh' ≠ 'tiền điện' → không lọt nhóm Điện.
    expect(expenseRankOf("Bảo Trì", "vệ sinh máy lạnh", "thu chi điện lạnh - vệ sinh máy lạnh")).toBe(9);
    expect(expenseRankOf("Bảo Trì", "vệ sinh máy giặt", "Thanh toán Điện Lạnh tháng 5")).toBe(9);
    expect(expenseRankOf(null, "Mua đồ điện nước", "mua bóng đèn led")).toBe(9);
    expect(expenseRankOf(null, "Thu chi khác", "In decal thông tây hội")).toBe(9);
  });

  it("khớp qua category vẫn ưu tiên (mô tả chỉ là bổ trợ)", () => {
    expect(expenseRankOf("Tiền Nhà", "Tiền nhà", "Tiền nhà (tự động lập)")).toBe(0);
    expect(expenseRankOf("Điện", "Đóng tiền điện", "anh Huy đóng tiền điện - Đóng tiền điện")).toBe(1);
  });

  it("CẤU TRÚC thắng MÔ TẢ: phiếu tên 'điện nước' nhưng loại 'Đóng tiền nước' → Nước, KHÔNG bị hút vào Điện", () => {
    // Regression: tên phiếu chứa cả 'điện' lẫn 'nước'; loại là Nước → phải rank 2.
    expect(
      expenseRankOf("Nước", "Đóng tiền nước", "đóng tiền điện nước các nhà - Đóng tiền nước"),
    ).toBe(2);
    // Ngược lại, dòng điện cùng phiếu (loại 'Đóng tiền điện') → rank 1.
    expect(
      expenseRankOf("Điện", "Đóng tiền điện", "đóng tiền điện nước các nhà - Đóng tiền điện"),
    ).toBe(1);
  });
});
