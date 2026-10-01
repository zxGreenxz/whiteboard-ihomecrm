import { describe, it, expect } from "vitest";
import { draftFromBill, draftsFromText, enrichFromAi, markTouched, syncName, type ComposeContext } from "../compose";
import type { AiResult } from "../aiSchema";
import type { CategoryRef } from "../categorySuggest";

const O = "org";
const categories: CategoryRef[] = [
  { id: "t-dien", name: "Tiền điện", category: "Điện", type: "expense", organization_id: O, fee_category: "dien" },
  { id: "t-sua", name: "Sửa chữa điện", category: "Bảo Trì", type: "expense", organization_id: O },
  { id: "t-vt", name: "Vật tư", category: "Bảo Trì", type: "expense", organization_id: O },
];

let seq = 0;
const ctx = (over: Partial<ComposeContext> = {}): ComposeContext => ({
  today: "2026-10-01",
  mode: "company",
  refs: {
    buildings: [
      { id: "b102", name: "Toà 102 Lê Văn Thọ", code: "102LVT" },
      { id: "b405", name: "405 Phan Văn Bảy", code: "405PVB" },
    ],
    rooms: [{ id: "r301", name: "301", code: null, building_id: "b102" }],
    feeAccounts: [{ building_id: "b405", fee_category: "dien", provider_code: "PE07000123456" }],
  },
  categories,
  newId: () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
  defaultAccountFor: (b) => (b ? `acc-${b}` : null),
  ...over,
});

const ai = (over: Partial<AiResult> = {}): AiResult => ({
  items: [],
  total_vnd: null,
  date: null,
  vendor: null,
  building_mention: null,
  room_mention: null,
  customer_code: null,
  period_start: null,
  period_end: null,
  ...over,
});

