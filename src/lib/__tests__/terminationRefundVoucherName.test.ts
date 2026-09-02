import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Phiếu "Trả khách thanh lý": tên theo PHÒNG + facts để dựng ghi chú/khung tổng
 * hợp lúc xem (02/09/2026).
 *
 * Bất biến đắt nhất: terminate_contract_move_out_impl là hàm ~600 dòng ghi tiền
 * thật (cấn cọc, doanh thu, hoàn khách, khách trả thêm, hoá đơn SETTLEMENT, audit).
 * Nó được CHÉP NGUYÊN KHỐI từ pg_get_functiondef rồi đổi đúng một biểu thức tên.
 * Test này canh rằng mọi khối tiền vẫn còn, và chỉ có MỘT chỗ đổi.
 *
 * Đo ĐỊNH NGHĨA SỐNG (CREATE cuối), không ghim file.
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

function liveDefinitionOf(schema: string, fnName: string): { file: string; sql: string } {
  const re = new RegExp(`CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+${schema}\\.${fnName}\\s*\\(`, "i");
  let hit: { file: string; sql: string } | null = null;
  for (const m of migrationCorpus()) if (re.test(m.sql)) hit = m;
  if (!hit) throw new Error(`Không tìm thấy định nghĩa nào của ${schema}.${fnName}`);
  return hit;
}

function bodyOf(sql: string, schema: string, fnName: string): string {
  const start = sql.search(new RegExp(`CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+${schema}\\.${fnName}\\s*\\(`, "i"));
  expect(start, `không thấy CREATE của ${schema}.${fnName}`).toBeGreaterThanOrEqual(0);
  const rest = sql.slice(start);
  const tag = /AS\s+(\$[a-z_]*\$)/i.exec(rest);
  expect(tag, `không thấy dollar-quote của ${schema}.${fnName}`).not.toBeNull();
  const open = rest.indexOf(tag![1]) + tag![1].length;
  const close = rest.indexOf(tag![1], open);
  expect(close, `thân ${schema}.${fnName} không đóng`).toBeGreaterThan(open);
  return rest.slice(0, close + tag![1].length);
}

describe("terminate_contract_move_out_impl — đổi tên phiếu hoàn khách, không rơi khối tiền nào", () => {
  const live = () => liveDefinitionOf("public", "terminate_contract_move_out_impl");

  it("tên phiếu hoàn khách qua termination_refund_name_v1, fallback tên cũ, đúng MỘT chỗ", () => {
    const { file, sql } = live();
    const body = bodyOf(sql, "public", "terminate_contract_move_out_impl");
    const thay = "COALESCE(app_private.termination_refund_name_v1(p_contract_id, p_move_out_date), 'Trả khách thanh lý — HĐ ' || v_cnumber)";
    expect(body.split(thay).length - 1, `${file}: biểu thức tên phải xuất hiện đúng 1 lần`).toBe(1);
    // Không còn chỗ nào đặt tên cũ trần (ngoài fallback bên trong COALESCE).
    expect(body.split("'Trả khách thanh lý — HĐ ' || v_cnumber").length - 1).toBe(1);
  });

  it("mọi khối tiền của bản gốc còn nguyên", () => {
    const { file, sql } = live();
    const body = bodyOf(sql, "public", "terminate_contract_move_out_impl");
    for (const chot of [
      "'termination.offset'",
      "'termination.revenue'",
      "'termination.rent_refund_offset'",
      "'termination.rent_refund_revenue'",
      "'termination.refund'",
      "'termination.extra_receipt'",
      "kind, billing_month, issue_date",          // hoá đơn SETTLEMENT
      "_termination_apply_extra_charges(",
      "'CT'::payment_method",                     // cấn trừ công nợ
      "INSERT INTO contract_terminations",
      "[HOÀN KHÁCH THANH LÝ]",
      "recompute_invoice_for_id(",
      "LEAST(GREATEST(COALESCE(p_deposit_refund, 0), 0), COALESCE(v_contract.deposit_paid, 0))",
    ]) {
      expect(body.includes(chot), `${file}: rơi khối "${chot}" khi chép`).toBe(true);
    }
  });

  it("chữ ký 11 tham số giữ nguyên (không overload)", () => {
    const { sql } = live();
    expect(sql).toMatch(
      /FUNCTION public\.terminate_contract_move_out_impl\(p_contract_id uuid, p_move_out_date date, p_deposit_refund numeric DEFAULT 0, p_penalty_fee numeric DEFAULT 0, p_excess_rent numeric DEFAULT 0, p_outstanding_debt numeric DEFAULT 0, p_notes text DEFAULT NULL::text, p_extra_charges jsonb DEFAULT '\[\]'::jsonb, p_shortfall_mode text DEFAULT 'PAID'::text, p_receipt_account_id uuid DEFAULT NULL::uuid, p_refund_items jsonb DEFAULT '\[\]'::jsonb\)/,
    );
  });

  it("preflight md5 chặn replace mù khi bản prod đã đổi ngoài repo", () => {
    const { sql } = live();
    expect(sql).toMatch(/md5\(v_def\) <> '197fa29bc07a24cbaa7cb52f22f867aa'/);
    expect(sql).toContain("position('termination_refund_name_v1' IN v_def) > 0");
  });
});

