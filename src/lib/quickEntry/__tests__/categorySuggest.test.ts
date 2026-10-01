import { describe, it, expect } from "vitest";
import {
  searchCategories,
  suggestCategory,
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
    expect(ids(usableExpenseCategories(rows, { organizationId: O, canUseRestricted: false }))).toEqual([
      "t1", "t2", "t3", "t4", "t9",
    ]);
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
    expect(ids(searchCategories(usable, "", 2))).toEqual(["t1", "t2"]);
  });
});

describe("suggestCategory — đoán từ mô tả", () => {
  it("cụm phí cố định ⇒ hạng mục mang fee_category đó", () => {
    expect(suggestCategory(usable, "tiền điện tháng 9 1tr2")).toEqual({ id: "t1", reason: "fee_phrase" });
    expect(suggestCategory(usable, "hoá đơn nước 450k")).toEqual({ id: "t2", reason: "fee_phrase" });
  });

  it("hạng mục cố định chưa gắn fee_category vẫn khớp theo tên (như báo cáo lợi nhuận)", () => {
    expect(suggestCategory(usable, "tiền rác 300k")).toEqual({ id: "t9", reason: "fee_phrase" });
  });

  it("'sửa điện' là sửa chữa, KHÔNG phải tiền điện", () => {
    expect(suggestCategory(usable, "sửa điện phòng 301")).toEqual({ id: "t3", reason: "name_overlap" });
  });

  it("mã khách hàng đã ra hạng mục phí ⇒ dùng luôn", () => {
    expect(suggestCategory(usable, "EVN 1tr2", { feeCategory: "nuoc" })).toEqual({ id: "t2", reason: "provider_code" });
  });

  it("không chắc (không trùng từ hoặc hoà điểm) ⇒ null, để AI/người dùng chọn", () => {
    expect(suggestCategory(usable, "ăn trưa với khách")).toBeNull();
    expect(suggestCategory(usable, "điện")).toBeNull();
  });

  it("chữ 'tiền' quá chung không dùng để đoán: 'tiền phạt' không thành 'Tiền điện'", () => {
    const list = usable.filter((c) => c.id === "t1" || c.id === "t4");
    expect(suggestCategory(list, "tiền phạt")).toBeNull();
  });

  it("không bao giờ gợi ý hạng mục ngoài danh sách được dùng", () => {
    expect(suggestCategory(usable, "hoa hồng sale tháng 9")).toBeNull();
  });
});