describe("draftsFromText", () => {
  it("một câu ⇒ một thẻ đủ toà, phòng, sổ, hạng mục, tiền, mô tả bỏ phần số tiền", () => {
    const [s] = draftsFromText("sửa điện 102LVT p301 350k", ctx());
    expect(s.draft).toMatchObject({
      mode: "company",
      date: "2026-10-01",
      buildingId: "b102",
      roomId: "r301",
      accountId: "acc-b102",
      lines: [{ amount: 350_000, categoryId: "t-sua", description: "sửa điện 102LVT p301" }],
    });
    expect(s.flags).toEqual([]);
  });

  it("nhiều khoản cùng toà ⇒ một thẻ nhiều dòng; khác toà ⇒ thẻ riêng", () => {
    const same = draftsFromText("102LVT bóng đèn 60k, ống nước 80k", ctx());
    expect(same).toHaveLength(1);
    expect(same[0].draft.lines.map((l) => l.amount)).toEqual([60_000, 80_000]);

    const split = draftsFromText("bóng đèn 102LVT 60k; sơn 405PVB 300k", ctx());
    expect(split.map((s) => [s.draft.buildingId, s.draft.lines.map((l) => l.amount)])).toEqual([
      ["b102", [60_000]],
      ["b405", [300_000]],
    ]);
  });

  it("phòng nói một lần áp cho các khoản cùng toà", () => {
    const [s] = draftsFromText("102LVT p301: bóng đèn 60k\nống nước 80k", ctx());
    expect([s.draft.buildingId, s.draft.roomId, s.draft.lines.length]).toEqual(["b102", "r301", 2]);
  });

  it("phòng của toà này không gán sang khoản thuộc toà khác", () => {
    const states = draftsFromText("102LVT p301 bóng đèn 60k; sơn 405PVB 300k", ctx());
    expect(states.map((s) => [s.draft.buildingId, s.draft.roomId])).toEqual([
      ["b102", "r301"],
      ["b405", null],
    ]);
  });

  it("khoản tự nhắc một phòng (dù không tìm ra) không thừa hưởng phòng của khoản khác", () => {
    const states = draftsFromText("102LVT p301 bóng đèn 60k; p999 sơn 300k", ctx());
    expect(states.map((s) => [s.draft.buildingId, s.draft.roomId])).toEqual([
      ["b102", "r301"],
      ["b102", null],
    ]);
  });

  it("toà nói một lần áp cho mọi khoản không tự nhắc toà", () => {
    const [s] = draftsFromText("102LVT: bóng đèn 60k\nống nước 80k", ctx());
    expect(s.draft.buildingId).toBe("b102");
    expect(s.draft.lines).toHaveLength(2);
  });

  it("ngày và kỳ đọc được thì dùng; kỳ áp cho các dòng", () => {
    const [s] = draftsFromText("hôm qua trả tiền điện tháng 9 405PVB 1tr2", ctx());
    expect(s.draft.date).toBe("2026-09-30");
    expect(s.draft.lines[0]).toMatchObject({ categoryId: "t-dien", periodStart: "2026-09-01", periodEnd: "2026-09-30" });
  });

  it("gắn cờ: thiếu tiền, số trần nhỏ, số mơ hồ, phải chọn toà", () => {
    expect(draftsFromText("102LVT mua sơn", ctx())[0].flags).toContain("missing_amount");
    expect(draftsFromText("102LVT gửi xe 5000", ctx())[0].flags).toContain("small_amount");
    expect(draftsFromText("102LVT mua 2 đèn 120", ctx())[0].flags).toContain("ambiguous_amount");
    const choice = draftsFromText("102LVT hay 405PVB sơn 300k", ctx())[0];
    expect(choice.flags).toContain("building_choice");
    expect(choice.buildingCandidates.sort()).toEqual(["b102", "b405"]);
    expect(choice.draft.buildingId).toBeNull();
  });

  it("chế độ cá nhân: một thẻ, không toà, không sổ, không hạng mục công ty", () => {
    const states = draftsFromText("bún bò 50k, cà phê 30k", ctx({ mode: "personal" }));
    expect(states).toHaveLength(1);
    expect(states[0].draft).toMatchObject({ mode: "personal", buildingId: null, accountId: null });
    expect(states[0].draft.lines.map((l) => [l.amount, l.categoryId])).toEqual([
      [50_000, null],
      [30_000, null],
    ]);
  });

  it("mỗi thẻ một id riêng (khoá chống trùng riêng)", () => {
    const ids = draftsFromText("bóng đèn 102LVT 60k; sơn 405PVB 300k", ctx()).map((s) => s.draft.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("chữ rỗng ⇒ không thẻ nào", () => {
    expect(draftsFromText("   ", ctx())).toEqual([]);
  });
});

describe("enrichFromAi — AI chỉ điền ô còn trống", () => {
  it("điền hạng mục còn trống theo chỉ số cN đã gửi; KHÔNG đè số tiền đã gõ", () => {
    const [s] = draftsFromText("102LVT mua đồ 350k", ctx());
    expect(s.draft.lines[0].categoryId).toBeNull();
    const out = enrichFromAi(s, ai({ items: [{ desc: "đồ", amount_vnd: 999_000, category: "c3", confidence: 0.8 }] }), ctx());
    expect(out.draft.lines[0]).toMatchObject({ categoryId: "t-vt", amount: 350_000 });
  });

  it("AI trả số tiền ÂM cho dòng thiếu tiền ⇒ không điền (dòng vẫn báo thiếu tiền)", () => {
    const [s] = draftsFromText("102LVT giảm giá", ctx());
    const out = enrichFromAi(s, ai({ items: [{ desc: "giảm giá", amount_vnd: -5_000, category: null, confidence: 0.7 }] }), ctx());
    expect(out.draft.lines[0].amount).toBe(0);
    expect(out.flags).toContain("missing_amount");
  });

  it("điền số tiền còn thiếu khi AI trả đúng số dòng", () => {
    const [s] = draftsFromText("102LVT mua sơn", ctx());
    const out = enrichFromAi(s, ai({ items: [{ desc: "sơn", amount_vnd: 300_000, category: null, confidence: 0.7 }] }), ctx());
    expect(out.draft.lines[0].amount).toBe(300_000);
    expect(out.flags).not.toContain("missing_amount");
  });

  it("AI cũng không ra số ⇒ cờ thiếu tiền vẫn còn", () => {
    const [s] = draftsFromText("102LVT mua sơn", ctx());
    expect(enrichFromAi(s, ai(), ctx()).flags).toContain("missing_amount");
  });

  it("toà đã nói rõ trong chữ ⇒ AI không đổi toà", () => {
    const [s] = draftsFromText("102LVT sơn 300k", ctx());
    expect(enrichFromAi(s, ai({ building_mention: "405PVB" }), ctx()).draft.buildingId).toBe("b102");
  });

  it("hạng mục theo cụm phí là chắc ⇒ AI không đè; hạng mục đoán theo trùng từ ⇒ AI được thay", () => {
    const [fee] = draftsFromText("102LVT tiền điện 1tr2", ctx());
    expect(fee.draft.lines[0].categoryId).toBe("t-dien");
    const aiVt = ai({ items: [{ desc: "x", amount_vnd: null, category: "c3", confidence: 0.9 }] });
    expect(enrichFromAi(fee, aiVt, ctx()).draft.lines[0].categoryId).toBe("t-dien");

    const [weak] = draftsFromText("sửa điện 102LVT 350k", ctx());
    expect(weak.draft.lines[0].categoryId).toBe("t-sua");
    expect(enrichFromAi(weak, aiVt, ctx()).draft.lines[0].categoryId).toBe("t-vt");
  });

  it("điền người nhận và phòng (trong toà đã có) từ AI khi còn trống", () => {
    const [s] = draftsFromText("mua sơn 300k", ctx());
    const out = enrichFromAi(s, ai({ building_mention: "102LVT", room_mention: "301", vendor: "Sơn Hải" }), ctx());
    expect(out.draft).toMatchObject({ buildingId: "b102", roomId: "r301", vendor: "Sơn Hải" });
  });

  it("chế độ cá nhân: AI chọn danh mục cá nhân theo chỉ số", () => {
    const pctx = ctx({ mode: "personal", personalCategories: ["Ăn uống", "Đi lại"] });
    const [s] = draftsFromText("grab 45k", pctx);
    const out = enrichFromAi(s, ai({ items: [{ desc: "grab", amount_vnd: null, category: "c2", confidence: 0.9 }] }), pctx);
    expect(out.draft.lines[0].personalCategory).toBe("Đi lại");
  });

  it("không đè ô người dùng đã sửa", () => {
    const [s] = draftsFromText("mua đồ 350k", ctx());
    const touched = markTouched({ ...s, draft: { ...s.draft, lines: [{ ...s.draft.lines[0], categoryId: "t-sua" }] } }, "lines.0.categoryId");
    const out = enrichFromAi(touched, ai({ items: [{ desc: "đồ", amount_vnd: null, category: "c3", confidence: 0.9 }] }), ctx());
    expect(out.draft.lines[0].categoryId).toBe("t-sua");
  });

  it("toà còn trống ⇒ tra chuỗi nhắc của AI bằng bộ dò cục bộ; AI bịa tên thì bỏ", () => {
    const [s] = draftsFromText("mua sơn 300k", ctx());
    expect(enrichFromAi(s, ai({ building_mention: "102LVT" }), ctx()).draft).toMatchObject({ buildingId: "b102", accountId: "acc-b102" });
    expect(enrichFromAi(s, ai({ building_mention: "Toà 999" }), ctx()).draft.buildingId).toBeNull();
  });

  it("ngày AI chỉ dùng khi chữ không nói ngày và không phải ngày tương lai", () => {
    const [plain] = draftsFromText("102LVT sơn 300k", ctx());
    expect(enrichFromAi(plain, ai({ date: "2026-09-28" }), ctx()).draft.date).toBe("2026-09-28");
    expect(enrichFromAi(plain, ai({ date: "2026-10-05" }), ctx()).draft.date).toBe("2026-10-01");
    const [dated] = draftsFromText("hôm qua 102LVT sơn 300k", ctx());
    expect(enrichFromAi(dated, ai({ date: "2026-09-28" }), ctx()).draft.date).toBe("2026-09-30");
  });
});

describe("draftFromBill — ảnh hoá đơn", () => {
  const bill = ai({
    items: [
      { desc: "Bóng LED 9W", amount_vnd: 90_000, category: "c3", confidence: 0.9 },
      { desc: "Băng keo điện", amount_vnd: 15_000, category: "c3", confidence: 0.8 },
    ],
    total_vnd: 105_000,
    date: "2026-09-29",
    vendor: "Điện nước Minh Phát",
    building_mention: "102LVT",
  });

  it("dòng theo từng món, cửa hàng thành người nhận, ngày hoá đơn, toà theo chuỗi nhắc", () => {
    const s = draftFromBill(bill, ctx());
    expect(s.source).toBe("photo");
    expect(s.draft).toMatchObject({ date: "2026-09-29", vendor: "Điện nước Minh Phát", buildingId: "b102", accountId: "acc-b102" });
    expect(s.draft.lines.map((l) => [l.description, l.amount, l.categoryId])).toEqual([
      ["Bóng LED 9W", 90_000, "t-vt"],
      ["Băng keo điện", 15_000, "t-vt"],
    ]);
    expect(s.flags).toEqual([]);
  });

  it("tổng dòng lệch tổng thực trả (ship, giảm giá) ⇒ gộp một dòng = số thực trả + cờ kiểm lại", () => {
    const s = draftFromBill({ ...bill, total_vnd: 98_000 }, ctx());
    expect(s.draft.lines.map((l) => l.amount)).toEqual([98_000]);
    expect(s.draft.lines[0].description).toContain("Bóng LED 9W");
    expect(s.draft.lines[0].categoryId).toBe("t-vt");
    expect(s.flags).toContain("check_total");
  });

  it("mã khách hàng trên bill điện ⇒ toà + hạng mục phí điện + kỳ", () => {
    const s = draftFromBill(
      ai({
        items: [{ desc: "Tiền điện kỳ 9", amount_vnd: 1_200_000, category: null, confidence: 0.9 }],
        total_vnd: 1_200_000,
        customer_code: "PE07000123456",
        period_start: "2026-09-01",
        period_end: "2026-09-30",
      }),
      ctx(),
    );
    expect(s.draft.buildingId).toBe("b405");
    expect(s.draft.lines[0]).toMatchObject({ categoryId: "t-dien", periodStart: "2026-09-01", periodEnd: "2026-09-30" });
  });

  it("ảnh không đọc được ⇒ thẻ trống báo thiếu tiền", () => {
    const s = draftFromBill(ai(), ctx());
    expect(s.draft.lines).toHaveLength(1);
    expect(s.draft.lines[0].amount).toBe(0);
    expect(s.flags).toContain("missing_amount");
  });

  it("bill có dòng GIẢM GIÁ âm ⇒ một dòng = số thực trả + cờ kiểm lại; mô tả không gồm dòng âm", () => {
    const s = draftFromBill(
      ai({
        items: [
          { desc: "Bóng LED 9W x2", amount_vnd: 90_000, category: "c3", confidence: 0.99 },
          { desc: "Băng keo điện", amount_vnd: 15_000, category: "c3", confidence: 0.99 },
          { desc: "Phí giao hàng", amount_vnd: 10_000, category: null, confidence: 0.99 },
          { desc: "Giảm giá", amount_vnd: -5_000, category: null, confidence: 0.99 },
        ],
        total_vnd: 110_000,
        vendor: "Minh Phát",
      }),
      ctx(),
    );
    expect(s.draft.lines).toHaveLength(1);
    expect(s.draft.lines[0].amount).toBe(110_000);
    expect(s.draft.lines[0].description).not.toContain("Giảm giá");
    expect(s.flags).toContain("check_total");
  });

  it("ngày hoá đơn tương lai ⇒ lấy hôm nay", () => {
    expect(draftFromBill({ ...bill, date: "2026-12-01" }, ctx()).draft.date).toBe("2026-10-01");
  });
});

describe("sourceText — đoạn câu dựng nên thẻ (để gọi AI RIÊNG từng thẻ)", () => {
  it("tin nhắc hai toà ⇒ mỗi thẻ chỉ mang đoạn câu của mình", () => {
    const cards = draftsFromText("102LVT sơn 300k; 405PVB keo 20k", ctx());
    expect(cards).toHaveLength(2);
    const of102 = cards.find((c) => c.draft.buildingId === "b102")!;
    const of405 = cards.find((c) => c.draft.buildingId === "b405")!;
    expect(of102.sourceText).toContain("sơn 300k");
    expect(of102.sourceText).not.toContain("keo");
    expect(of405.sourceText).toContain("keo 20k");
    expect(of405.sourceText).not.toContain("sơn");
  });

  it("đoạn câu xen kẽ toà ⇒ thẻ gom đúng đoạn, giữ thứ tự dòng", () => {
    const cards = draftsFromText("102LVT sơn 300k; 405PVB keo 20k; 102LVT chổi 15k", ctx());
    const of102 = cards.find((c) => c.draft.buildingId === "b102")!;
    expect(of102.draft.lines.map((l) => l.amount)).toEqual([300_000, 15_000]);
    expect(of102.sourceText).toBe("102LVT sơn 300k; 102LVT chổi 15k");
  });

  it("giữ nguyên chữ hoa người dùng gõ trong mô tả, tên phiếu và đoạn câu", () => {
    const [s] = draftsFromText("102LVT mua Bóng LED Rạng Đông 90k", ctx());
    expect(s.draft.lines[0].description).toBe("102LVT mua Bóng LED Rạng Đông");
    expect(s.draft.name).toBe("102LVT mua Bóng LED Rạng Đông");
    expect(s.sourceText).toBe("102LVT mua Bóng LED Rạng Đông 90k");
  });

  it("chữ tổ hợp (NFD, bàn phím Mac) ⇒ mô tả ra dạng dựng sẵn (NFC), không vỡ dấu", () => {
    const [s] = draftsFromText("Sơn tường 300k".normalize("NFD"), ctx({ mode: "personal" }));
    expect(s.draft.lines[0].description).toBe("Sơn tường".normalize("NFC"));
    expect(s.draft.lines[0].amount).toBe(300_000);
  });

  it("ký tự đổi độ dài khi hạ chữ thường (İ) ⇒ dùng bản chữ thường, mô tả và tiền không lệch vị trí", () => {
    const [s] = draftsFromText("Ống İnox 50k", ctx({ mode: "personal" }));
    expect(s.draft.lines[0].description).toBe("Ống İnox".toLowerCase());
    expect(s.draft.lines[0].amount).toBe(50_000);
  });

  it("thẻ từ ảnh ⇒ không có đoạn câu (AI đã đọc ảnh)", () => {
    expect(draftFromBill(ai({ total_vnd: 50_000 }), ctx()).sourceText).toBe("");
  });
});

describe("syncName — tên phiếu đi theo nội dung đang hiện trên thẻ", () => {
  const withLine0 = (s: ReturnType<typeof draftsFromText>[number], description: string) => ({
    ...s,
    draft: { ...s.draft, lines: s.draft.lines.map((l, i) => (i === 0 ? { ...l, description } : l)) },
  });

  it("thẻ chữ: sửa mô tả ⇒ tên phiếu đổi theo (không còn giữ chữ cũ)", () => {
    const [s] = draftsFromText("bún bò 50k", ctx({ mode: "personal" }));
    expect(syncName(withLine0(s, "cơm tấm")).draft.name).toBe("cơm tấm");
  });

  it("thẻ chữ có cửa hàng (gõ ở thẻ hoặc AI điền) ⇒ tên vẫn theo mô tả, cửa hàng chỉ là người nhận", () => {
    const [s] = draftsFromText("102LVT mua sơn 300k", ctx());
    const enriched = enrichFromAi(
      s,
      ai({ items: [{ desc: "sơn", amount_vnd: 300_000, category: null, confidence: 0.9 }], vendor: "Minh Phát" }),
      ctx(),
    );
    expect(enriched.draft.vendor).toBe("Minh Phát");
    expect(syncName(enriched).draft.name).toBe(s.draft.name);
  });

  it("thẻ chữ nhiều dòng: tên ghép mọi mô tả", () => {
    const [s] = draftsFromText("102LVT sơn 300k, keo 20k", ctx());
    expect(syncName(withLine0(s, "sơn nước")).draft.name).toBe("sơn nước; keo");
  });

  it("bill có cửa hàng: tên là cửa hàng, sửa dòng không đổi tên; sửa cửa hàng thì đổi theo", () => {
    const s = draftFromBill(
      ai({ items: [{ desc: "Bóng LED", amount_vnd: 90_000, category: null, confidence: 0.9 }], total_vnd: 90_000, vendor: "Minh Phát" }),
      ctx(),
    );
    expect(syncName(withLine0(s, "Bóng LED 9W")).draft.name).toBe("Minh Phát");
    expect(syncName({ ...s, draft: { ...s.draft, vendor: "Điện nước Minh Phát" } }).draft.name).toBe("Điện nước Minh Phát");
    expect(syncName({ ...s, draft: { ...s.draft, vendor: null } }).draft.name).toBe("Bóng LED");
  });

  it("thẻ vừa dựng ⇒ trả lại đúng object cũ (không render thừa)", () => {
    const fresh = [
      ...draftsFromText("102LVT sơn 300k, keo 20k; bún bò 50k", ctx()),
      draftFromBill(ai({ items: [{ desc: "Cà phê", amount_vnd: 30_000, category: null, confidence: 0.9 }], total_vnd: 30_000 }), ctx()),
      draftFromBill(ai({ items: [], total_vnd: 50_000, vendor: "Bách hoá" }), ctx()),
    ];
    for (const s of fresh) expect(syncName(s)).toBe(s);
  });
});
