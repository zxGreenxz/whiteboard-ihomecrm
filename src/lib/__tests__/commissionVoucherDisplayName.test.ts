import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Tên phiếu hoa hồng theo PHÒNG + facts HĐ để dựng ghi chú lúc xem (02/09/2026).
 *
 * Ba bất biến đắt nhất:
 *  1. create_commission_voucher được CHÉP NGUYÊN KHỐI rồi đổi đúng một chỗ
 *     (v_name). Chép khối là lúc dễ đánh rơi chốt nhất: advisory lock chống
 *     chi trùng, chốt thưởng-Sale-từ-phiếu-cọc, tự duyệt COMMISSION_AUTOPAY_V1,
 *     và dòng notes "Người nhận: X" mà extractRecipientFromNotes đang đọc.
 *  2. RPC đọc facts là SECURITY DEFINER: phải gate quyền theo toà, không mở cho
 *     anon, và không cho gọi thẳng hai hàm nội bộ.
 *  3. Backfill CHỈ đổi cột name, idempotent, và chỉ trên phiếu có HĐ.
 *
 * Đo ĐỊNH NGHĨA SỐNG (lần CREATE cuối), không ghim file — xem
 * scripts/check-migration-test-liveness.mjs.
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

/** Định nghĩa SỐNG của schema.fn = lần CREATE cuối cùng theo thứ tự timestamp. */
function liveDefinitionOf(schema: string, fnName: string): { file: string; sql: string } {
  const re = new RegExp(
    `CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+${schema}\\.${fnName}\\s*\\(`,
    "i",
  );
  let hit: { file: string; sql: string } | null = null;
  for (const m of migrationCorpus()) {
    if (re.test(m.sql)) hit = m;
  }
  if (!hit) throw new Error(`Không tìm thấy định nghĩa nào của ${schema}.${fnName}`);
  return hit;
}

/** Thân của đúng một hàm trong file (từ CREATE tới `$…$;` đóng thân). */
function bodyOf(sql: string, schema: string, fnName: string): string {
  const start = sql.search(
    new RegExp(`CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+${schema}\\.${fnName}\\s*\\(`, "i"),
  );
  expect(start, `không thấy CREATE của ${schema}.${fnName}`).toBeGreaterThanOrEqual(0);
  const rest = sql.slice(start);
  const tag = /AS\s+(\$[a-z_]*\$)/i.exec(rest);
  expect(tag, `không thấy dollar-quote của ${schema}.${fnName}`).not.toBeNull();
  const open = rest.indexOf(tag![1]) + tag![1].length;
  const close = rest.indexOf(tag![1], open);
  expect(close, `thân ${schema}.${fnName} không đóng`).toBeGreaterThan(open);
  return rest.slice(0, close + tag![1].length);
}

describe("create_commission_voucher — tên theo phòng, không rơi chốt nào khi chép khối", () => {
  const live = () => liveDefinitionOf("public", "create_commission_voucher");

  it("đặt v_name qua commission_voucher_name_v1, có fallback tên cũ", () => {
    const { file, sql } = live();
    const body = bodyOf(sql, "public", "create_commission_voucher");
    expect(body, `${file}: chưa dùng commission_voucher_name_v1`).toContain(
      "app_private.commission_voucher_name_v1(p_kind, p_contract_id)",
    );
    expect(body, `${file}: mất fallback tên cũ ⇒ HĐ không phòng sẽ chặn tạo phiếu`).toContain(
      "'Hoa hồng môi giới HĐ '",
    );
  });

  it("vẫn giữ nguyên các chốt cũ: lock, claim thưởng Sale, tự duyệt, notes Người nhận", () => {
    const { file, sql } = live();
    const body = bodyOf(sql, "public", "create_commission_voucher");
    for (const chot of [
      "pg_advisory_xact_lock(",
      "app_private.sale_bonus_claims",
      "commission_autopay_check_v1(",
      "special_fee_approve_and_post_v1(",
      "'Người nhận: ' || p_recipient_name",
      "uq_ie_commission_per_contract".length > 0 ? "commission_kind = p_kind" : "",
    ].filter(Boolean)) {
      expect(body.includes(chot), `${file}: rơi chốt "${chot}" khi chép khối`).toBe(true);
    }
  });

  it("chữ ký 11 tham số KHÔNG đổi (không sinh overload cho PostgREST)", () => {
    const { sql } = live();
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.create_commission_voucher\(uuid,text,numeric,date,uuid,text,text,text,text,text,jsonb\)\s+FROM PUBLIC,\s*anon/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.create_commission_voucher\(uuid,text,numeric,date,uuid,text,text,text,text,text,jsonb\)\s+TO authenticated/,
    );
  });
});

