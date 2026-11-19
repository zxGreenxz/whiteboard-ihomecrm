import { describe, expect, it } from "vitest";
import type { InvoiceAmountParts } from "@/lib/invoiceAmountParts";
import {
  NO_CATEGORIES,
  filterProfitRows,
  foldVi,
  matchesProfitRowSearch,
  pruneCategorySelection,
  pruneSideSelections,
  resolveProfitRowSearch,
  toggleCategorySelection,
  type ProfitViewRow,
} from "@/lib/profitReportFilters";

// Số liệu giả, tròn — không phải dữ liệu thật.
const phan = (p: Partial<InvoiceAmountParts> = {}): InvoiceAmountParts => ({
  rent: 4_000_000, electric: 300_000, water: 100_000, service: 150_000, other: 0,
  discount: 0, debt: 0, rounding: 0, invoice_amount: 4_550_000, partial: false, ...p,
});

const dong = (key: string, p: Partial<ProfitViewRow> = {}): ProfitViewRow => ({
  key, name: "Chi khác", amount: 100_000, room: null, texts: [], ...p,
});

describe("foldVi", () => {
  it("bỏ dấu, thường hoá, Đ hoa thành d, gọn khoảng trắng", () => {
    expect(foldVi("  Hoá Đơn   ĐIỆN ")).toBe("hoa don dien");
    expect(foldVi(null)).toBe("");
  });
});

describe("resolveProfitRowSearch — thứ tự như ô tìm Thu chi", () => {
  const phong = ["101", "301", "MB1", null];
  it("mã phòng có thật ⇒ tìm theo phòng (không phân biệt hoa thường)", () => {
    expect(resolveProfitRowSearch(" 301 ", phong)).toEqual({ mode: "room", room: "301" });
    expect(resolveProfitRowSearch("mb1", phong)).toEqual({ mode: "room", room: "mb1" });
  });
  it("số 1–3 chữ số không trùng phòng ⇒ tìm như chữ (vd 331 của 331PHI), không thành số tiền", () => {
    expect(resolveProfitRowSearch("331", phong)).toEqual({ mode: "text", tokens: ["331"] });
  });
  it("số ≥ 4 chữ số (có dấu chấm, đ) ⇒ số tiền", () => {
    expect(resolveProfitRowSearch("1.050.000", phong)).toEqual({ mode: "amount", amount: 1_050_000, digits: "1050000" });
    expect(resolveProfitRowSearch("500000đ", phong)).toEqual({ mode: "amount", amount: 500_000, digits: "500000" });
  });
  it("chữ ⇒ tách từ đã bỏ dấu; rỗng ⇒ không lọc", () => {
    expect(resolveProfitRowSearch("Hoa hồng 301/331PHI", [])).toEqual({ mode: "text", tokens: ["hoa", "hong", "301/331phi"] });
    expect(resolveProfitRowSearch("   ", phong)).toEqual({ mode: "none" });
  });
});

describe("matchesProfitRowSearch", () => {
  it("theo phòng: giữ cả dòng ghi chú của phòng, bỏ phòng khác", () => {
    const s = resolveProfitRowSearch("101", ["101", "102"]);
    expect(matchesProfitRowSearch(dong("ghi-chu", { room: "101", isNote: true, amount: 0 }), s)).toBe(true);
    expect(matchesProfitRowSearch(dong("a", { room: "102" }), s)).toBe(false);
  });
  it("theo tiền: lệch ≤ 5.000đ; dòng ghi chú không khớp tiền; chữ chứa số cũng khớp (toà 1392QT)", () => {
    const s = resolveProfitRowSearch("350000", []);
    expect(matchesProfitRowSearch(dong("a", { amount: 354_999 }), s)).toBe(true);
    expect(matchesProfitRowSearch(dong("b", { amount: 356_000 }), s)).toBe(false);
    expect(matchesProfitRowSearch(dong("c", { amount: 350_000, isNote: true }), s)).toBe(false);
    const toa = resolveProfitRowSearch("1392", []);
    expect(matchesProfitRowSearch(dong("d", { amount: 150_000, texts: ["sửa điện 1392qt và 331phi"] }), toa)).toBe(true);
  });
  it("theo chữ: mọi từ phải có, không phân biệt dấu; tìm được mã phiếu", () => {
    const row = dong("a", { texts: ["Chi phí điện lạnh T9 - cụm của Hiệp", "PC2610212", "Điện lạnh", "201"] });
    expect(matchesProfitRowSearch(row, resolveProfitRowSearch("dien lanh hiep", []))).toBe(true);
    expect(matchesProfitRowSearch(row, resolveProfitRowSearch("pc2610212", []))).toBe(true);
    expect(matchesProfitRowSearch(row, resolveProfitRowSearch("dien nuoc", []))).toBe(false);
  });
});

