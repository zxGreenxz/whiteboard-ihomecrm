import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ruleCategory } from "../categoryRules";
import { suggestCategory, usableExpenseCategories, type CategoryRef } from "../categorySuggest";
import cauThat from "./fixtures/cau-chi-that-2026-10.json";

// Danh mục THẬT: đọc thẳng từ migration dữ liệu để bài kiểm đổi theo khi từ khoá đổi.
interface SpecItem { k: string; g: string | null; n: string; d: string; kw?: string[]; hid?: boolean; qeh?: boolean }
const MIGRATION = resolve(__dirname, "../../../../supabase/migrations/20261003151608_danh_muc_chi_du_lieu.sql");
const spec = JSON.parse(readFileSync(MIGRATION, "utf8").split("$spec$")[1]) as SpecItem[];
const ORG = "org-ihome";
const allRows: CategoryRef[] = spec.map((s, i) => ({
  id: s.k,
  name: s.n,
  category: s.g,
  type: "expense",
  organization_id: ORG,
  description: s.d,
  keywords: s.kw ?? [],
  rule_key: s.k,
  manual_hidden: s.hid ?? false,
  quick_entry_hidden: s.qeh ?? false,
  sort_order: (i + 1) * 10,
}));
const rows = usableExpenseCategories(allRows, { organizationId: ORG, canUseRestricted: false });

// Fixture: 414 mô tả phiếu chi thật (02/10/2026), đã bỏ số tiền cuối câu, bỏ mục hạn chế/máy tự lập,
// tên người đã thay bằng tên chung, địa chỉ toà thay bằng mã toà, tên phường thay bằng "phường X/Y"
// (không đổi kết quả đo). `gold` = rule_key chủ duyệt; `alt` = mục
// cũng chấp nhận được.
describe("ruleCategory — 414 câu chi thật (02/10/2026)", () => {
  const cases = cauThat as Array<{ text: string; gold: string; alt?: string[] }>;
  const locks = cases
    .map((c) => ({ c, got: ruleCategory(rows, c.text)?.rule_key ?? null }))
    .filter((x) => x.got !== null);
  const wrong = locks.filter((x) => x.got !== x.c.gold && !(x.c.alt ?? []).includes(x.got as string));

  // Đo 04/10/2026 (sau hai lượt siết luật dòng tiền theo review): chốt 293/414 câu (71%), sai 0. Đây là đo
  // TRÊN CHÍNH bộ câu dùng để viết luật — độ đúng với câu mới do bộ câu phủ định bên dưới canh thêm.
  it("chốt đúng ≥ 99% số câu nó chốt", () => {
    const precision = (locks.length - wrong.length) / locks.length;
    const misses = wrong.map((x) => `${x.c.text} ⇒ ${x.got} (đúng: ${x.c.gold})`).join("\n");
    expect(precision, misses).toBeGreaterThanOrEqual(0.99);
  });

  it("chốt được ≥ 70% câu (phần còn lại mới gọi AI)", () => {
    expect(locks.length / cases.length).toBeGreaterThanOrEqual(0.7);
  });
});