describe("commission_contract_facts_v1 — luật STT trong năm, cọc, 7 ngày", () => {
  const live = () => liveDefinitionOf("app_private", "commission_contract_facts_v1");

  it("STT: cùng phòng, bỏ DRAFT/đã xoá, còn hiệu lực trong năm, xếp theo start_date", () => {
    const { file, sql } = live();
    const body = bodyOf(sql, "app_private", "commission_contract_facts_v1");
    for (const chot of [
      "o.room_id = c.room_id",
      "o.status::text <> 'DRAFT'",
      "o.deleted_at IS NULL",
      "make_date(c.y, 12, 31)",
      "make_date(c.y, 1, 1)",
      "(o.start_date, o.created_at, o.id) < (c.start_date, c.created_at, c.id)",
    ]) {
      expect(body.includes(chot), `${file}: thiếu "${chot}"`).toBe(true);
    }
  });

  it("cọc: đúng tập + công thức của contract_deposit_paid_derived, cả hai đường có index", () => {
    const { file, sql } = live();
    const body = bodyOf(sql, "app_private", "commission_contract_facts_v1");
    for (const chot of [
      "i.accounting_class = 'DEPOSIT'",
      "public.contract_deposit_links",
      "v.approval_status = 'APPROVED'",
      "v.deleted_at IS NULL",
      "COALESCE(i.amount, i.unit_price * i.quantity)",
      "WHEN dep.type = 'EXPENSE' THEN -1 ELSE 1 END",
      "GREATEST(",
    ]) {
      expect(body.includes(chot), `${file}: thiếu "${chot}"`).toBe(true);
    }
    // Đường OR trên LEFT JOIN quét toàn bảng (treo 2 phút lúc backfill) — cấm quay lại.
    expect(body).not.toMatch(/contract_id = p_contract_id OR l\.id IS NOT NULL/);
  });

  it("7 ngày: org_today_v1 ≥ start_date + 7 (khớp luật tự duyệt)", () => {
    const { file, sql } = live();
    const body = bodyOf(sql, "app_private", "commission_contract_facts_v1");
    expect(body, file).toContain("public.org_today_v1(c.organization_id) >= c.start_date + 7");
    expect(body, file).toMatch(/age\(c\.end_date, c\.start_date\)/);
  });

  it("nội bộ: REVOKE đủ PUBLIC/anon/authenticated/service_role cho cả facts lẫn name", () => {
    const { sql } = live();
    for (const fn of ["commission_contract_facts_v1(uuid)", "commission_voucher_name_v1(text, uuid)"]) {
      expect(sql).toMatch(
        new RegExp(
          `REVOKE ALL ON FUNCTION app_private\\.${fn.replace(/[()]/g, "\\$&")}\\s+FROM PUBLIC,\\s*anon,\\s*authenticated,\\s*service_role`,
        ),
      );
    }
  });
});

describe("get_commission_voucher_facts_v1 — RPC đọc, gate quyền, không mở anon", () => {
  const live = () => liveDefinitionOf("public", "get_commission_voucher_facts_v1");

  it("STABLE + DEFINER + search_path ghim + trần 200 + chỉ phiếu hoa hồng có HĐ", () => {
    const { file, sql } = live();
    const body = bodyOf(sql, "public", "get_commission_voucher_facts_v1");
    expect(body, file).toMatch(/\bSTABLE\b/);
    expect(body, file).toMatch(/SECURITY DEFINER/);
    expect(body, file).toContain("SET search_path TO 'pg_catalog', 'app_private', 'public'");
    expect(body, file).toContain("> 200");
    expect(body, file).toContain("ie.commission_kind IN ('broker', 'sale')");
    expect(body, file).toContain("ie.contract_id IS NOT NULL");
  });

  it("gate quyền theo toà như create_commission_voucher + chốt biên giới org", () => {
    const { file, sql } = live();
    const body = bodyOf(sql, "public", "get_commission_voucher_facts_v1");
    for (const chot of [
      "public.can_access_building(",
      "public.ie_all_buildings_scope(",
      "public.is_admin()",
      "public.is_super_admin()",
      "IS DISTINCT FROM r.organization_id",
    ]) {
      expect(body.includes(chot), `${file}: thiếu "${chot}"`).toBe(true);
    }
  });

  it("ACL: REVOKE anon, GRANT authenticated", () => {
    const { sql } = live();
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.get_commission_voucher_facts_v1\(uuid\[\]\)\s+FROM PUBLIC,\s*anon/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.get_commission_voucher_facts_v1\(uuid\[\]\)\s+TO authenticated/,
    );
  });
});

describe("backfill tên phiếu cũ — chỉ cột name, idempotent, chỉ phiếu có HĐ", () => {
  it("UPDATE duy nhất một cột name, có IS DISTINCT FROM và contract_id IS NOT NULL", () => {
    const { file, sql } = liveDefinitionOf("app_private", "commission_voucher_name_v1");
    const upd = /UPDATE public\.income_expenses ie\s+SET name = n\.ten[\s\S]*?;/.exec(sql);
    expect(upd, `${file}: không thấy câu backfill`).not.toBeNull();
    const cau = upd![0];
    expect(cau).toContain("ie.name IS DISTINCT FROM n.ten");
    expect(cau).toContain("x.contract_id IS NOT NULL");
    expect(cau).toContain("x.deleted_at IS NULL");
    // Chỉ một cột được SET — không đụng tiền/sổ/trạng thái.
    expect((cau.match(/\bSET\b/gi) ?? []).length).toBe(1);
    expect(cau).not.toMatch(/total_amount|account_id|approval_status|voucher_date|notes/);
  });
});
