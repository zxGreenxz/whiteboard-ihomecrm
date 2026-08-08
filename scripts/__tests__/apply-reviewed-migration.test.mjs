import { describe, expect, it } from "vitest";

import { buildTransaction } from "../apply-reviewed-migration.mjs";

// SỰ CỐ 07/08/2026: `npm run migrate:forward <file>` KHÔNG kèm --apply được
// quảng cáo là DRY-RUN ("bọc ROLLBACK") nhưng đã GHI THẬT lên production một
// policy RLS. Nguyên nhân: buildTransaction bọc BEGIN…ROLLBACK quanh nội dung
// file, mà mọi migration của dự án đều tự mở BEGIN;…COMMIT; (nhà đang bắt buộc
// đúng một cặp — xem ieGuardHandoverScopeMigration.test.ts). Postgres BỎ QUA
// lệnh BEGIN lồng (chỉ cảnh báo) nên COMMIT bên trong đóng luôn transaction
// NGOÀI; ROLLBACK cuối rơi vào chỗ không còn transaction nào → no-op.
//
// Hậu quả: cửa promotion token và cửa backup — hai thứ duy nhất biến "chỉ con
// người mới phát hành" thành cơ chế — đều bị đi vòng qua đường được cho là an
// toàn nhất. Test này chốt: dry-run phải THỰC SỰ rollback.
describe("buildTransaction — dry-run phải rollback thật", () => {
  const migration = [
    "-- comment",
    "BEGIN;",
    "CREATE POLICY p ON public.t USING (true);",
    "DO $verify$",
    "DECLARE v int;",
    "BEGIN",
    "  v := 1;",
    "END",
    "$verify$;",
    "COMMIT;",
    "",
    "-- ROLLBACK: DROP POLICY p ON public.t;",
  ].join("\n");

  it("gỡ cặp BEGIN/COMMIT của chính file để COMMIT không đóng transaction ngoài", () => {
    const sql = buildTransaction(migration, { rollback: true });

    const statementCommits = sql.match(/^\s*COMMIT\s*;\s*$/gm) ?? [];
    expect(statementCommits).toHaveLength(0);
  });

  it("dry-run kết thúc bằng ROLLBACK và mở đúng một BEGIN", () => {
    const sql = buildTransaction(migration, { rollback: true });

    expect(sql.match(/^\s*BEGIN\s*;\s*$/gm)).toHaveLength(1);
    expect(sql.trimEnd().endsWith("ROLLBACK;")).toBe(true);
  });

  it("apply thật vẫn đóng transaction đúng một lần", () => {
    const sql = buildTransaction(migration, { rollback: false });

    expect(sql.match(/^\s*COMMIT\s*;\s*$/gm)).toHaveLength(1);
    expect(sql.trimEnd().endsWith("COMMIT;")).toBe(true);
  });

  it("KHÔNG đụng tới BEGIN/END của khối plpgsql lồng bên trong", () => {
    const sql = buildTransaction(migration, { rollback: true });

    expect(sql).toContain("DO $verify$");
    expect(sql).toContain("\nBEGIN\n");
    expect(sql).toContain("$verify$;");
    expect(sql).toContain("CREATE POLICY p ON public.t USING (true);");
  });

  it("giữ nguyên khoá và timeout — gỡ BEGIN của file không được làm rơi lớp bảo vệ", () => {
    const sql = buildTransaction(migration, { rollback: true });

    expect(sql).toContain("SET LOCAL lock_timeout");
    expect(sql).toContain("SET LOCAL statement_timeout");
    expect(sql).toContain("pg_advisory_xact_lock");
  });

  it("KHÔNG nhầm `END;` của thân plpgsql là lệnh đóng transaction", () => {
    // Ca này có thật: 20260807140000_ie_guard_handover_scope.sql chứa nhiều
    // `END;` kết thúc khối plpgsql bên trong $function$…$function$. Coi chúng
    // là COMMIT thì runner từ chối mọi migration viết hàm — tức gần như tất cả.
    const coHam = [
      "BEGIN;",
      "CREATE OR REPLACE FUNCTION public.f() RETURNS void LANGUAGE plpgsql AS $function$",
      "BEGIN",
      "  IF true THEN",
      "    RAISE NOTICE 'x';",
      "  END IF;",
      "END;",
      "$function$;",
      "DO $verify$",
      "BEGIN",
      "  PERFORM 1;",
      "END;",
      "$verify$;",
      "COMMIT;",
    ].join("\n");

    const sql = buildTransaction(coHam, { rollback: true });

    expect(sql).toContain("END IF;");
    expect(sql).toContain("$function$;");
    expect(sql).toContain("$verify$;");
    expect(sql.trimEnd().endsWith("ROLLBACK;")).toBe(true);
  });

  it("ném lỗi nếu file còn lệnh kết thúc transaction ở giữa thân", () => {
    const dodgy = ["BEGIN;", "SELECT 1;", "COMMIT;", "SELECT 2;", "COMMIT;"].join("\n");

    expect(() => buildTransaction(dodgy, { rollback: true })).toThrow(
      /lệnh kết thúc transaction/i,
    );
  });

  it("chạy được với file không tự mở transaction", () => {
    const bare = "CREATE INDEX CONCURRENTLY_NOT ON public.t (id);";
    const sql = buildTransaction(bare, { rollback: true });

    expect(sql.match(/^\s*BEGIN\s*;\s*$/gm)).toHaveLength(1);
    expect(sql).toContain(bare);
    expect(sql.trimEnd().endsWith("ROLLBACK;")).toBe(true);
  });
});
