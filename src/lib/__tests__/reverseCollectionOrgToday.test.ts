// Guard TĨNH cho bất biến: cận trên "ngày hoàn tác không được ở tương lai" của
// reverse_invoice_collection_v5 phải đo theo public.org_today_v1(<org>), KHÔNG
// theo CURRENT_DATE của phiên Postgres (TimeZone=UTC ⇒ lệch 7 giờ với ngày VN,
// đo 14/09/2026: từ 00:00 đến 07:00 giờ VN không hoàn tác được khoản thu trong
// ngày). Logic nằm trong plpgsql nên vitest không chạy được hàm thật; test đọc
// ĐỊNH NGHĨA SỐNG (lần CREATE cuối trong supabase/migrations) theo đúng khuôn
// liveDefinitionOf ở salaryCompletionDate.test.ts — không ghim một file cũ.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIG_DIR = join(process.cwd(), "supabase", "migrations");
const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, "");

let corpusCache: { file: string; sql: string }[] | null = null;
function migrationCorpus(): { file: string; sql: string }[] {
  if (!corpusCache) {
    corpusCache = readdirSync(MIG_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => ({ file: f, sql: stripComments(readFileSync(join(MIG_DIR, f), "utf8")) }));
  }
  return corpusCache;
}

/** Định nghĩa SỐNG của một hàm = lần CREATE cuối cùng theo thứ tự timestamp. */
function liveDefinitionOf(fnName: string): { file: string; sql: string } {
  const re = new RegExp(`CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${fnName}\\s*\\(`, "i");
  let hit: { file: string; sql: string } | null = null;
  for (const m of migrationCorpus()) {
    if (re.test(m.sql)) hit = m;
  }
  if (!hit) throw new Error(`Không tìm thấy định nghĩa nào của public.${fnName}`);
  return hit;
}

describe("bất biến: reverse_invoice_collection_v5 đo 'hôm nay' theo ngày của org", () => {
  it("không so p_reversal_date với CURRENT_DATE, mà với public.org_today_v1(...)", () => {
    const { file, sql } = liveDefinitionOf("reverse_invoice_collection_v5");
    expect(
      /p_reversal_date\s*>\s*CURRENT_DATE\b/i.test(sql),
      `${file}: cận trên còn so với CURRENT_DATE (UTC) — 00:00–07:00 VN sẽ không hoàn tác được`,
    ).toBe(false);
    expect(
      /p_reversal_date\s*>\s*public\.org_today_v1\s*\(\s*v_collection\.organization_id\s*\)/i.test(sql),
      `${file}: thiếu cận trên theo public.org_today_v1(v_collection.organization_id)`,
    ).toBe(true);
  });

  it("giữ nguyên cận dưới: không sớm hơn collection_date", () => {
    const { file, sql } = liveDefinitionOf("reverse_invoice_collection_v5");
    expect(
      /p_reversal_date\s*<\s*v_collection\.collection_date/i.test(sql),
      `${file}: mất cận dưới theo collection_date`,
    ).toBe(true);
  });
});
