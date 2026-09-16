// H3.5 — "hôm nay" của đường tiền phải là NGÀY CỦA TỔ CHỨC.
//
// VÌ SAO — cùng gốc với án lệ 20260913172730 (reverse_collection)
//   Phiên Postgres chạy TimeZone = UTC, nên từ 00:00 đến 07:00 giờ VN
//   `CURRENT_DATE` vẫn là hôm qua trong khi app đã sang ngày mới.
//   `public.org_today_v1(<org>)` là nguồn "hôm nay" đã thống nhất.
//
// Guard đo ĐỊNH NGHĨA SỐNG, không ghim file migration đóng băng.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

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

function liveDefinitionOf(fnName: string): { file: string; sql: string } {
  const re = new RegExp(`CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${fnName}\\s*\\(`, "i");
  let hit: { file: string; sql: string } | null = null;
  for (const m of migrationCorpus()) {
    if (re.test(m.sql)) hit = m;
  }
  if (!hit) throw new Error(`Không tìm thấy định nghĩa nào của public.${fnName}`);
  return hit;
}

/**
 * Lấy riêng THÂN của một hàm trong file định nghĩa sống — file migration có
 * thể chứa nhiều hàm, và phép khẳng định "không còn CURRENT_DATE" chỉ đúng khi
 * đo đúng hàm đang nói tới.
 */
function liveBodyOf(fnName: string): string {
  const { sql } = liveDefinitionOf(fnName);
  const re = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${fnName}\\s*\\(`, "i");
  const start = sql.search(re);
  const rest = sql.slice(start);
  const end = rest.search(/^\s*\$(?:function)?\$\s*;/m);
  return end === -1 ? rest : rest.slice(0, end);
}

describe("H3.5 — cancel_income_voucher_v1 không bị CURRENT_DATE kéo lùi ngày", () => {
  it("bỏ vế LEAST(..., CURRENT_DATE) ở ngày hoàn tác", () => {
    // Vế đó từng đúng khi reverse_invoice_collection_v5 đo cận trên bằng
    // CURRENT_DATE. Sau 20260913172730, cận trên đã là org_today_v1 — LEAST
    // không còn là trần mà thành thứ kéo ngày xuống DƯỚI trần.
    const than = liveBodyOf("cancel_income_voucher_v1");
    expect(than).not.toMatch(/LEAST\s*\(\s*public\.org_today_v1/i);
    expect(than).toMatch(
      /GREATEST\s*\(\s*public\.org_today_v1\(\s*v\.organization_id\s*\)\s*,\s*v_coll\.collection_date\s*\)/i,
    );
  });

  it("không còn CURRENT_DATE nào trong thân hàm", () => {
    expect(liveBodyOf("cancel_income_voucher_v1")).not.toMatch(/CURRENT_DATE/);
  });
});

describe("H3.5 — get_room_cash_lifecycle_v1 đếm ngày trống theo org", () => {
  it("lấy organization_id của toà rồi tính hôm nay đúng một lần", () => {
    const than = liveBodyOf("get_room_cash_lifecycle_v1");
    expect(than).toMatch(/b\.organization_id/);
    expect(than).toMatch(/v_today\s*:=\s*public\.org_today_v1\(\s*v_room\.organization_id\s*\)/i);
  });

  it("cả số ngày trống lẫn mốc so sánh đều dùng v_today", () => {
    const than = liveBodyOf("get_room_cash_lifecycle_v1");
    expect(than).toMatch(/\(\s*v_today\s*-\s*max\(s\.to_date\)\s*\)/i);
    expect(than).toMatch(/max\(s\.to_date\)\s*<\s*v_today/i);
    expect(than).not.toMatch(/CURRENT_DATE/);
  });
});

describe("H3.5 — payments.payment_date lấy ngày của tổ chức", () => {
  const migration = migrationCorpus().find((m) =>
    /ALTER\s+COLUMN\s+payment_date\s*\n?\s*SET\s+DEFAULT/i.test(m.sql),
  );

  it("có migration đổi DEFAULT của cột", () => {
    expect(migration).toBeDefined();
  });

  it("giữ CURRENT_DATE làm đường lùi — org_today_v1(NULL) trả NULL cho người nhiều tổ chức", () => {
    // Cột NOT NULL. Bỏ COALESCE là đổi một ngày lệch múi giờ lấy một lỗi 23502
    // chặn hẳn đường ghi của người thuộc từ hai tổ chức trở lên.
    expect(migration!.sql).toMatch(
      /SET\s+DEFAULT\s+COALESCE\s*\(\s*public\.org_today_v1\(\s*NULL::uuid\s*\)\s*,\s*CURRENT_DATE\s*\)/i,
    );
  });
});