describe("termination_refund_facts_v1 / get_termination_refund_facts_v1", () => {
  it("facts: đúng nguồn (hồ sơ thanh lý, hoá đơn SETTLEMENT, item phiếu, tiền thừa bóc từ ghi chú)", () => {
    const { file, sql } = liveDefinitionOf("app_private", "termination_refund_facts_v1");
    const body = bodyOf(sql, "app_private", "termination_refund_facts_v1");
    for (const chot of [
      "ie.system_source = 'termination.refund'",
      "public.contract_terminations",
      "i.kind = 'SETTLEMENT'",
      "i.status::text <> 'CANCELLED'",
      "app_private.commission_contract_facts_v1(v.contract_id)",
      "Tiền thừa \\(credit\\) áp dụng",
      "regexp_replace(",
      "'deposit_used', t.total_deposit",
      "'rent_refund_amount', t.rent_refund_amount",
    ]) {
      expect(body.includes(chot), `${file}: thiếu "${chot}"`).toBe(true);
    }
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION app_private\.termination_refund_facts_v1\(uuid\)\s+FROM PUBLIC,\s*anon,\s*authenticated,\s*service_role/,
    );
  });

  it("RPC: STABLE DEFINER, search_path ghim, gate quyền theo toà, REVOKE anon, GRANT authenticated", () => {
    const { file, sql } = liveDefinitionOf("public", "get_termination_refund_facts_v1");
    const body = bodyOf(sql, "public", "get_termination_refund_facts_v1");
    expect(body, file).toMatch(/\bSTABLE\b/);
    expect(body, file).toMatch(/SECURITY DEFINER/);
    expect(body, file).toContain("SET search_path TO 'pg_catalog', 'app_private', 'public'");
    expect(body, file).toContain("> 200");
    expect(body, file).toContain("ie.system_source = 'termination.refund'");
    for (const chot of ["public.can_access_building(", "public.ie_all_buildings_scope(", "public.is_admin()", "public.is_super_admin()"]) {
      expect(body.includes(chot), `${file}: thiếu "${chot}"`).toBe(true);
    }
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.get_termination_refund_facts_v1\(uuid\[\]\)\s+FROM PUBLIC,\s*anon/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.get_termination_refund_facts_v1\(uuid\[\]\)\s+TO authenticated/);
  });

  it("backfill: chỉ SET name, idempotent, chỉ phiếu termination.refund có HĐ", () => {
    const { file, sql } = liveDefinitionOf("app_private", "termination_refund_name_v1");
    const upd = /UPDATE public\.income_expenses ie\s+SET name = n\.ten[\s\S]*?;/.exec(sql);
    expect(upd, `${file}: không thấy câu backfill`).not.toBeNull();
    const cau = upd![0];
    expect(cau).toContain("ie.name IS DISTINCT FROM n.ten");
    expect((cau.match(/\bSET\b/gi) ?? []).length).toBe(1);
    expect(cau).not.toMatch(/total_amount|account_id|approval_status|voucher_date|notes/);
    expect(sql).toContain("x.system_source = 'termination.refund'");
    expect(sql).toContain("x.contract_id IS NOT NULL");
  });
});
