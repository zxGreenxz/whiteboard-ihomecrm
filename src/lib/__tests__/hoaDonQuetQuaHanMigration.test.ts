// Guard TĨNH cho hai chỗ nối phát hiện lúc GỘP đợt rà soát 15/09 (16/09/2026).
//
// 1. mark_overdue_invoices_v1 phải nói cùng luật với recompute_invoice_for_id
//    (H1.5: PARTIAL_PAID đứng trước OVERDUE). Hai writer ngược luật ⇒ trạng thái
//    hoá đơn lật qua lật lại theo từng thao tác.
// 2. Guard đọc lương v5_can_view_salary_v1 (plan I1) phải mở cho service_role —
//    job đêm salary-v5-jobs → v5_run_job → v5_close_period → v5_month_money chạy
//    không có auth.uid(); thiếu mệnh đề này thì đóng kỳ lương tự động gãy 42501.
//
// Mọi khẳng định đo lần CREATE CUỐI CÙNG trên toàn thư mục migration (định nghĩa
// sống), không ghim một file — xem scripts/check-migration-test-liveness.mjs.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIG_DIR = join(process.cwd(), "supabase", "migrations");
const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, "");

/** Thân hàm ($tag$ … $tag$) của lần CREATE OR REPLACE cuối cùng trong corpus. */
function liveBodyOf(fnName: string): string {
  const files = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort();
  const ten = fnName.replace(/[.]/g, "[.]");
  const re = new RegExp(
    String.raw`CREATE\s+OR\s+REPLACE\s+FUNCTION\s+${ten}\s*\(([\s\S]*?)[$]([a-zA-Z_]*)[$]([\s\S]*?)[$]\2[$]`,
    "gi",
  );
  let last: string | null = null;
  for (const f of files) {
    const sql = readFileSync(join(MIG_DIR, f), "utf8");
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql))) last = stripComments(m[3]);
  }
  if (!last) throw new Error(`không tìm thấy CREATE OR REPLACE FUNCTION ${fnName}`);
  return last;
}

describe("mark_overdue_invoices_v1 — cùng luật với H1.5", () => {
  const body = liveBodyOf("public.mark_overdue_invoices_v1");
  it("không đánh PARTIAL_PAID thành OVERDUE nữa", () => {
    expect(body).not.toMatch(/PARTIAL_PAID/);
  });
  it("chỉ quét APPROVED chưa thu đồng nào", () => {
    expect(body).toMatch(/i\.status\s*=\s*'APPROVED'/);
    expect(body).toMatch(/coalesce\(i\.paid_amount,\s*0\)\s*=\s*0/);
  });
  it("ngày 'hôm nay' theo tổ chức của hoá đơn, không phải org_today_v1(NULL)", () => {
    expect(body).not.toMatch(/org_today_v1\(NULL\)/);
    expect(body).toMatch(/org_today_v1\(i\.organization_id\)/);
  });
});

describe("v5_can_view_salary_v1 — job đêm bằng service_role không bị chặn", () => {
  const body = liveBodyOf("app_private.v5_can_view_salary_v1");
  it("mở cho service_role / postgres TRƯỚC khi xét auth.uid()", () => {
    const iSvc = body.search(/auth\.role\(\)\s*=\s*'service_role'/);
    const iNull = body.search(/auth\.uid\(\)\)\s+IS NULL/);
    expect(iSvc).toBeGreaterThan(-1);
    expect(iNull).toBeGreaterThan(iSvc);
  });
  it("vẫn từ chối người lạ: có nhánh false khi không có auth.uid()", () => {
    expect(body).toMatch(/IS NULL THEN false/);
  });
});
