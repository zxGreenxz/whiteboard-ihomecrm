// Guard TĨNH cho đợt "tách ô KPI Đã hoàn cọc" (22/08/2026, phương án B của chủ).
//
// Ô KPI đo TIỀN ĐÃ RA KÉT nên nó cộng cả phiếu `termination.refund`, mà phiếu đó
// CỐ Ý mang mọi khoản trả lại khách: hoàn cọc + hoàn tiền thừa (từ lâu) + hoàn
// tiền phòng ngày không ở (từ 20260822093000). File này chốt hình dạng SQL của
// phép tách, đo ĐỊNH NGHĨA ĐANG CHẠY chứ không ghim một file migration.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIG_DIR = join(process.cwd(), "supabase", "migrations");

const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, "");

let corpusCache: { file: string; sql: string }[] | null = null;
function migrationCorpus() {
  if (!corpusCache) {
    corpusCache = readdirSync(MIG_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => ({
        file: f,
        sql: stripComments(readFileSync(join(MIG_DIR, f), "utf8")),
      }));
  }
  return corpusCache;
}

/** Định nghĩa SỐNG = lần CREATE cuối cùng theo thứ tự timestamp. */
function thanHamDangChay(tenHam: string): string {
  const signature = `FUNCTION public.${tenHam}(`;
  let hit: string | null = null;
  for (const m of migrationCorpus()) if (m.sql.includes(signature)) hit = m.sql;
  expect(hit, `không thấy định nghĩa nào của ${tenHam}`).not.toBeNull();
  const sql = hit as string;
  let start = -1;
  for (let i = sql.indexOf(signature); i >= 0; i = sql.indexOf(signature, i + 1)) {
    if (/\bCREATE\s+(OR\s+REPLACE\s+)?$/i.test(sql.slice(Math.max(0, i - 24), i))) start = i;
  }
  expect(start, `không thấy định nghĩa của ${tenHam}`).toBeGreaterThan(-1);
  const tag = /\bAS (\$[A-Za-z_]*\$)/.exec(sql.slice(start))?.[1] ?? "$$";
  const open = sql.indexOf(tag, start);
  const close = sql.indexOf(tag, open + tag.length);
  expect(close, tenHam).toBeGreaterThan(open);
  return sql.slice(start, close + tag.length);
}

const KPI = "get_refund_forfeit_summary";

describe("tách KPI hoàn cọc — hình dạng SQL", () => {
  const body = () => thanHamDangChay(KPI);

  it("tách theo accounting_class, KHÔNG khớp tên hạng mục", () => {
    // Tên hạng mục có hai biến thể lịch sử ('Hoàn cọc thanh lý' 24 dòng và
    // 'Hoàn trả thanh lý' 7 dòng = 19.168.800đ). Khớp tên sẽ sót nhánh thứ hai.
    const sql = body();
    expect(sql).toContain("item.accounting_class = 'DEPOSIT'");
    expect(sql).not.toContain("'Hoàn cọc thanh lý'");
    expect(sql).not.toContain("'Hoàn trả thanh lý'");
  });

  it("trả đủ bốn khoá tách", () => {
    const sql = body();
    for (const k of [
      "refund_deposit_total",
      "refund_non_deposit_total",
      "refund_pending_deposit_total",
      "refund_pending_non_deposit_total",
    ]) {
      expect(sql, `thiếu khoá ${k}`).toContain(`'${k}'`);
    }
  });

  it("phần KHÔNG PHẢI cọc derive từ tổng phiếu, không cộng lại từ hạng mục", () => {
    // Nhờ vậy đẳng thức deposit + non_deposit = tổng ĐÚNG THEO CẤU TRÚC; phiếu
    // nào có hạng mục lệch total_amount thì phần lệch lộ ra thay vì biến mất.
    const sql = body();
    expect(sql).toContain("SUM(rv.total_amount - rv.deposit_amount)");
    expect(sql).toContain("SUM(unposted_amount - unposted_deposit_amount)");
  });

  it("phần CHỜ CHI đi qua per_term, không quét thẳng rv", () => {
    // refund_pending_total đếm theo HỒ SƠ THANH LÝ non-FORFEIT. Quét thẳng rv là
    // đếm MỌI phiếu (kể cả mồ côi và phiếu gắn hồ sơ bỏ cọc) ⇒ hai tập khác nhau,
    // dòng phụ trên UI sẽ nói khác con số ngay phía trên nó. Postflight của
    // migration đã bắt đúng lỗi này ở bản đầu.
    const sql = body();
    const pending = sql.slice(sql.indexOf("'refund_pending_deposit_total'"));
    expect(pending.slice(0, 400)).toContain("FROM per_term WHERE tt <> 'FORFEIT'");
  });

  it("KHÔNG đụng vào refund_total và đẳng thức linked + orphan", () => {
    // Quyết định của chủ 30/07: refund_total phải là TIỀN THẬT ĐÃ RA KÉT, và UI
    // dùng linked + orphan = total để quyết định có tin số server hay không.
    const sql = body();
    expect(sql).toContain("'refund_total',  (SELECT amount FROM posted_all)");
    expect(sql).toContain("'refund_linked_total'");
    expect(sql).toContain("'refund_posted_orphan_total'");
  });
});

describe("tách KPI hoàn cọc — migration tự canh", () => {
  const migration = readFileSync(
    join(MIG_DIR, "20260822113000_refund_kpi_split_deposit_vs_other.sql"),
    "utf8",
  ).replace(/\r\n/g, "\n");

  it("postflight chốt cả ba đẳng thức", () => {
    expect(migration).toContain("Đẳng thức linked + orphan = total đã vỡ");
    expect(migration).toContain("deposit + non_deposit <> refund_total");
    expect(migration).toContain("pending deposit + non_deposit <> refund_pending_total");
  });

  it("postflight chốt bốn khoá cũ vẫn còn (frontend đang đọc)", () => {
    expect(migration).toContain("Mất khoá cũ trong hình dạng trả về");
  });

  it("giữ chữ ký nên thay tại chỗ, không mất ACL", () => {
    expect(migration).toContain("CREATE OR REPLACE FUNCTION public.get_refund_forfeit_summary");
    expect(migration).not.toContain("DROP FUNCTION");
  });
});
