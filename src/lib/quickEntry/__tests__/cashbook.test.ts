import { describe, expect, it } from "vitest";
import { pickDefaultAccount } from "../cashbook";

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
