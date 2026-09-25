import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// =============================================================================
// Đợt 1 "sửa phiếu thu chi" (25/09/2026) — kiểm tĩnh các migration.
//
// Khẳng định VỀ HÀNH VI hàm đọc thân ĐANG CHẠY = lần CREATE cuối cùng trên toàn
// bộ thư mục migration (khuôn thanHamDangChay, xem
// scripts/check-migration-test-liveness.mjs); khẳng định về CẤU TRÚC một file
// thì đọc đúng file đó.
// =============================================================================

const MIG_DIR = join(process.cwd(), "supabase", "migrations");

function docFile(ten: string): string {
  const f = readdirSync(MIG_DIR).find((x) => x.endsWith(`_${ten}.sql`));
  expect(f, `không thấy migration *_${ten}.sql`).toBeTruthy();
  return readFileSync(join(MIG_DIR, f as string), "utf8");
}

/** Bỏ chú thích `--` để chữ trong comment không làm test báo đạt. */
const boChuThich = (s: string) => s.replace(/--[^\n]*/g, "");

function thanHamDangChay(tenHam: string, schema = "public"): string {
  const signature = `FUNCTION ${schema}.${tenHam}(`;
  const files = readdirSync(MIG_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  let hit: string | null = null;
  for (const f of files) {
    const body = readFileSync(join(MIG_DIR, f), "utf8");
    if (body.includes(signature)) hit = body;
  }
  expect(hit, `không thấy định nghĩa nào của ${tenHam}`).not.toBeNull();
  const body = hit as string;
  let start = -1;
  for (let i = body.indexOf(signature); i >= 0; i = body.indexOf(signature, i + 1)) {
    if (/\bCREATE\s+(OR\s+REPLACE\s+)?$/i.test(body.slice(Math.max(0, i - 24), i))) {
      start = i;
    }
  }
  expect(start, `không thấy định nghĩa của ${tenHam}`).toBeGreaterThan(-1);
  const tag = /\bAS (\$[A-Za-z_]*\$)/.exec(body.slice(start))?.[1] ?? "$$";
  const open = body.indexOf(tag, start);
  const close = body.indexOf(tag, open + tag.length);
  expect(close, signature).toBeGreaterThan(open);
  return boChuThich(body.slice(start, close + tag.length));
}

/**
 * Phần CHẠY LÚC MIGRATE: bỏ thân hàm (`AS $function$ … $function$` — mã chạy lúc
 * người dùng thao tác), giữ lại câu lệnh top-level và khối DO.
 */
const phanChayLucMigrate = (sql: string) =>
  boChuThich(sql).replace(/AS \$function\$[\s\S]*?\$function\$/g, "AS $function$<than>$function$");

function kiemKhungFile(sql: string) {
  expect(sql.match(/^\s*BEGIN\s*;\s*$/gm)).toHaveLength(1);
  expect(sql.match(/^\s*COMMIT\s*;\s*$/gm)).toHaveLength(1);
  expect(sql).toMatch(/NOTIFY pgrst, 'reload schema';\s*$/);
  expect(sql.includes("\r")).toBe(false);
  // Chủ chốt 25/09: không thay đổi dữ liệu đang tồn tại — lúc migrate không được
  // UPDATE/DELETE bảng nghiệp vụ nào, không thêm cột vào income_expenses.
  const code = phanChayLucMigrate(sql);
  expect(code).not.toMatch(
    /\b(UPDATE|DELETE\s+FROM)\s+public\.(income_expenses|income_expense_items|payments|invoices|invoice_payment_tenders|invoice_payment_collections|accounts|buildings|contracts|profit_monthly)\b/i,
  );
  expect(code).not.toMatch(/ALTER\s+TABLE\s+public\.income_expenses\s+ADD\s+COLUMN/i);
}

// ── M1: mã phiếu duy nhất ────────────────────────────────────────────────────

describe("M1 ma_phieu_duy_nhat", () => {
  const sql = docFile("ma_phieu_duy_nhat");

  it("khung file đúng khuôn, có preflight md5 và nghiệm thu", () => {
    kiemKhungFile(sql);
    expect(sql).toMatch(/md5\(pg_get_functiondef\('public\.auto_generate_voucher_code\(\)'::regprocedure\)\)/);
    expect(sql).toContain("$nghiem_thu$");
  });

  it("đếm CHUNG cả tổ chức, không còn theo từng người lập", () => {
    const fn = thanHamDangChay("auto_generate_voucher_code");
    expect(fn).toContain("app_private.voucher_code_counters");
    expect(fn).not.toMatch(/\buser_id\b/);
    expect(fn).not.toContain("pg_advisory_xact_lock");
    expect(fn).toContain("org_today_v1(NULL)");
    expect(fn).toMatch(/lpad\(v_next::text, 3, '0'\)/);
  });

  it("khởi tạo từ số đuôi lớn nhất của cả tổ chức trong tháng", () => {
    const fn = thanHamDangChay("auto_generate_voucher_code");
    expect(fn).toMatch(/max\(substring\(ie\.code FROM 7\)::integer\)/);
    expect(fn).toMatch(/ie\.organization_id = NEW\.organization_id/);
    expect(fn).toMatch(/ON CONFLICT \(organization_id, prefix, yymm\) DO NOTHING/);
  });

  it("chỉ mục duy nhất chỉ phủ phiếu ghi sau khi chạy (không đụng mã cũ)", () => {
    const code = boChuThich(sql);
    expect(code).toMatch(/CREATE UNIQUE INDEX income_expenses_org_code_duy_nhat ON public\.income_expenses \(organization_id, code\)/);
    expect(code).toMatch(/created_at >= %L::timestamptz/);
    expect(code).toMatch(/now\(\)\);/);
  });
});
