import { describe, expect, it } from "vitest";

import { normalizeForMatch, scoreBuilding, suggestBuilding, type BuildingCandidate } from "../buildingMatch";

// Tòa/địa chỉ bịa (repo công khai).
const buildings: BuildingCandidate[] = [
  { id: "b-405", name: "405XYZ", code: null, street_address: "405 Đường Số 9, Khu Phố 4" },
  { id: "b-8055", name: "Tòa A", code: "TA", street_address: "80/55 Đường số 3, Khu Phố 1" },
  { id: "b-331", name: "Tòa B", code: "TB,TB2", street_address: "331/70/101G Phan Huy Ích, khu phố 2" },
  { id: "b-12", name: "Tòa C", code: null, street_address: "12/3 Đường Số 1, Phường Giả" },
];

describe("normalizeForMatch", () => {
  it("bỏ dấu, đ→d, chữ thường, giữ [a-z0-9/], gộp khoảng trắng", () => {
    expect(normalizeForMatch("  331/70/101G   Phan Huy Ích, Khu phố 2 ")).toBe("331/70/101g phan huy ich khu pho 2");
    expect(normalizeForMatch("Đường số 3")).toBe("duong so 3");
    expect(normalizeForMatch(null)).toBe("");
  });
});

describe("suggestBuilding", () => {
  it("tên máy = tên tòa ⇒ 100", () => {
    expect(suggestBuilding("405XYZ", buildings)).toEqual({ buildingId: "b-405", score: 100 });
    expect(suggestBuilding("405xyz", buildings)).toEqual({ buildingId: "b-405", score: 100 });
  });

  it("tên máy = một trong các mã tòa (cách nhau dấu phẩy) ⇒ 100", () => {
    expect(suggestBuilding("TB2", buildings)).toEqual({ buildingId: "b-331", score: 100 });
  });

  it("tên máy = số nhà đầu địa chỉ ⇒ 90", () => {
    expect(suggestBuilding("80/55", buildings)).toEqual({ buildingId: "b-8055", score: 90 });
  });

  it("địa chỉ (trước dấu phẩy) bắt đầu bằng tên máy, khác dấu vẫn khớp ⇒ 90", () => {
    expect(suggestBuilding("331/70/101G Phan Huy Ich", buildings)).toEqual({ buildingId: "b-331", score: 90 });
  });

  it("địa chỉ chứa tên máy (≥ 4 ký tự, trọn từ) ⇒ 75", () => {
    expect(suggestBuilding("Phan Huy Ich", buildings)).toEqual({ buildingId: "b-331", score: 75 });
  });

  it("không khớp nửa số nhà: '80' không phải '80/55', '180/55' không phải '80/55'", () => {
    expect(scoreBuilding("80", buildings[1]!)).toBe(0);
    expect(scoreBuilding("80/55", { id: "x", name: "X", code: null, street_address: "180/55 Đường Số 7" })).toBe(0);
  });

  it("hai tòa cùng điểm cao nhất ⇒ null (không đoán)", () => {
    const tied: BuildingCandidate[] = [
      { id: "t1", name: "Tòa D", code: null, street_address: "77 Đường Số 5, Khu Phố 1" },
      { id: "t2", name: "Tòa E", code: null, street_address: "77 Đường Số 5, Khu Phố 2" },
    ];
    expect(suggestBuilding("77", tied)).toBeNull();
  });

  it("cảm biến, báo khói, tên rỗng ⇒ null", () => {
    expect(suggestBuilding("Cảm biến cửa tầng 3", buildings)).toBeNull();
    expect(suggestBuilding("Báo khói", buildings)).toBeNull();
    expect(suggestBuilding("", buildings)).toBeNull();
    expect(suggestBuilding(null, buildings)).toBeNull();
  });

  it("tên quá ngắn không dùng luật 'chứa' (< 4 ký tự)", () => {
    expect(suggestBuilding("so", buildings)).toBeNull();
  });
});
