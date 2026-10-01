import { describe, it, expect } from "vitest";
import { resolveBuildingRoom, resolveBuildingMention, type ResolveRefs } from "../resolve";

const refs: ResolveRefs = {
  buildings: [
    { id: "b102", name: "Toà 102 Lê Văn Thọ", code: "102LVT" },
    { id: "b405", name: "405 Phan Văn Bảy", code: "405PVB, 405" },
    { id: "b15", name: "15 Kha Vạn Cân", code: "15KV" },
    { id: "bchung", name: "Chung", code: "CHUNG" },
  ],
  rooms: [
    { id: "r102-301", name: "301", code: null, building_id: "b102" },
    { id: "r102-302", name: "P302", code: null, building_id: "b102" },
    { id: "r405-301", name: "301", code: null, building_id: "b405" },
    { id: "r15-a1", name: "A1", code: null, building_id: "b15" },
  ],
  feeAccounts: [
    { building_id: "b405", fee_category: "dien", provider_code: "PE07000123456" },
    { building_id: "b15", fee_category: "nuoc", provider_code: "1234 5678" },
  ],
};

describe("resolveBuildingRoom — toà", () => {
  it.each([
    ["mua bóng đèn 102LVT 120k", "b102"],
    ["102lvt sửa vòi", "b102"],
    ["toà 405 tiền rác 300k", "b405"],
    ["405pvb rác", "b405"],
    ["15kv thay khoá", "b15"],
    ["chung mua giấy in", "bchung"],
  ])("%s → %s", (text, want) => {
    expect(resolveBuildingRoom(text, refs).building?.id).toBe(want);
  });

  it("tên toà nhiều từ gõ nguyên cụm (không dấu cũng được)", () => {
    const r = resolveBuildingRoom("sửa điện ở toa 102 le van tho", refs);
    expect(r.building).toEqual({ id: "b102", via: "name" });
  });

  it("mã khách hàng thuộc toà khác toà đã nhắc ⇒ hai ứng viên", () => {
    const r = resolveBuildingRoom("102lvt mã KH PE07000123456", refs);
    expect(r.building).toBeNull();
    expect(r.buildingCandidates.sort()).toEqual(["b102", "b405"]);
  });

  it("không nhắc toà ⇒ null", () => {
    expect(resolveBuildingRoom("ăn trưa 50k", refs).building).toBeNull();
  });

  it("nhắc hai toà khác nhau ⇒ không chọn, trả danh sách ứng viên", () => {
    const r = resolveBuildingRoom("102lvt và 15kv", refs);
    expect(r.building).toBeNull();
    expect(r.buildingCandidates.sort()).toEqual(["b102", "b15"]);
  });

  it("mã dính số tiền không phải mã toà: '405k' là tiền", () => {
    expect(resolveBuildingRoom("mua sơn 405k", refs).building).toBeNull();
  });
});

describe("resolveBuildingRoom — phòng", () => {
  it.each([
    ["102lvt p301 sửa vòi", "r102-301"],
    ["102lvt P.301", "r102-301"],
    ["102lvt phòng 301", "r102-301"],
    ["102lvt p302", "r102-302"],
    ["15kv phòng A1", "r15-a1"],
  ])("%s → %s", (text, want) => {
    expect(resolveBuildingRoom(text, refs).room?.id).toBe(want);
  });

  it("phòng không có trong toà đã nhắc ⇒ null, giữ toà", () => {
    const r = resolveBuildingRoom("15kv p301", refs);
    expect(r.building?.id).toBe("b15");
    expect(r.room).toBeNull();
  });

  it("chỉ nhắc phòng, tên phòng duy nhất trong công ty ⇒ suy ra toà", () => {
    const r = resolveBuildingRoom("p302 thay bóng đèn", refs);
    expect(r.room?.id).toBe("r102-302");
    expect(r.building?.id).toBe("b102");
  });

  it("chỉ nhắc phòng, tên trùng ở nhiều toà ⇒ không đoán", () => {
    const r = resolveBuildingRoom("p301 thay bóng đèn", refs);
    expect(r.room).toBeNull();
    expect(r.building).toBeNull();
  });

  it("roomMentioned: có chữ báo phòng (kể cả phòng không tồn tại) ⇒ true; không nhắc phòng ⇒ false", () => {
    expect(resolveBuildingRoom("102lvt p999 sơn", refs).roomMentioned).toBe(true);
    expect(resolveBuildingRoom("102lvt p999 sơn", refs).room).toBeNull();
    expect(resolveBuildingRoom("102lvt sơn", refs).roomMentioned).toBe(false);
  });

  it("'tn' / 'cả toà' ⇒ khoản cho cả toà", () => {
    expect(resolveBuildingRoom("102lvt tn tiền rác", refs).buildingWide).toBe(true);
    expect(resolveBuildingRoom("102lvt cả toà sơn lại", refs).buildingWide).toBe(true);
    expect(resolveBuildingRoom("102lvt p301", refs).buildingWide).toBe(false);
  });
});

describe("resolveBuildingRoom — mã khách hàng điện nước", () => {
  it("mã khách hàng trên bill ⇒ toà + hạng mục phí", () => {
    const r = resolveBuildingRoom("EVN mã KH PE07000123456 tiền điện kỳ 9", refs);
    expect(r.building?.id).toBe("b405");
    expect(r.building?.via).toBe("provider_code");
    expect(r.feeCategory).toBe("dien");
  });

  it("mã khách hàng rỗng hoặc quá ngắn (<6 ký tự) không bao giờ khớp", () => {
    const loose: ResolveRefs = {
      ...refs,
      feeAccounts: [
        { building_id: "b102", fee_category: "dien", provider_code: null },
        { building_id: "b15", fee_category: "nuoc", provider_code: "12" },
      ],
    };
    const r = resolveBuildingRoom("ăn trưa 12k", loose);
    expect(r.building).toBeNull();
    expect(r.feeCategory).toBeNull();
  });

  it("mã có khoảng trắng vẫn khớp", () => {
    const r = resolveBuildingRoom("mã khách hàng 12345678 nước", refs);
    expect(r.building?.id).toBe("b15");
    expect(r.feeCategory).toBe("nuoc");
  });
});

describe("resolveBuildingMention — chuỗi nhắc do AI trả về", () => {
  it.each([
    ["102LVT", "b102"],
    ["Toà 102 Lê Văn Thọ", "b102"],
    ["toa 102 le van tho", "b102"],
    ["405", "b405"],
  ])("%s → %s", (mention, want) => {
    expect(resolveBuildingMention(mention, refs.buildings)).toBe(want);
  });

  it("tên khớp hai toà ⇒ null (không đoán)", () => {
    const dup = [...refs.buildings, { id: "bchung2", name: "Chung", code: null }];
    expect(resolveBuildingMention("chung", dup)).toBeNull();
  });

  it("AI bịa tên không có ⇒ null", () => {
    expect(resolveBuildingMention("Toà 999 Nguyễn Huệ", refs.buildings)).toBeNull();
    expect(resolveBuildingMention("", refs.buildings)).toBeNull();
  });
});
