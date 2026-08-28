// Sổ cho phạm vi liệt kê của generate-migration-provenance (28/08/2026).
//
// Án lệ 75c22b77/91784e62: manifest sinh bằng readdirSync trên working tree
// chung nuốt entry của migration WIP (untracked, phiên khác) — commit xong CI
// đỏ "có trong manifest nhưng KHÔNG còn trên đĩa". Chữa tay hai lần bằng
// worktree sạch; bản này mã hoá: generator liệt kê từ INDEX, file untracked
// không bao giờ lọt vào manifest.
import { describe, expect, it } from "vitest";

import { locSqlTrucTiep } from "../generate-migration-provenance.mjs";

describe("locSqlTrucTiep", () => {
  const paths = [
    "supabase/migrations/20260101000000_a.sql",
    "supabase/migrations/20260102000000_b.SQL",
    "supabase/migrations/nhom/20260103000000_con.sql",
    "supabase/migrations-archive/20200101000000_cu.sql",
    "supabase/migrations/ghi-chu.md",
  ];

  it("chỉ lấy .sql NGAY TRONG thư mục khai, đúng hành vi readdirSync cũ", () => {
    expect(locSqlTrucTiep(paths, "supabase/migrations")).toEqual([
      "20260101000000_a.sql",
      "20260102000000_b.SQL",
    ]);
  });

  it("không lẫn thư mục có tên là tiền tố của nhau", () => {
    expect(locSqlTrucTiep(["supabase/migrations-archive/x.sql"], "supabase/migrations")).toEqual([]);
  });

  it("trả danh sách đã sort để manifest ổn định giữa các máy", () => {
    const kq = locSqlTrucTiep(["supabase/migrations/b.sql", "supabase/migrations/a.sql"], "supabase/migrations");
    expect(kq).toEqual(["a.sql", "b.sql"]);
  });
});
