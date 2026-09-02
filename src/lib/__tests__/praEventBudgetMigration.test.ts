import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// PANALYTICS-C02 (re-anchor bảo mật 02/09/2026): `log_public_room_events` cấp
// EXECUTE cho anon và chỉ có trần 50 sự kiện MỖI LỜI GỌI — người ngoài lặp lời
// gọi để bơm bảng lớn vô hạn. Ngân sách theo token/ngày + retention 90 ngày.
//
// Guard đọc ĐỊNH NGHĨA SỐNG (lần CREATE cuối cùng theo thứ tự timestamp), không
// đọc một file migration cố định: file 20260902091449 đã bị 20260902092508 thay
// (bản sau bọc phần cron trong to_regnamespace để Restore Drill chạy được trên
// DB không có pg_cron). Ghim vào file đóng băng thì vế "actual" là hằng số —
// xanh vĩnh viễn kể cả khi hàm thật đổi hành vi. Khuôn: liveDefinitionOf() ở
// salaryCompletionDate.test.ts.

const MIG_DIR = join(process.cwd(), "supabase", "migrations");

let corpusCache: { file: string; sql: string }[] | null = null;
function migrationCorpus(): { file: string; sql: string }[] {
  if (!corpusCache) {
    corpusCache = readdirSync(MIG_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => ({ file: f, sql: readFileSync(join(MIG_DIR, f), "utf8") }));
  }
  return corpusCache;
}

/** Định nghĩa SỐNG của một hàm = lần CREATE cuối cùng theo thứ tự timestamp. */
function liveDefinitionOf(schema: string, fnName: string): { file: string; sql: string } {
  const re = new RegExp(`CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+${schema}\\.${fnName}\\s*\\(`, "i");
  let hit: { file: string; sql: string } | null = null;
  for (const m of migrationCorpus()) {
    if (re.test(m.sql)) hit = m;
  }
  if (!hit) throw new Error(`Không tìm thấy định nghĩa nào của ${schema}.${fnName}`);
  return hit;
}

/** Lần CREATE TABLE cuối cùng của một bảng. */
function liveTableDefinitionOf(qualified: string): { file: string; sql: string } {
  const re = new RegExp(`CREATE\\s+TABLE\\s+(IF\\s+NOT\\s+EXISTS\\s+)?${qualified.replace(".", "\\.")}`, "i");
  let hit: { file: string; sql: string } | null = null;
  for (const m of migrationCorpus()) {
    if (re.test(m.sql)) hit = m;
  }
  if (!hit) throw new Error(`Không tìm thấy CREATE TABLE nào cho ${qualified}`);
  return hit;
}

describe("PANALYTICS-C02 — ngân sách + retention cho analytics công khai", () => {
  it("bảng ngân sách nằm trong app_private (không lộ qua PostgREST) và bật RLS", () => {
    const { file, sql } = liveTableDefinitionOf("app_private.public_room_event_budgets");
    expect(sql, file).toMatch(/PRIMARY KEY \(token, ngay\)/);
    expect(sql, file).toMatch(/ALTER TABLE app_private\.public_room_event_budgets ENABLE ROW LEVEL SECURITY;/);
  });

  it("logger kiểm trần TRƯỚC khi ghi, kẹp batch theo hạn mức còn lại, cộng dồn sau khi ghi", () => {
    const { file, sql } = liveDefinitionOf("public", "log_public_room_events");
    const body = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.log_public_room_events"),
      sql.indexOf("COMMENT ON FUNCTION public.log_public_room_events"),
    );
    const checkPos = body.indexOf("IF v_con_lai <= 0 THEN");
    const loopPos = body.indexOf("FOR r IN");
    const updatePos = body.indexOf("SET so_dong = b.so_dong + v_count");
    expect(checkPos, file).toBeGreaterThan(-1);
    expect(loopPos, file).toBeGreaterThan(checkPos);
    expect(updatePos, file).toBeGreaterThan(loopPos);
    expect(body, file).toMatch(/t\.ord <= LEAST\(50, v_con_lai\)/);
    expect(body, file).toMatch(/c_tran\s+CONSTANT int := 5000;/);
    // ngày tính theo giờ VN để khớp cách báo cáo đọc dữ liệu
    expect(body, file).toMatch(/now\(\) AT TIME ZONE 'Asia\/Ho_Chi_Minh'/);
    // vượt trần phải im lặng như mọi nhánh từ chối khác (không lộ nội bộ cho anon)
    expect(body.slice(checkPos, checkPos + 120), file).toMatch(/RETURN 0;/);
  });

  it("giữ nguyên chữ ký + ACL anon của logger (không phá tính năng đang chạy)", () => {
    const { file, sql } = liveDefinitionOf("public", "log_public_room_events");
    expect(sql, file).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.log_public_room_events\(text, jsonb\) TO anon, authenticated;/,
    );
    expect(sql, file).not.toMatch(/DROP FUNCTION/);
  });

  it("retention có sàn 30 ngày, anon không gọi được hàm xoá, cron chỉ đăng ký khi nền tảng có pg_cron", () => {
    const { file, sql } = liveDefinitionOf("app_private", "pra_prune_public_room_events_v1");
    expect(sql, file).toMatch(/pra_prune_public_room_events_v1\(p_days int DEFAULT 90\)/);
    expect(sql, file).toMatch(/IF p_days IS NULL OR p_days < 30 THEN/);
    expect(sql, file).toMatch(
      /REVOKE ALL ON FUNCTION app_private\.pra_prune_public_room_events_v1\(int\) FROM PUBLIC, anon, authenticated;/,
    );
    // Bản sống phải chịu được DB không có pg_cron (Restore Drill), nếu không cả
    // file cuộn lại và bản khôi phục mất luôn bảng ngân sách.
    expect(sql, file).toMatch(/to_regnamespace\('cron'\) IS NULL/);
    expect(sql, file).toMatch(/cron\.schedule\(\s*'pra_prune_public_room_events_v1'/);
  });
});
