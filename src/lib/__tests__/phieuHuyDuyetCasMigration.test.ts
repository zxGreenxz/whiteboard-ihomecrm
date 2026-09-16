// H3.2 — `unapprove_voucher` phải KHOÁ DÒNG và so phiên bản trước khi lùi trạng thái.
//
// VÌ SAO (đo 15/09/2026 trên supabase/baseline/schema.sql — dump prod 06/08)
//   `unapprove_voucher` (baseline:94201) đọc-ghi bằng MỘT câu UPDATE trần,
//   không `FOR UPDATE`, không so `approval_version`. Hai lượt huỷ duyệt chạy
//   song song (bấm hai lần, hai tab, hoặc một người duyệt trong lúc người kia
//   huỷ duyệt) đều thấy `ROW_COUNT = 1` và đều báo thành công, trong khi
//   `review_version` bị cộng hai lần và phiếu có thể lùi trạng thái ngay sau
//   khi vừa được người khác duyệt — không dấu vết nào cho biết đã xảy ra.
//
//   `approve_income_expense_v2` (baseline:45826-45829) đã đi đúng khuôn CAS:
//   so `approval_version`, lệch thì ném 55000. Đường huỷ duyệt là chiều ngược
//   lại của CÙNG một trạng thái nên phải dùng cùng một khoá.
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
 * Lấy riêng THÂN hàm, KHÔNG lấy cả file.
 *
 * Vì sao cần: `stripComments` chỉ bỏ chú thích `--`. Chuỗi trong
 * `COMMENT ON FUNCTION ... IS '...khoá dòng (FOR UPDATE)...'` là STRING LITERAL,
 * không phải chú thích, nên nó vẫn nằm trong file. Khẳng định `/FOR UPDATE/`
 * trên cả file vì thế khớp vào lời MÔ TẢ chứ không phải vào MÃ — đã đo bằng
 * `scripts/dot-bien.mjs`: gỡ `FOR UPDATE` khỏi thân hàm mà suite vẫn xanh.
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

describe("H3.2 — unapprove_voucher: khoá dòng + CAS approval_version", () => {
  it("khoá dòng phiếu trước khi quyết định", () => {
    const sql = liveBodyOf("unapprove_voucher");
    expect(sql).toMatch(/FOR\s+UPDATE/i);
  });

  it("nhận p_expected_approval_version và so trước khi ghi", () => {
    const sql = liveBodyOf("unapprove_voucher");
    expect(sql).toMatch(/p_expected_approval_version\s+bigint/i);
    expect(sql).toMatch(/approval_version\s+IS\s+DISTINCT\s+FROM\s+p_expected_approval_version/i);
  });

  it("lệch phiên bản thì ném 55000 — cùng mã với approve_income_expense_v2", () => {
    const sql = liveBodyOf("unapprove_voucher");
    expect(sql).toMatch(/approval_version mismatch[\s\S]{0,400}?ERRCODE\s*=\s*'55000'/i);
  });

  it("cộng approval_version khi lùi trạng thái", () => {
    // Không cộng thì một `p_expected_approval_version` đọc trước lần huỷ duyệt
    // vẫn khớp sau đó — CAS trở thành trang trí.
    const sql = liveBodyOf("unapprove_voucher");
    expect(sql).toMatch(/approval_version\s*=\s*v_row\.approval_version\s*\+\s*1/i);
  });

  it("ĐỔI CHỮ KÝ thì phải DROP rồi CREATE, không CREATE OR REPLACE", () => {
    // CREATE OR REPLACE với danh sách tham số mới đẻ thêm một overload;
    // PostgREST sau đó chọn nhầm bản cũ (án lệ đã ghi trong bộ nhớ dự án).
    const { sql } = liveDefinitionOf("unapprove_voucher");
    expect(sql).toMatch(/DROP\s+FUNCTION\s+IF\s+EXISTS\s+public\.unapprove_voucher\s*\(\s*uuid\s*\)/i);
    expect(sql).not.toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.unapprove_voucher/i);
  });

  it("giữ nguyên ba dòng trả phiếu về đầu quy trình duyệt", () => {
    // Thiếu chúng thì phiếu kẹt ở (UNAPPROVED, RESOLVED) và
    // approve_income_expense_v2 từ chối vĩnh viễn (baseline:94212-94217).
    const sql = liveBodyOf("unapprove_voucher");
    expect(sql).toMatch(/review_state\s*=\s*'PENDING'/i);
    expect(sql).toMatch(/review_version\s*=\s*v_row\.review_version\s*\+\s*1/i);
    expect(sql).toMatch(/review_reason\s*=\s*NULL/i);
  });

  it("giữ nguyên chốt chặn engine và quyền — lát này KHÔNG đụng quyền duyệt", () => {
    const sql = liveBodyOf("unapprove_voucher");
    expect(sql).toMatch(/assert_no_engine_request_v1/i);
    expect(sql).toMatch(/is_super_admin/i);
    expect(sql).toMatch(/can_do_on_building\(\s*'income_expenses'\s*,\s*'approve'/i);
  });

  it("khẳng định lại ACL: anon không gọi được, authenticated gọi được", () => {
    // DROP làm rơi sạch ACL cũ — REVOKE/GRANT ở đây là bắt buộc, không phải
    // thừa (khác hẳn trường hợp CREATE OR REPLACE giữ nguyên ACL).
    const { sql } = liveDefinitionOf("unapprove_voucher");
    expect(sql).toMatch(/REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.unapprove_voucher[\s\S]{0,120}?anon/i);
    expect(sql).toMatch(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.unapprove_voucher[\s\S]{0,120}?authenticated/i);
  });
});
