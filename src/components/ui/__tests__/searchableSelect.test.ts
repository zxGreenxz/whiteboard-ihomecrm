import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { normalizeVietnamese } from "@/lib/utils";
import { searchableSelectFilter } from "@/components/ui/searchable-select";

describe("normalizeVietnamese", () => {
  it("hạ chữ thường + bỏ dấu tiếng Việt", () => {
    expect(normalizeVietnamese("Quận Tân Bình")).toBe("quan tan binh");
    expect(normalizeVietnamese("Toà nhà 45/3 Trần Thái Tông")).toBe(
      "toa nha 45/3 tran thai tong",
    );
    expect(normalizeVietnamese("Đường Đồng Đen")).toBe("duong dong den");
    expect(normalizeVietnamese("HẠNG MỤC THU")).toBe("hang muc thu");
  });

  it("an toàn với chuỗi rỗng / null-ish", () => {
    expect(normalizeVietnamese("")).toBe("");
    // Cố tình truyền undefined để kiểm tra guard. Chỗ này trước dùng chỉ thị
    // `@ts-expect-error`, và nó SAI ở cả hai chiều: dưới `strictNullChecks:
    // false` hiện tại thì `undefined` gán được vào `string` nên chỉ thị THỪA và
    // tsc báo TS2578; còn khi bật cờ lên thì nó lại CẦN. Ép kiểu tường minh đúng
    // ở cả hai trạng thái, nên lát bật cờ sau này không phải quay lại đây nữa.
    expect(normalizeVietnamese(undefined as unknown as string)).toBe("");
  });

  it("idempotent (chuẩn hoá 2 lần = 1 lần)", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(normalizeVietnamese(normalizeVietnamese(s))).toBe(
          normalizeVietnamese(s),
        );
      }),
    );
  });
});

describe("searchableSelectFilter", () => {
  it("query rỗng → luôn hiện (score 1)", () => {
    expect(searchableSelectFilter("Phòng 101", "")).toBe(1);
    expect(searchableSelectFilter("x", "   ")).toBe(1);
  });

  it("khớp không phân biệt dấu/hoa-thường", () => {
    expect(searchableSelectFilter("toa-1", "TOÀ", ["Toà nhà A"])).toBe(1);
    expect(searchableSelectFilter("id-1", "tan binh", ["Quận Tân Bình"])).toBe(1);
    expect(searchableSelectFilter("id-1", "tân", ["Quận Tân Bình"])).toBe(1);
  });

  it("hỗ trợ nhiều token — tất cả phải khớp", () => {
    expect(
      searchableSelectFilter("id", "tran tong", ["45/3 Trần Thái Tông"]),
    ).toBe(1);
    expect(
      searchableSelectFilter("id", "tran xyz", ["45/3 Trần Thái Tông"]),
    ).toBe(0);
  });

  it("không khớp → score 0", () => {
    expect(searchableSelectFilter("id-1", "khongtontai", ["Phòng 101"])).toBe(0);
  });

  it("khớp được cả trên value lẫn keywords", () => {
    expect(searchableSelectFilter("ACTIVE", "active")).toBe(1);
    expect(searchableSelectFilter("uuid-abc", "abc")).toBe(1);
  });

  it("token có trong haystack thì luôn khớp (property)", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
        (label) => {
          // dùng chính label đã chuẩn hoá làm query → phải khớp
          const q = normalizeVietnamese(label);
          if (q.split(/\s+/).filter(Boolean).length === 0) return;
          expect(searchableSelectFilter("val", q, [label])).toBe(1);
        },
      ),
    );
  });
});
