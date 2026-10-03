import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ruleCategory, ruleMatch } from "../categoryRules";
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

  // Đo 04/10/2026 (sau hai lượt siết luật dòng tiền theo review): chọn 293/414 câu (71%; 1 câu chỉ gợi ý yếu), sai 0; đầu-cuối khoá 292, sai 0. Đây là đo
  // TRÊN CHÍNH bộ câu dùng để viết luật — độ đúng với câu mới do bộ câu phủ định bên dưới canh thêm.
  it("chốt đúng ≥ 99% số câu nó chốt", () => {
    const precision = (locks.length - wrong.length) / locks.length;
    const misses = wrong.map((x) => `${x.c.text} ⇒ ${x.got} (đúng: ${x.c.gold})`).join("\n");
    expect(precision, misses).toBeGreaterThanOrEqual(0.99);
  });

  // Đầu-cuối (review lượt 4): KHOÁ CỨNG qua mọi đường của suggestCategory — luật, cụm phí cố định, mã
  // khách hàng — chứ không chỉ lớp luật. Khoá sai thì AI không sửa được.
  it("khoá cứng đầu-cuối (luật + cụm phí) đúng ≥ 99%", () => {
    const LOCK = new Set(["rule", "fee_phrase", "provider_code"]);
    const locked = cases
      .map((c) => ({ c, s: suggestCategory(rows, c.text) }))
      .filter((x) => x.s && LOCK.has(x.s.reason));
    const bad = locked.filter((x) => x.s?.id !== x.c.gold && !(x.c.alt ?? []).includes(x.s?.id as string));
    const misses = bad.map((x) => `${x.c.text} ⇒ ${x.s?.id} (${x.s?.reason}; đúng: ${x.c.gold})`).join("\n");
    expect((locked.length - bad.length) / locked.length, misses).toBeGreaterThanOrEqual(0.99);
  });

  it("cụm phí cố định áp cùng loại trừ với lớp luật", () => {
    expect(suggestCategory(rows, "in giấy hợp đồng thuê nhà cho a Khôi")?.id ?? null).not.toBe("tien_nha");
    expect(suggestCategory(rows, "mua keo dán nút nhấn thang máy")?.id ?? null).not.toBe("thang_may");
    expect(suggestCategory(rows, "tiền nhà tháng 10 512TT")?.id).toBe("tien_nha");
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

  // Re-review lượt 3: loại trừ không bao giờ đủ ⇒ nội bộ / hoàn cọc chỉ KHOÁ CỨNG khi có neo chắc chắn.
  const strongKey = (text: string) => {
    const m = ruleMatch(rows, text);
    return m && m.strong ? m.ref.rule_key : null;
  };

  it.each([
    "bàn giao tiền cho anh Hùng nhà thầu",
    "bàn giao tiền cho đội xây dựng",
    "ban giao tien cho doi xay dung",
    "bàn giao tiền cho công ty vệ sinh",
    "bàn giao tiền cho nhà cung cấp",
    "bàn giao tiền cho bên điện lực",
    "bàn giao tiền nước cho công ty cấp nước",
    "chi hộ chị Hoa tiền đổ rác 417",
    "đóng hộ chị Lan tiền internet toà 417",
    "chi hộ anh Vinh tiền mua bóng đèn",
    "chi hộ anh Vinh mua vật tư điện nước",
  ])("không KHOÁ nội bộ (AI được thay): %s", (text) => {
    expect(strongKey(text)).not.toBe("noi_bo");
  });

  it.each([
    "trả cọc cho đội thi công",
    "trả cọc lắp camera",
    "hoàn cọc công tơ",
    "trả cọc bình nước",
    "trả cọc thuê xe tải chở đồ",
  ])("không KHOÁ hoàn cọc khách: %s", (text) => {
    expect(strongKey(text)).not.toBe("bo_sung_hoan_coc");
  });

  it.each(["thối tiền thợ", "thoi tien tho", "tiền phòng 2 ngày thợ ở", "hoàn tiền phòng cho thợ ở tạm"])(
    "không chốt trả tiền thừa khách: %s",
    (text) => {
      expect(pick(text)).not.toBe("tra_tien_thua_khach");
    },
  );

  it("neo chắc chắn thì vẫn KHOÁ", () => {
    expect(strongKey("kết sổ quỹ tháng 9")).toBe("noi_bo");
    expect(strongKey("ket so quy lam thu T5")).toBe("noi_bo");
    expect(strongKey("bàn giao tiền về sổ quỹ Vinh thu")).toBe("noi_bo");
    expect(strongKey("Kết tiền resident")).toBe("noi_bo");
    expect(strongKey("hoàn cọc khách 205-1392qt")).toBe("bo_sung_hoan_coc");
    expect(strongKey("hoàn cọc 402-1392qt")).toBe("bo_sung_hoan_coc");
    expect(strongKey("hoàn trả cọc sau trừ chi phí thanh lý hđ")).toBe("bo_sung_hoan_coc");
  });

  it("thiếu neo thì vẫn GỢI Ý nội bộ (không khoá)", () => {
    expect(ruleMatch(rows, "bàn giao tiền cho chủ")).toMatchObject({ strong: false, ref: { rule_key: "noi_bo" } });
    expect(ruleMatch(rows, "chi hộ chị Hoa tiền đổ rác 417")).toMatchObject({ strong: false });
    expect(pick("chuyen tien nha dum a Vinh")).toBe("noi_bo");
  });

  // Re-review lượt 4: mẫu chủ thật sự hay ghi phải giữ KHOÁ; neo của hoàn cọc không bắt "khách sạn", "hợp đồng thuê kho".
  it.each([
    "bàn giao tiền anh Vinh",
    "bàn giao tiền cho anh Vinh",
    "Bàn Giao Tiền anh Khôi",
    "bàn giao anh Vinh",
    "bàn giao tiền 45TTT cho a Khôi",
    "chuyển tiền nhà dùm a Vinh",
  ])("câu bàn giao chuẩn vẫn KHOÁ nội bộ: %s", (text) => {
    expect(strongKey(text)).toBe("noi_bo");
  });

  // Re-review lượt 5: mẫu "chuyển/chi/đóng tiền X dùm <người>" chỉ khoá khi X là "nhà".
  it.each([
    "chuyển tiền điện dùm a Long",
    "chuyển tiền nước giùm chị Mai",
    "đóng tiền rác hộ anh Vinh",
    "chuyển tiền camera dùm a Long",
    "chuyển tiền công dùm anh Hùng",
    "chi tiền xăng hộ em Tuấn",
    "chuyển tiền gas hộ chị Lan",
    "chuyển tiền cọc dùm a Long",
  ])("chuyển/chi tiền khoản khác dùm người ⇒ KHÔNG khoá nội bộ: %s", (text) => {
    expect(strongKey(text)).not.toBe("noi_bo");
  });

  it.each([
    ["bổ sung tiền mua đồ", "bo_sung_hoan_coc"],
    ["hoàn tiền cho anh Hùng", "bo_sung_hoan_coc"],
    ["trả tiền cho khách", "tra_tien_thua_khach"],
    ["tiền nội bộ", "noi_bo"],
  ])("đoán trùng chữ vào hạng mục dòng tiền ⇒ rule_weak (không điền sẵn): %s", (text, id) => {
    expect(suggestCategory(rows, text)).toEqual({ id, reason: "rule_weak" });
  });

  it("'tiền nhà căn hộ 302' vẫn là Tiền nhà (loại trừ 'hộ <người>' không chặn 'căn hộ')", () => {
    expect(suggestCategory(rows, "tiền nhà căn hộ 302 tháng 10")?.id).toBe("tien_nha");
  });

  it.each([
    "kết sổ điện nước tháng 9",
    "kết sổ tiền rác",
    "kết sổ công an",
    "kết tiền quỹ đóng điện nước",
  ])("kết sổ kèm khoản chi chỉ là gợi ý: %s", (text) => {
    expect(strongKey(text)).not.toBe("noi_bo");
  });

  it.each([
    "trả cọc khách sạn",
    "trả cọc khách sạn đi du lịch công ty",
    "trả cọc tiệc liên hoan khách hàng",
    "trả cọc cho đối tác khách hàng",
    "trả cọc phòng 3 khách sạn",
    "trả cọc phòng 2 homestay team building",
    "trả cọc hợp đồng thuê kho",
    "trả cọc hợp đồng thuê mặt bằng",
    "trả cọc hợp đồng camera",
    "hoàn cọc hợp đồng internet",
    "trả cọc thanh lý máy giặt cũ",
  ])("không KHOÁ hoàn cọc khách: %s", (text) => {
    expect(strongKey(text)).not.toBe("bo_sung_hoan_coc");
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
