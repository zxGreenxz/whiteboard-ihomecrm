import { describe, expect, it } from "vitest";
import { expenseCashbooksForOrg } from "../cashbook";

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
