// Guard TĨNH cho bất biến: "phiếu quay về CHỜ DUYỆT thì phải có KHAI SINH".
//
// Sự cố đo được trên prod 27/08/2026: phiếu PC2606055 (tạo 12/06/2026) bị huỷ
// duyệt lúc 03:42, sau đó bấm "Duyệt và Chi" trả HTTP 500
//   assert_committed_birth_boundary_v2: voucher 1cf50ae4-… has no birth provenance
// Cùng cảnh: PC2607042. Cả hai birth_operation_id/birth_txid/source_payload_hash
// đều NULL, và KHÔNG nằm trong income_expense_v2_backfill_exceptions — tức
// backfill chưa từng chạm tới chúng, không phải chạm rồi bị chặn.
//
// Gốc rễ là một KHOẢNG TRỐNG giữa hai mảnh của migration 20260723230000:
//   • backfill khai sinh CHỈ quét `approval_status = 'UNAPPROVED'` tại thời điểm
//     migration chạy (23/07/2026);
//   • trigger a86 chỉ BEFORE **INSERT**.
// Phiếu đang APPROVED hôm 23/07 nằm ngoài cả hai. Khi `unapprove_voucher` trả nó
// về UNAPPROVED thì không mảnh nào cấp khai sinh, mà lifecycle V2 lại đòi khai
// sinh để duyệt lại ⇒ phiếu vào ngõ cụt, giao diện không có đường ra.
//
// Đây KHÔNG phải sự cố hai phiếu lẻ: đo prod cùng lúc có 2.523 phiếu APPROVED
// thiếu birth. Mỗi phiếu trong số đó là một quả mìn, chờ ai đó bấm huỷ duyệt.
//
// Quyết định nằm 100% trong plpgsql nên vitest không chạy được logic thật — test
// này chốt HÌNH DẠNG của trigger sống. Bằng chứng chạy thật (huỷ duyệt → duyệt
// lại trên phiếu prod đang kẹt) đính kèm PR.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIG_DIR = join(process.cwd(), "supabase", "migrations");

/** Bỏ comment `-- …`: header migration mô tả cả HÌNH DẠNG CŨ để đối chiếu. */
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

/** Định nghĩa SỐNG của một trigger = lần CREATE TRIGGER cuối theo timestamp. */
function liveTriggerDef(tgName: string): { file: string; def: string } {
  const re = new RegExp(`CREATE\\s+TRIGGER\\s+${tgName}\\b[\\s\\S]*?;`, "i");
  let hit: { file: string; def: string } | null = null;
  for (const m of migrationCorpus()) {
    const found = m.sql.match(re);
    if (found) hit = { file: m.file, def: found[0] };
  }
  if (!hit) throw new Error(`Không tìm thấy CREATE TRIGGER ${tgName} trong migration nào`);
  return hit;
}

describe("khai sinh V2 phải phủ cả đường quay về CHỜ DUYỆT", () => {
  const TG = "a86_finance_v2_birth_provenance";

  it("trigger a86 chạy trên UPDATE, không chỉ INSERT", () => {
    const { file, def } = liveTriggerDef(TG);
    const normalized = def.replace(/\s+/g, " ").toUpperCase();
    expect(
      /BEFORE\s+INSERT\s+OR\s+UPDATE/.test(normalized),
      `${file}: trigger ${TG} phải là BEFORE INSERT OR UPDATE. Chỉ INSERT thì phiếu ` +
        `bị huỷ duyệt (APPROVED → UNAPPROVED) không được cấp khai sinh và không ` +
        `duyệt lại được — đúng sự cố PC2606055 ngày 27/08/2026.\nĐịnh nghĩa sống:\n${def}`,
    ).toBe(true);
  });

  it("trigger a86 chỉ đánh thức khi phiếu CHỜ DUYỆT mà chưa có khai sinh", () => {
    // WHEN thu hẹp ở tầng Postgres: mọi UPDATE khác không gọi hàm plpgsql.
    // Thiếu nó thì trigger chạy trên MỌI update của bảng nóng nhất hệ thống.
    const { file, def } = liveTriggerDef(TG);
    const normalized = def.replace(/\s+/g, " ");
    expect(
      /WHEN\s*\([^)]*approval_status[^)]*UNAPPROVED[^)]*birth_operation_id[^)]*\)/i.test(normalized),
      `${file}: trigger ${TG} thiếu mệnh đề WHEN hẹp (NEW.approval_status = 'UNAPPROVED' ` +
        `AND NEW.birth_operation_id IS NULL).\nĐịnh nghĩa sống:\n${def}`,
    ).toBe(true);
  });

  it("còn nguyên backfill cho phiếu ĐANG kẹt ở CHỜ DUYỆT", () => {
    // Trigger chỉ cứu phiếu từ nay về sau. Hai phiếu đã nằm sẵn ở UNAPPROVED
    // với birth NULL sẽ không có UPDATE nào đánh thức nó nếu không backfill.
    const hasBackfill = migrationCorpus().some(
      (m) =>
        m.sql.includes("finance_v2_register_birth_v1") &&
        /UNAPPROVE_BACKFILL_BIRTH/i.test(m.sql),
    );
    expect(
      hasBackfill,
      "Không migration nào backfill khai sinh (outcome 'UNAPPROVE_BACKFILL_BIRTH') cho " +
        "phiếu đang kẹt ở UNAPPROVED với birth_operation_id IS NULL.",
    ).toBe(true);
  });
});
