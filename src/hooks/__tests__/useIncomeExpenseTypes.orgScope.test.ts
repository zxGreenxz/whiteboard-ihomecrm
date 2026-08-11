import { describe, expect, it } from "vitest";
import { selectIeTypeRowsForOrgs } from "../useIncomeExpenseTypes";

/**
 * Án lệ 07/08/2026: RLS trên income_expense_types chỉ check capability toàn cục
 * (can_access_org_entity) nên client THẤY hạng mục của mọi tổ chức. Hai org seed
 * cùng lúc đều có "Vệ Sinh Phòng" (created_at giống hệt) → dedup theo tên bốc
 * ngẫu nhiên id của org khác → create_income_expense_v1 từ chối 42501
 * "Loại hạng mục 1 không thuộc tổ chức hoặc sai chiều thu/chi".
 * Client phải lọc về org của mình TRƯỚC khi dedup.
 */

const row = (over: Partial<Record<string, unknown>>) => ({
  id: "id-x",
  user_id: "someone-else",
  name: "Vệ Sinh Phòng",
  type: "expense",
  organization_id: "org-mine",
  created_at: "2026-07-14T16:12:04.812Z",
  ...over,
});

describe("selectIeTypeRowsForOrgs — lọc org trước khi dedup", () => {
  it("bỏ row của org khác khi trùng tên, giữ row org mình", () => {
    const rows = [
      row({ id: "id-cccc", organization_id: "org-other" }),
      row({ id: "id-aaaa", organization_id: "org-mine" }),
    ];

    const result = selectIeTypeRowsForOrgs(rows as never, null, ["org-mine"]);

    expect(result.map((r) => r.id)).toEqual(["id-aaaa"]);
  });

  it("bỏ row org khác kể cả khi KHÔNG trùng tên (không leak cross-org)", () => {
    const rows = [
      row({ id: "id-foreign", name: "Chỉ org khác có", organization_id: "org-other" }),
      row({ id: "id-mine", name: "Tiền điện", organization_id: "org-mine" }),
    ];

    const result = selectIeTypeRowsForOrgs(rows as never, null, ["org-mine"]);

    expect(result.map((r) => r.id)).toEqual(["id-mine"]);
  });

  it("giữ row organization_id null (dữ liệu cũ chưa backfill)", () => {
    const rows = [row({ id: "id-legacy", organization_id: null })];

    const result = selectIeTypeRowsForOrgs(rows as never, null, ["org-mine"]);

    expect(result.map((r) => r.id)).toEqual(["id-legacy"]);
  });

  it("khi không biết org (my_org_ids rỗng/lỗi) thì không lọc, nhưng vẫn dedup theo tên", () => {
    const rows = [
      row({ id: "id-1", organization_id: "org-a" }),
      row({ id: "id-2", organization_id: "org-b" }),
    ];

    const result = selectIeTypeRowsForOrgs(rows as never, null, []);

    expect(result).toHaveLength(1);
  });

  it("dedup vẫn ưu tiên row do chính user tạo trong cùng org", () => {
    const rows = [
      row({ id: "id-team", user_id: "someone-else" }),
      row({ id: "id-own", user_id: "me", created_at: "2026-07-15T00:00:00Z" }),
    ];

    const result = selectIeTypeRowsForOrgs(rows as never, "me", ["org-mine"]);

    expect(result.map((r) => r.id)).toEqual(["id-own"]);
  });

  it("sắp kết quả theo tên tiếng Việt", () => {
    const rows = [
      row({ id: "id-b", name: "Điện nước" }),
      row({ id: "id-a", name: "Bảo trì" }),
    ];

    const result = selectIeTypeRowsForOrgs(rows as never, null, ["org-mine"]);

    expect(result.map((r) => r.name)).toEqual(["Bảo trì", "Điện nước"]);
  });
});
