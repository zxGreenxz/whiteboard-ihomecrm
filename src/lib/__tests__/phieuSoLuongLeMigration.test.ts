// H3.1 — SỐ LƯỢNG LẺ TRÊN HẠNG MỤC PHIẾU THU/CHI KHÔNG ĐƯỢC LÀM TRÒN.
//
// VÌ SAO (đo 15/09/2026 trên supabase/baseline/schema.sql, dump prod 06/08)
//   `income_expense_items.quantity` khai `integer` (baseline:99604) trong khi
//   đơn vị thật của hạng mục là kWh, m³, hoặc số người-ngày — đều có phần lẻ.
//   Trigger `auto_calc_item_amount` (baseline:46645) ghi
//   `NEW.amount := NEW.quantity * NEW.unit_price` nên phần lẻ bị cắt TRƯỚC khi
//   nhân: 12,5 kWh × 3.500 đ vào DB thành 12 kWh × 3.500 = 42.000 đ thay vì
//   43.750 đ. Sai số đi thẳng vào tổng phiếu và vào sổ quỹ.
//
// Guard này đo ĐỊNH NGHĨA SỐNG (lần CREATE cuối cùng theo thứ tự timestamp),
// không ghim một file migration đã đóng băng — xem scripts/check-migration-test-liveness.mjs.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const MIG_DIR = join(process.cwd(), "supabase", "migrations");

/** Bỏ comment `-- …`: header migration mô tả CẢ ĐOẠN SQL SAI để đối chiếu. */
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

/** Migration SỐNG nhất có đụng tới kiểu cột quantity. */
function liveQuantityTypeChange(): { file: string; sql: string } {
  const re = /ALTER\s+COLUMN\s+quantity\s+TYPE/i;
  let hit: { file: string; sql: string } | null = null;
  for (const m of migrationCorpus()) {
    if (/income_expense_items/i.test(m.sql) && re.test(m.sql)) hit = m;
  }
  if (!hit) throw new Error("Không migration nào đổi kiểu income_expense_items.quantity");
  return hit;
}

describe("H3.1 — quantity của hạng mục phiếu là số THẬP PHÂN", () => {
  it("có migration nới income_expense_items.quantity sang numeric có phần lẻ", () => {
    const { sql } = liveQuantityTypeChange();
    // numeric(15,4): 4 chữ số lẻ đủ cho kWh/m³ đọc từ công tơ.
    expect(sql).toMatch(/ALTER\s+COLUMN\s+quantity\s+TYPE\s+numeric\(15\s*,\s*4\)/i);
  });

  it("giữ nguyên ràng buộc quantity > 0 (nới kiểu KHÔNG phải nới luật)", () => {
    const { sql } = liveQuantityTypeChange();
    expect(sql).toMatch(/income_expense_items_quantity_positive/i);
  });

  it("chạy hai lần cho cùng kết quả — có phép kiểm kiểu trước khi ALTER", () => {
    const { sql } = liveQuantityTypeChange();
    expect(sql).toMatch(/information_schema\.columns|pg_attribute|format_type/i);
  });

  it("ĐẾM trước, không tự ý sửa dữ liệu cũ", () => {
    // Backfill mù trên bảng tiền là việc không lùi được. Migration chỉ được
    // BÁO SỐ dòng lệch để chủ quyết, không được UPDATE amount hàng loạt.
    const { sql } = liveQuantityTypeChange();
    expect(sql).toMatch(/RAISE\s+NOTICE/i);
    expect(sql).not.toMatch(/UPDATE\s+public\.income_expense_items\s+SET\s+amount/i);
  });
});

describe("H3.1 — auto_calc_item_amount nhân bằng số LẺ", () => {
  it("không còn ép quantity về số nguyên ở bất kỳ đâu trong trigger", () => {
    const { sql } = liveDefinitionOf("auto_calc_item_amount");
    expect(sql).not.toMatch(/quantity\s*\)?\s*::\s*(integer|int4|int\b)/i);
    expect(sql).not.toMatch(/trunc\s*\(\s*NEW\.quantity/i);
  });

  it("làm tròn tiền ĐÚNG MỘT LẦN, ở mức đồng (2 chữ số)", () => {
    // quantity numeric(15,4) × unit_price numeric(15,2) ra scale 6; cột amount
    // là numeric(15,2) nên Postgres tự làm tròn lúc gán. Viết round() tường
    // minh để phép làm tròn nằm trong mã, đọc được, thay vì là tác dụng phụ.
    const { sql } = liveDefinitionOf("auto_calc_item_amount");
    expect(sql).toMatch(/round\s*\(\s*NEW\.quantity\s*\*\s*NEW\.unit_price\s*,\s*2\s*\)/i);
  });

  it("vẫn là trigger BEFORE INSERT OR UPDATE trên income_expense_items", () => {
    const { sql } = liveDefinitionOf("auto_calc_item_amount");
    expect(sql).toMatch(/CREATE\s+TRIGGER\s+trigger_auto_calc_item_amount/i);
    expect(sql).toMatch(/BEFORE\s+INSERT\s+OR\s+UPDATE\s+ON\s+public\.income_expense_items/i);
  });
});

/**
 * Thân hàm, KHÔNG phải cả file.
 *
 * `stripComments` chỉ bỏ chú thích `--`; chuỗi trong `COMMENT ON FUNCTION … IS
 * '…'` là string literal nên vẫn còn. Khẳng định "không còn ::integer" mà đo
 * trên cả file sẽ khớp vào lời MÔ TẢ thay vì vào MÃ.
 */
function liveBodyOf(fnName: string): string {
  const { sql } = liveDefinitionOf(fnName);
  const re = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${fnName}\\s*\\(`, "i");
  const start = sql.search(re);
  if (start === -1) throw new Error(`Không tách được thân public.${fnName}`);
  const rest = sql.slice(start);
  const end = rest.search(/^\s*\$(?:function)?\$\s*;/m);
  return end === -1 ? rest : rest.slice(0, end);
}

describe("H3.1 — writer finance-v2 thôi cắt phần lẻ của số lượng", () => {
  // Nới kiểu cột KHÔNG với tới đây: `create_income_expense_v2` ép kiểu ngay
  // trong thân hàm (baseline:58217), nên phần lẻ bị cắt TRƯỚC khi chạm cột.
  it("không còn ép quantity về số nguyên trong thân create_income_expense_v2", () => {
    const than = liveBodyOf("create_income_expense_v2");
    expect(than).not.toMatch(/quantity'\s*\)\s*::\s*(integer|int4|int\b)/i);
  });

  it("ép sang numeric để giữ phần lẻ, vẫn mặc định 1 khi vắng", () => {
    const than = liveBodyOf("create_income_expense_v2");
    expect(than).toMatch(/COALESCE\(\(v_item->>'quantity'\)::numeric,\s*1\)/i);
  });

  it("giữ nguyên chữ ký (payload jsonb) — không đẻ overload cho PostgREST", () => {
    const { sql } = liveDefinitionOf("create_income_expense_v2");
    expect(sql).toMatch(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.create_income_expense_v2\s*\(\s*payload\s+jsonb\s*\)/i,
    );
    expect(sql).not.toMatch(/DROP\s+FUNCTION[^\n]*create_income_expense_v2/i);
  });

  it("khẳng định lại ACL: anon không gọi được, authenticated gọi được", () => {
    const { sql } = liveDefinitionOf("create_income_expense_v2");
    expect(sql).toMatch(
      /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.create_income_expense_v2[\s\S]{0,120}?anon/i,
    );
    expect(sql).toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.create_income_expense_v2[\s\S]{0,120}?authenticated/i,
    );
  });
});
