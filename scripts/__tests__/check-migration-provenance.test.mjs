// Test hồi quy cho gate provenance migration.
//
// Đem đột biến ra thử 07/08/2026 thì 5/6 cách né đi thẳng qua. Nghiêm trọng
// nhất: lời hứa cốt lõi của gate — "mọi migration sau cutoff phải có
// provenance" — bị vô hiệu chỉ bằng cách ĐẶT TÊN FILE KHÁC ĐI. Tên không phải
// 14 chữ số ⇒ version = null ⇒ isAfterCutoff = false ⇒ rơi vào `continue`.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quetFileSql, entryThieuFile } from "../check-migration-provenance.mjs";

describe("quetFileSql — phải thấy mọi file .sql", () => {
  let dir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "prov-"));
    writeFileSync(join(dir, "20260101000000_thuong.sql"), "select 1;");
    writeFileSync(join(dir, "018_ten_legacy.sql"), "select 1;");
    writeFileSync(join(dir, "20260102000000_hoa.SQL"), "select 1;");
    mkdirSync(join(dir, "nhom"), { recursive: true });
    writeFileSync(join(dir, "nhom", "20260103000000_con.sql"), "select 1;");
    writeFileSync(join(dir, "doc.md"), "khong phai sql");
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it("thấy file ở tầng một", () => {
    assert.ok(quetFileSql(dir).includes("20260101000000_thuong.sql"));
  });

  it("thấy file tên kiểu legacy (không phải 14 chữ số)", () => {
    assert.ok(quetFileSql(dir).includes("018_ten_legacy.sql"));
  });

  it("thấy file đuôi .SQL viết HOA", () => {
    assert.ok(quetFileSql(dir).includes("20260102000000_hoa.SQL"));
  });

  it("thấy file trong THƯ MỤC CON, đường dẫn dùng dấu /", () => {
    assert.ok(quetFileSql(dir).includes("nhom/20260103000000_con.sql"));
  });

  it("không nhặt file không phải .sql", () => {
    assert.ok(!quetFileSql(dir).some((f) => f.endsWith(".md")));
  });
});

describe("entryThieuFile — chiều NGƯỢC manifest → đĩa", () => {
  const entries = [
    { path: "supabase/migrations/a.sql" },
    { path: "supabase/migrations/b.sql" },
    { path: "supabase/migrations-archive/c.sql" },
  ];

  it("bắt file bị xoá", () => {
    const con = new Set(["supabase/migrations/a.sql", "supabase/migrations-archive/c.sql"]);
    assert.deepEqual(entryThieuFile(entries, (p) => con.has(p)), ["supabase/migrations/b.sql"]);
  });

  it("bắt file bị ĐỔI TÊN (tên cũ mất, tên mới không có trong manifest)", () => {
    const con = new Set(["supabase/migrations/a.sql", "supabase/migrations/b_doi_ten.sql", "supabase/migrations-archive/c.sql"]);
    assert.deepEqual(entryThieuFile(entries, (p) => con.has(p)), ["supabase/migrations/b.sql"]);
  });

  it("không báo gì khi mọi file còn nguyên", () => {
    assert.deepEqual(entryThieuFile(entries, () => true), []);
  });

  it("phủ cả migrations-archive, không chỉ migrations", () => {
    const con = new Set(["supabase/migrations/a.sql", "supabase/migrations/b.sql"]);
    assert.deepEqual(entryThieuFile(entries, (p) => con.has(p)), ["supabase/migrations-archive/c.sql"]);
  });
});
