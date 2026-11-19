import { describe, it, expect } from "vitest";
import {
  searchCategories,
  usableExpenseCategories,
  type CategoryRef,
} from "../categorySuggest";

const O = "org-ihome";
const rows: CategoryRef[] = [
  { id: "t1", name: "Tiền điện", category: "Điện", type: "expense", organization_id: O, fee_category: "dien" },
  { id: "t2", name: "Tiền nước", category: "Nước", type: "expense", organization_id: O, fee_category: "nuoc" },
  { id: "t3", name: "Sửa chữa điện", category: "Bảo Trì", type: "expense", organization_id: O },
  { id: "t4", name: "Văn phòng phẩm", category: "Văn phòng", type: "expense", organization_id: O },
  { id: "t5", name: "Hoa hồng sale", category: "Hoa hồng", type: "expense", organization_id: O, is_restricted: true },
  { id: "t6", name: "Bút toán hệ thống", category: "Hệ thống", type: "expense", organization_id: O, system_only: true },
  { id: "t7", name: "Tiền điện", category: "Điện", type: "expense", organization_id: "org-khac", fee_category: "dien" },
  { id: "t8", name: "Tiền thu phòng", category: "Doanh thu", type: "income", organization_id: O },
  { id: "t9", name: "Tiền rác", category: "Rác", type: "expense", organization_id: O },
];

const ids = (list: CategoryRef[]) => list.map((c) => c.id);

describe("usableExpenseCategories", () => {
  it("chỉ hạng mục CHI của đúng công ty, bỏ hạng mục hệ thống và hạng mục hạn chế khi thiếu quyền", () => {
    // Chưa có sort_order ⇒ xếp theo tên tiếng Việt.
    expect(ids(usableExpenseCategories(rows, { organizationId: O, canUseRestricted: false }))).toEqual([
      "t3", "t1", "t2", "t9", "t4",
    ]);
  });

  it("danh mục chuẩn: bỏ mục lưu trữ / ẩn tay / ẩn khỏi Báo chi nhanh, xếp theo sort_order", () => {
    const list: CategoryRef[] = [
      { id: "a", name: "Văn phòng phẩm", category: null, type: "expense", organization_id: O, sort_order: 20 },
      { id: "b", name: "Tiền nhà", category: null, type: "expense", organization_id: O, sort_order: 10 },
      { id: "c", name: "Mục cũ", category: null, type: "expense", organization_id: O, archived_at: "2026-10-03T00:00:00Z" },
      { id: "d", name: "Hoa hồng môi giới", category: null, type: "expense", organization_id: O, manual_hidden: true },
      { id: "e", name: "Vệ sinh tòa nhà định kỳ", category: null, type: "expense", organization_id: O, quick_entry_hidden: true },
      { id: "f", name: "Ăn uống", category: null, type: "expense", organization_id: O },
    ];
    expect(ids(usableExpenseCategories(list, { organizationId: O, canUseRestricted: true }))).toEqual(["b", "a", "f"]);
  });

  it("có quyền hạng mục hạn chế ⇒ được thấy", () => {
    expect(ids(usableExpenseCategories(rows, { organizationId: O, canUseRestricted: true }))).toContain("t5");
  });
});

const usable = usableExpenseCategories(rows, { organizationId: O, canUseRestricted: false });

describe("searchCategories — ô chọn hạng mục", () => {
  it("tên bắt đầu bằng > tên chứa > nhóm chứa; cùng hạng xếp theo tên", () => {
    // Bảng chữ cái tiếng Việt: đ sau d nhưng trước n, r ⇒ điện < nước < rác.
    expect(ids(searchCategories(usable, "tiền"))).toEqual(["t1", "t2", "t9"]);
    expect(ids(searchCategories(usable, "đi"))).toEqual(["t3", "t1"]);
    expect(ids(searchCategories(usable, "bảo trì"))).toEqual(["t3"]);
  });

  it("tên BẮT ĐẦU bằng từ tìm đứng trước tên chỉ CHỨA nó, dù đứng sau theo bảng chữ cái", () => {
    const list: CategoryRef[] = [
      { id: "a", name: "Bảo trì văn phòng", category: "Bảo Trì", type: "expense", organization_id: O },
      { id: "b", name: "Văn phòng phẩm", category: "Văn phòng", type: "expense", organization_id: O },
    ];
    expect(ids(searchCategories(list, "văn"))).toEqual(["b", "a"]);
  });

  it("ô tìm rỗng ⇒ tối đa `limit` hạng mục đầu", () => {
    expect(ids(searchCategories(usable, "", 2))).toEqual(["t3", "t1"]);
  });
});