describe("ruleCategory — ca dễ nhầm", () => {
  const pick = (text: string) => ruleCategory(rows, text)?.rule_key ?? null;

  it("luật chủ đặt", () => {
    expect(pick("vệ sinh tòa nhà 512tc")).toBe("don_ve_sinh");
    expect(pick("bTaskee dọn phòng 302")).toBe("don_ve_sinh");
    expect(pick("thay acquy cửa vân tay 512")).toBe("camera_wifi_van_tay");
    expect(pick("mua ổ điện và tắc kê để gắn camera khu shipper")).toBe("camera_wifi_van_tay");
    expect(pick("in hai cuốn phương án pccc")).toBe("pccc");
    expect(pick("Tiền CAP15 T6,7 403 405")).toBe("cong_an");
    expect(pick("Lót người nước ngoài")).toBe("tam_tru_giay_to");
    expect(pick("Kết tiền resident")).toBe("noi_bo");
    expect(pick("chuyển tiền nhà dùm a Huy")).toBe("noi_bo");
    expect(pick("trả lại cọc cho khách của best choice")).toBe("bo_sung_hoan_coc");
    expect(pick("TIỀN PHÒNG 5 NGÀY")).toBe("tra_tien_thua_khach");
  });

  it("dòng tiền thắng vệ sinh: hoàn cọc có chữ 'vệ sinh phòng'", () => {
    expect(pick("Bổ sung hoàn cọc do khách tự vệ sinh phòng")).toBe("bo_sung_hoan_coc");
  });

  it("vệ sinh máy lạnh / bồn nước không vào dọn vệ sinh", () => {
    expect(pick("thợ qua vệ sinh máy lạnh 3 phòng")).not.toBe("don_ve_sinh");
    expect(pick("vệ sinh 2 bồn nước sân thượng")).not.toBe("don_ve_sinh");
  });

  it("cước wifi tháng là internet, không phải thiết bị", () => {
    expect(pick("tiền wifi tháng 9 FPT")).not.toBe("camera_wifi_van_tay");
  });

  it("so có dấu: 'vật tư' không khớp 'tủ', 'nem nướng' không khớp 'nệm'", () => {
    expect(pick("mua vật tư 632k")).not.toBe("noi_that_decor");
    expect(pick("Nem nướng Nha Trang")).not.toBe("noi_that_decor");
  });

  it("'tiền điện lạnh' không chốt Đóng tiền điện", () => {
    expect(pick("thanh toán tiền điện lạnh T6")).not.toBe("dien");
    expect(suggestCategory(rows, "thanh toán tiền điện lạnh T6")?.id ?? null).not.toBe("dien");
  });

  it("gõ không dấu cụm hai chữ vẫn nhận", () => {
    expect(pick("tien nha thang 10 512tc")).toBe("tien_nha");
    expect(pick("danh 2 chia khoa phong 304")).toBe("khoa_chia");
  });

  // Câu phủ định (review độc lập PR #118 chạy thử ra sai): khoản chi THẬT không được chốt vào mục dòng
  // tiền — "Chuyển tiền nội bộ" ép INTERNAL làm khoản chi biến khỏi KQKD.
  it.each([
    "dọn vệ sinh bàn giao phòng 302",
    "sửa điện trước khi bàn giao phòng",
    "bàn giao phòng 302 thay ổ khoá",
    "ứng tiền cho anh thợ sửa máy lạnh",
    "Tạm ứng cho anh thợ hồ 2tr",
    "Kết tiền điện nước tháng 9 cho chủ nhà",
    "đóng tiền căn hộ 302",
    "chuyển hộ khẩu cho khách",
    // Re-review lượt 2: gõ không dấu đi vòng qua loại trừ; "ứng … cho" người ngoài.
    "ban giao tien nha cho chu nha",
    "ban giao tien dien cho chu nha 417",
    "ung tien cho anh tho son",
    "ứng cho cô dọn vệ sinh 200k",
    "ứng tiền cho cô lao công",
    "ứng cho chú bảo vệ tháng 10",
    "ứng tiền cho chú Định làm thang thoát hiểm",
    "ứng cho anh Tuấn điện lạnh 500k",
    "ứng cho anh Hùng sơn nước",
    "ứng tiền cho a Long sửa máy bơm",
    "bàn giao tiền điện cho EVN",
    "bàn giao cô dọn phòng 302",
  ])("không chốt nội bộ: %s", (text) => {
    expect(pick(text)).not.toBe("noi_bo");
  });

  it.each([
    ["ca phe cho tho dien", "cong_an"],
    ["ca trực đêm bảo vệ", "cong_an"],
    ["gia hạn cap 6 tháng", "cong_an"],
    ["mua giấy vệ sinh", "don_ve_sinh"],
    ["chống thấm nhà vệ sinh 302", "don_ve_sinh"],
    ["thay vòi xịt vệ sinh phòng 201", "don_ve_sinh"],
    ["đóng dư tiền điện tháng 9", "tra_tien_thua_khach"],
    ["trả cọc chủ nhà 512", "bo_sung_hoan_coc"],
    ["trả cọc thợ hồ", "bo_sung_hoan_coc"],
    ["mua trà cốc", "bo_sung_hoan_coc"],
    ["tra lai coc cho chu nha", "bo_sung_hoan_coc"],
    ["hoan coc cho tho son", "bo_sung_hoan_coc"],
    ["trả lại cọc nhà cho chủ 417", "bo_sung_hoan_coc"],
    ["trả cọc thuê nhà mới", "bo_sung_hoan_coc"],
    ["ca 2 bảo vệ", "cong_an"],
    ["tiền ca 3 trực", "cong_an"],
    ["tiền ca t9 bảo vệ", "cong_an"],
    ["thối tiền ship", "tra_tien_thua_khach"],
  ])("không chốt nhầm: %s ≠ %s", (text, key) => {
    expect(pick(text)).not.toBe(key);
  });

  it("gõ không dấu cả câu vẫn nhận luật dòng tiền", () => {
    expect(pick("hoan coc 402 1392qt")).toBe("bo_sung_hoan_coc");
    expect(pick("ket tien so quy thang 5")).toBe("noi_bo");
  });

  it("không chắc thì null", () => {
    expect(pick("T6, T7")).toBeNull();
    expect(pick("")).toBeNull();
  });

  it("luật trỏ tới mục không có trong danh sách thì bỏ qua", () => {
    const noCongAn = rows.filter((r) => r.rule_key !== "cong_an");
    expect(ruleCategory(noCongAn, "tiền công an tháng 9-10")?.rule_key ?? null).not.toBe("cong_an");
  });
});

describe("usableExpenseCategories — danh mục chuẩn", () => {
  it("ẩn mục lưu trữ, ẩn tay, ẩn khỏi Báo chi nhanh; giữ thứ tự danh mục", () => {
    const keys = rows.map((r) => r.rule_key);
    expect(keys).not.toContain("ve_sinh_dinh_ky");
    expect(keys).not.toContain("hoa_hong_moi_gioi");
    expect(keys).not.toContain("hhmg");
    expect(keys.indexOf("tien_nha")).toBeLessThan(keys.indexOf("dien_lanh"));
    const archived = usableExpenseCategories(
      [{ ...allRows[0], id: "cu", archived_at: "2026-10-03T00:00:00Z" }],
      { organizationId: ORG, canUseRestricted: true },
    );
    expect(archived).toEqual([]);
  });
});