describe("filterProfitRows — chỉ lớp xem", () => {
  const chi: ProfitViewRow[] = [
    dong("tien-nha", { name: "Tiền nhà", amount: 27_000_000, texts: ["Tiền nhà T10"] }),
    dong("dien", { name: "Đóng tiền điện", amount: 7_000_000, texts: ["Điện T10"] }),
    dong("hh", { name: "Hoa hồng môi giới", amount: 2_760_000, room: "301", texts: ["Hoa hồng 301/331PHI"] }),
    dong("thieu", { name: "Vệ sinh", amount: 0, isNote: true, texts: ["Vệ sinh"] }),
  ];
  const self = (r: ProfitViewRow) => r;

  it("không ô tìm, không ô tích ⇒ trả NGUYÊN danh sách và thứ tự; đếm bỏ dòng ghi chú", () => {
    const v = filterProfitRows(chi, self, { search: "", categories: NO_CATEGORIES });
    expect(v.active).toBe(false);
    expect(v.rows).toEqual(chi);
    expect(v.count).toBe(3);
    expect(v.total).toBe(36_760_000);
  });

  it("tích hạng mục ⇒ chỉ dòng thuộc mục đó, dòng ghi chú ẩn; phần đã chọn = tổng mục", () => {
    const v = filterProfitRows(chi, self, { search: "", categories: new Set(["Tiền nhà", "Hoa hồng môi giới"]) });
    expect(v.rows.map((r) => r.key)).toEqual(["tien-nha", "hh"]);
    expect(v.count).toBe(2);
    expect(v.selectedAmount).toBe(29_760_000);
  });

  it("ô tìm VÀ ô tích cùng áp", () => {
    const v = filterProfitRows(chi, self, { search: "301", categories: new Set(["Tiền nhà", "Hoa hồng môi giới"]) });
    expect(v.rows.map((r) => r.key)).toEqual(["hh"]);
  });

  it("khoản thu theo hoá đơn: khớp mục nếu hoá đơn CÓ phần đó; phần đã chọn chỉ cộng phần của mục", () => {
    const parts = new Map([
      ["hd-co-dien", phan()],
      ["hd-khong-dien", phan({ electric: 0, invoice_amount: 4_250_000 })],
    ]);
    const thu = [
      dong("hd-co-dien", { name: "Thu tiền hoá đơn", amount: 4_550_000 }),
      dong("hd-khong-dien", { name: "Thu tiền hoá đơn", amount: 4_250_000 }),
      dong("thanh-ly", { name: "Doanh thu thanh lý", amount: 1_112_000 }),
    ];
    const v = filterProfitRows(thu, self, { search: "", categories: new Set(["Tiền điện"]) }, parts);
    expect(v.rows.map((r) => r.key)).toEqual(["hd-co-dien"]);
    expect(v.selectedAmount).toBe(300_000);
    expect(v.total).toBe(4_550_000);
  });
});

describe("chọn hạng mục", () => {
  it("bật/tắt trả tập mới, không sửa tập cũ", () => {
    const a = new Set(["Tiền nhà"]);
    const b = toggleCategorySelection(a, "Điện");
    expect([...b]).toEqual(["Tiền nhà", "Điện"]);
    expect([...toggleCategorySelection(b, "Tiền nhà")]).toEqual(["Điện"]);
    expect([...a]).toEqual(["Tiền nhà"]);
  });
  it("đổi tháng: bỏ mục không còn; không bỏ gì ⇒ giữ đúng tập cũ (khỏi render lại)", () => {
    const sel = new Set(["Tiền nhà", "Điện"]);
    expect(pruneCategorySelection(sel, ["Tiền nhà", "Điện", "Nước"])).toBe(sel);
    expect([...pruneCategorySelection(sel, ["Tiền nhà"])]).toEqual(["Tiền nhà"]);
    expect(pruneCategorySelection(NO_CATEGORIES, [])).toBe(NO_CATEGORIES);
  });

  it("hai bên: tên bên thu CHƯA chốt (phần tách còn của tháng trước) ⇒ giữ ô tích thu, bên chi vẫn bỏ mục không còn", () => {
    const picked = { income: new Set(["Tiền điện"]), expense: new Set(["Tiền nhà", "Quản lý"]) };
    // phần tách tháng mới chưa về: dòng thu tạm mang tên "Thu tiền hoá đơn" — không được bỏ "Tiền điện"
    const next = pruneSideSelections(picked, { income: null, expense: ["Tiền nhà"] });
    expect(next.income).toBe(picked.income);
    expect([...next.expense]).toEqual(["Tiền nhà"]);
    // phần tách đã về và tháng mới vẫn có "Tiền điện" ⇒ giữ
    expect(pruneSideSelections(next, { income: ["Tiền phòng", "Tiền điện"], expense: ["Tiền nhà"] })).toBe(next);
    // tháng mới thật sự không còn ⇒ bỏ
    expect([...pruneSideSelections(next, { income: ["Tiền phòng"], expense: ["Tiền nhà"] }).income]).toEqual([]);
  });
});
