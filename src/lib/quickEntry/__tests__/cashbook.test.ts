import { describe, expect, it } from "vitest";
import { expenseCashbooksForOrg, pickDefaultAccount } from "../cashbook";

const accounts = [
  { id: "a-hien", is_default: false, quick_default_building_id: "b102" },
  { id: "a-tk", is_default: true, quick_default_building_id: null },
  { id: "a-khac", is_default: false, quick_default_building_id: "b405" },
];

describe("pickDefaultAccount — chỉ chọn trong sổ người dùng đang giữ tiền", () => {
  const usable = ["a-tk", "a-hien"];

  it("sổ gắn sẵn cho toà ⇒ chọn sổ đó", () => {
    expect(pickDefaultAccount({ buildingId: "b102", usableIds: usable, accounts, lastUsedId: "a-tk" })).toBe("a-hien");
  });

  it("toà không có sổ gắn sẵn (hoặc sổ gắn sẵn không phải sổ mình giữ) ⇒ sổ dùng lần trước", () => {
    expect(pickDefaultAccount({ buildingId: "b405", usableIds: usable, accounts, lastUsedId: "a-hien" })).toBe("a-hien");
  });

  it("chưa dùng lần nào ⇒ sổ mặc định, dù nó không đứng đầu danh sách", () => {
    expect(pickDefaultAccount({ buildingId: null, usableIds: ["a-hien", "a-tk"], accounts, lastUsedId: null })).toBe("a-tk");
  });

  it("sổ dùng lần trước không còn được giữ ⇒ bỏ qua nó", () => {
    expect(pickDefaultAccount({ buildingId: null, usableIds: ["a-hien"], accounts, lastUsedId: "a-tk" })).toBe("a-hien");
  });

  it("không có sổ mặc định ⇒ sổ đầu tiên đang giữ; không giữ sổ nào ⇒ null", () => {
    expect(pickDefaultAccount({ buildingId: null, usableIds: ["a-khac", "a-hien"], accounts, lastUsedId: null })).toBe("a-khac");
    expect(pickDefaultAccount({ buildingId: "b102", usableIds: [], accounts, lastUsedId: "a-hien" })).toBeNull();
  });
});

describe("expenseCashbooksForOrg — sổ chi được của ĐÚNG công ty đang chọn", () => {
  const custodian = [
    { id: "a-hien", name: "Hiển Chi" },
    { id: "a-org-khac", name: "Sổ công ty khác" },
    { id: "a-ao", name: "Sổ ảo" },
  ];
  const all = [
    { id: "a-hien", organization_id: "org-1", is_virtual: false },
    { id: "a-org-khac", organization_id: "org-2", is_virtual: false },
    { id: "a-ao", organization_id: "org-1", is_virtual: true },
  ];

  it("người thuộc nhiều công ty chỉ thấy sổ của công ty đang chọn, bỏ sổ ảo", () => {
    expect(expenseCashbooksForOrg(custodian, all, "org-1").map((c) => c.id)).toEqual(["a-hien"]);
  });

  it("chưa biết công ty hoặc chưa tải danh sách sổ ⇒ không có sổ nào (không đoán)", () => {
    expect(expenseCashbooksForOrg(custodian, all, null)).toEqual([]);
    expect(expenseCashbooksForOrg(custodian, undefined, "org-1")).toEqual([]);
  });
});
