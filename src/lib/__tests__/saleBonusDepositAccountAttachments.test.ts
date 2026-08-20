import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Thưởng nóng Sale tạo từ PHIẾU CỌC nhận thêm SỔ QUỸ và ẢNH CHỨNG TỪ (20/08/2026).
 *
 * Hai bất biến đắt nhất mà test này canh:
 *
 *  1. Hàm là SECURITY DEFINER. Nhận `p_account_id` mà không kiểm quyền nghĩa là
 *     bất kỳ ai cũng ghi được phiếu CHI vào sổ quỹ của người khác cùng tổ chức —
 *     đúng thứ `create_income_expense_v1` đang chặn bằng possession binding.
 *  2. Mọi chốt cũ phải còn nguyên: sổ claim chống chi trùng, trần thưởng, cửa hẹp
 *     SALE_BONUS_DEPOSIT, và phiếu ra CHỜ DUYỆT. Thêm tham số là dịp dễ đánh rơi
 *     chúng nhất, vì thân hàm được chép lại nguyên khối.
 *
 * Đo ĐỊNH NGHĨA SỐNG (lần CREATE cuối theo thứ tự timestamp), không ghim một file
 * migration — file cũ là legacy-frozen nên `toContain` trên nó xanh vĩnh viễn kể
 * cả khi hàm thật đã đổi. Xem scripts/check-migration-test-liveness.mjs.
 */
const MIG_DIR = resolve(process.cwd(), "supabase/migrations");
const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, "");

let corpusCache: { file: string; sql: string }[] | null = null;
function migrationCorpus(): { file: string; sql: string }[] {
  if (!corpusCache) {
    corpusCache = readdirSync(MIG_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => ({
        file: f,
        sql: stripComments(readFileSync(join(MIG_DIR, f), "utf8").replace(/\r\n/g, "\n")),
      }));
  }
  return corpusCache;
}

/** Định nghĩa SỐNG của một hàm = lần CREATE cuối cùng theo thứ tự timestamp. */
function liveDefinitionOf(fnName: string): { file: string; sql: string } {
  const re = new RegExp(
    `CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${fnName}\\s*\\(`,
    "i",
  );
  let hit: { file: string; sql: string } | null = null;
  for (const m of migrationCorpus()) {
    if (re.test(m.sql)) hit = m;
  }
  if (!hit) throw new Error(`Không tìm thấy định nghĩa nào của public.${fnName}`);
  return hit;
}

const live = () => liveDefinitionOf("create_sale_bonus_from_deposit_v1");

describe("create_sale_bonus_from_deposit_v1 — sổ quỹ + ảnh chứng từ", () => {
  it("nhận p_account_id và p_attachments", () => {
    const { file, sql } = live();
    expect(sql, `${file}: thiếu tham số p_account_id`).toMatch(/p_account_id\s+uuid/i);
    expect(sql, `${file}: thiếu tham số p_attachments`).toMatch(/p_attachments\s+jsonb/i);
  });

  it("ghi sổ quỹ, ảnh và STK/ngân hàng vào ĐÚNG CỘT của phiếu", () => {
    const { file, sql } = live();
    for (const col of [
      "account_id",
      "attachments",
      "receive_bank_account",
      "receive_bank_name",
    ]) {
      expect(sql.includes(col), `${file}: phiếu thưởng không ghi cột ${col}`).toBe(true);
    }
  });

  it("kiểm quyền sổ quỹ trước khi ghi — không tin client", () => {
    const { file, sql } = live();
    expect(
      sql.includes("cashbook_possession_bindings"),
      `${file}: nhận p_account_id mà không kiểm possession ⇒ ghi được vào sổ người khác`,
    ).toBe(true);
    expect(sql).toMatch(/possession_kind\s+IN\s*\(\s*'CUSTODIAN'\s*,\s*'OPERATOR'\s*\)/i);
    // KNOWER chỉ được Phiếu THU (§9.2); đây là phiếu CHI nên không được có mặt.
    expect(
      /'KNOWER'/.test(sql),
      `${file}: KNOWER không được phép ký phiếu CHI`,
    ).toBe(false);
    expect(sql).toContain("Không có quyền sử dụng sổ quỹ này");
  });

  it("validate ảnh là mảng chuỗi", () => {
    const { file, sql } = live();
    expect(sql, `${file}: không kiểm kiểu của p_attachments`).toMatch(
      /jsonb_typeof\s*\(\s*v_attachments\s*\)\s*<>\s*'array'/i,
    );
    expect(sql).toMatch(/jsonb_array_elements\s*\(\s*v_attachments\s*\)/i);
  });

  it("giữ nguyên bốn chốt cũ: claim, trần, cửa hẹp, chờ duyệt", () => {
    const { file, sql } = live();
    for (const mark of [
      "sale_bonus_claims",
      "sale_bonus_cap_for_v1",
      "SALE_BONUS_DEPOSIT",
      "'UNAPPROVED'",
    ]) {
      expect(sql.includes(mark), `${file}: đánh rơi chốt ${mark}`).toBe(true);
    }
  });

  it("DROP chữ ký 6 tham số để không sinh overload cho PostgREST", () => {
    const { file, sql } = live();
    expect(
      /DROP\s+FUNCTION\s+IF\s+EXISTS\s+public\.create_sale_bonus_from_deposit_v1\s*\(\s*uuid\s*,\s*numeric\s*,\s*text\s*,\s*text\s*,\s*text\s*,\s*date\s*\)/i.test(
        sql,
      ),
      `${file}: còn cả hai chữ ký ⇒ PostgREST báo "function is not unique"`,
    ).toBe(true);
  });

  it("chỉ cấp quyền cho authenticated/service_role, thu của anon", () => {
    const { sql } = live();
    expect(sql).toMatch(/REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.create_sale_bonus_from_deposit_v1[\s\S]*?anon/i);
    expect(sql).toMatch(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.create_sale_bonus_from_deposit_v1[\s\S]*?authenticated/i);
  });
});
