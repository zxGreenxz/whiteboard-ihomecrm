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
  // Chỉ tính file có CREATE thật ở đầu dòng: GRANT/DROP/chú thích nhắc tên hàm
  // không phải định nghĩa.
  const create = new RegExp(
    `^[ \\t]*CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${schema}\\.${tenHam}\\(`,
    "gim",
  );
  const files = readdirSync(MIG_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  let hit: string | null = null;
  for (const f of files) {
    const body = readFileSync(join(MIG_DIR, f), "utf8");
    create.lastIndex = 0;
    if (create.test(body)) hit = body;
  }
  expect(hit, `không thấy định nghĩa nào của ${tenHam}`).not.toBeNull();
  const body = hit as string;
  let start = -1;
  create.lastIndex = 0;
  for (let m = create.exec(body); m; m = create.exec(body)) start = m.index;
  expect(start, `không thấy định nghĩa của ${tenHam}`).toBeGreaterThan(-1);
  const tag = /\bAS (\$[A-Za-z_]*\$)/.exec(body.slice(start))?.[1] ?? "$$";
  const open = body.indexOf(tag, start);
  const close = body.indexOf(tag, open + tag.length);
  expect(close, `${schema}.${tenHam}`).toBeGreaterThan(open);
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

// ── M2: khoá tháng lợi nhuận tuyệt đối ───────────────────────────────────────

describe("M2 khoa_thang_loi_nhuan_tuyet_doi", () => {
  const sql = docFile("khoa_thang_loi_nhuan_tuyet_doi");
  const CUA_VUOT = /\b(is_org_owner_v1|is_super_admin|business_result_accounting|auth\.uid)\b/;

  it("khung file đúng khuôn, preflight md5 ba hàm bị thay, có nghiệm thu", () => {
    kiemKhungFile(sql);
    for (const chuKy of [
      "public.income_expenses_check_profit_lock()",
      "public.income_expense_items_check_profit_lock()",
      "app_private.assert_period_open_for_edit_v1(uuid,text)",
    ]) {
      expect(sql).toContain(`'${chuKy}'`);
    }
    expect(sql).toMatch(/md5\(pg_get_functiondef\(to_regprocedure\(v_ham\.chu_ky\)\)\) <> ALL \(v_ham\.md5_hop_le\)/);
    expect(sql).not.toMatch(/CHUA_DO_SAU/);
    expect(sql).toContain("$nghiem_thu$");
  });

  it("trigger phiếu không còn cửa vượt: chủ, super admin, không đăng nhập, ngoài KQKD", () => {
    const fn = thanHamDangChay("income_expenses_check_profit_lock");
    expect(fn).not.toMatch(CUA_VUOT);
    expect(fn).not.toContain("'ANNOTATE'");
    expect(fn).toContain("app_private.assert_profit_month_open_v2(");
    // Xét cả vị trí cũ và mới.
    expect(fn).toMatch(/OLD\.building_id, OLD\.voucher_date/);
    expect(fn).toMatch(/NEW\.building_id, NEW\.voucher_date/);
  });

  it("chỉ miễn đúng các cột không đổi tiền, và hai scope có tự kiểm delta", () => {
    const fn = thanHamDangChay("income_expenses_check_profit_lock");
    const mien = /v_mien := ARRAY\[([^\]]+)\]/.exec(fn)?.[1] ?? "";
    const cot = [...mien.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(cot).toEqual(
      [
        "handover_id",
        "has_restricted_item",
        "repeat_next_date",
        "repeat_remaining",
        "updated_at",
        "verified_at",
        "verified_by",
        "verified_by_name",
        "verified_note",
      ].sort(),
    );
    // Chiều NULL -> giá trị của ba cột vòng đời.
    for (const c of ["posting_mode", "posting_status", "review_state"]) {
      expect(fn).toContain(`IF OLD.${c} IS NULL THEN v_mien := v_mien || '${c}'::text; END IF;`);
    }
    expect(fn).toMatch(/v_scope = 'STOP_RECURRING'\s+AND COALESCE\(NEW\.repeat_cycle, 'NONE'\) = 'NONE'/);
    expect(fn).toMatch(/v_scope = 'LINK_CONTRACT'\s+AND OLD\.contract_id IS NULL\s+AND NEW\.contract_id IS NOT NULL/);
    expect(fn).toContain("w.transaction_id = pg_current_xact_id()");
  });

  it("trigger hạng mục khoá theo phiếu cha, không có ngoại lệ", () => {
    const fn = thanHamDangChay("income_expense_items_check_profit_lock");
    expect(fn).not.toMatch(CUA_VUOT);
    expect(fn).toContain("app_private.assert_profit_month_open_v2(");
    expect(fn).not.toContain("v_mien");
  });

  it("assert_period_open_for_edit_v1 chỉ xét ngày phiếu, bỏ tháng hoá đơn và kỳ hạng mục", () => {
    const fn = thanHamDangChay("assert_period_open_for_edit_v1", "app_private");
    expect(fn).not.toMatch(/billing_month|item_row|business_result_accounting|WP2_PERIOD_ALL_THREE/);
    expect(fn).toContain("app_private.assert_profit_month_open_v2(v_row.building_id, v_row.voucher_date, p_action)");
    // Hai bước sổ quỹ đã chốt và phiên bàn giao giữ nguyên.
    expect(fn).toContain("[CASHBOOK_CLOSED]");
    expect(fn).toContain("[HANDOVER_LOCKED]");
    expect(fn).toMatch(/STABLE SECURITY DEFINER/);
  });

  it("chốt tháng bị chặn ở bảng profit_monthly khi còn phiếu chờ duyệt", () => {
    const fn = thanHamDangChay("guard_profit_month_lock_pending_v1", "app_private");
    expect(fn).toContain("ie.approval_status = 'UNAPPROVED'");
    expect(fn).toContain("ie.deleted_at IS NULL");
    expect(fn).toContain("ie.building_id = NEW.building_id");
    expect(fn).toMatch(/OLD\.locked_at IS NOT DISTINCT FROM NEW\.locked_at/);
    expect(fn).toContain("duyệt hoặc huỷ trước khi chốt");
    const code = boChuThich(sql);
    expect(code).toMatch(
      /CREATE TRIGGER a10_profit_month_lock_requires_no_pending\s+BEFORE INSERT OR UPDATE OF locked_at ON public\.profit_monthly/,
    );
    expect(code).toContain("DROP TRIGGER IF EXISTS a10_profit_month_lock_requires_no_pending ON public.profit_monthly;");
  });

  it("hàm chung chỉ chủ bảng gọi được; không đụng bộ hàm chốt V2 và hàm mở khoá", () => {
    const code = boChuThich(sql);
    for (const ham of [
      "app_private.profit_month_locked_v1(uuid, date)",
      "app_private.assert_profit_month_open_v2(uuid, date, text)",
      "app_private.guard_profit_month_lock_pending_v1()",
    ]) {
      expect(code).toContain(`REVOKE ALL ON FUNCTION ${ham}\n  FROM PUBLIC, anon, authenticated, service_role;`);
    }
    expect(code).not.toMatch(/FUNCTION public\.(_?profit_\w+|lock_profit_month_v1|unlock_profit_month_v1)\(/);
    expect(code).not.toMatch(/guard_income_expense_owned_payload/);
  });
});

// ── M3: sửa phiếu Chờ duyệt ─────────────────────────────────────────────────

describe("M3 sua_phieu_cho_duyet", () => {
  const sql = docFile("sua_phieu_cho_duyet");
  const code = boChuThich(sql);

  it("khung file đúng khuôn, preflight md5 cả hai guard niêm phong đã ghim", () => {
    kiemKhungFile(sql);
    expect(sql).not.toMatch(/CHUA_DO_SAU/);
    // Lối vòng dựa vào đúng bản guard đã ghim trong migration-policy.json.
    expect(sql).toContain("'app_private.guard_income_expense_owned_payload()'");
    expect(sql).toContain("ARRAY['fb01ae8c9de7b283d19ade8195eba726']");
    expect(sql).toContain("'app_private.guard_income_expense_owned_items()'");
    expect(sql).toContain("$nghiem_thu$");
  });

  it("không định nghĩa lại hàm/trigger đã ghim", () => {
    expect(code).not.toMatch(/FUNCTION\s+app_private\.guard_income_expense_owned_payload\(/);
    expect(code).not.toMatch(/FUNCTION\s+app_private\.guard_income_expense_owned_items\(/);
    expect(code).not.toMatch(/FUNCTION\s+app_private\.finance_v2_birth_provenance_bridge\(/);
    expect(code).not.toMatch(/TRIGGER\s+(a00_ie_owned_payload_freeze|a86_finance_v2_birth_provenance)\b/);
  });

  it("scope REVISE được thêm vào ràng buộc, giữ đủ 7 scope cũ", () => {
    expect(code).toMatch(
      /CHECK \(scope IN \('ANNOTATE', 'FLEX_EDIT', 'LINK_CONTRACT', 'SALE_BONUS_DEPOSIT',\s+'CASHBOOK_MOVE', 'HANDOVER', 'STOP_RECURRING', 'REVISE'\)\)/,
    );
  });

  it("niêm phong chỉ nhường đúng cửa REVISE của chính transaction, đúng phiếu", () => {
    const fn = thanHamDangChay("is_income_expense_flow_owned", "app_private");
    expect(fn).toContain("w.scope = 'REVISE'");
    expect(fn).toContain("w.transaction_id = pg_current_xact_id_if_assigned()");
    expect(fn).toContain("w.backend_pid = pg_backend_pid()");
    expect(fn).toContain("w.income_expense_id = p_id");
  });

  it("trigger delta REVISE chỉ cho đổi cột nội dung + cột suy ra + phiên bản", () => {
    const fn = thanHamDangChay("ie_revise_scope_delta_guard", "app_private");
    const ds = /v_cho_doi := ARRAY\[([\s\S]*?)\];/.exec(fn)?.[1] ?? "";
    const cot = [...ds.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(cot).toEqual(
      [
        "type", "name", "building_id", "room_id", "tenant_id", "contract_id",
        "payer_name", "receive_bank_account", "receive_bank_name", "account_id",
        "attachments", "notes", "voucher_date", "business_result_accounting",
        "repeat_cycle", "repeat_count", "repeat_infinity", "repeat_auto_approve",
        "repeat_remaining", "repeat_next_date",
        "total_amount", "kqkd_amount", "counts_in_business_result", "has_restricted_item", "commission_kind",
        "approval_version", "updated_at",
      ].sort(),
    );
    expect(cot).not.toContain("approval_status");
    expect(cot).not.toContain("birth_operation_id");
    expect(fn).toMatch(/NEW\.approval_status IS DISTINCT FROM 'UNAPPROVED'/);
    expect(fn).toMatch(/COALESCE\(OLD\.posting_status, 'UNPOSTED'\) = 'POSTED'/);
    expect(code).toMatch(/CREATE TRIGGER a01_ie_revise_scope_delta\s+BEFORE UPDATE ON public\.income_expenses/);
  });

  it("writer: khoá org rồi khoá phiếu, CAS phiên bản, mở/đóng cửa REVISE", () => {
    const fn = thanHamDangChay("revise_pending_income_expense_v1");
    const khoaOrg = fn.indexOf("app_private.lock_org_for_decision_v1(v_org)");
    const khoaPhieu = fn.indexOf("FOR UPDATE");
    expect(khoaOrg).toBeGreaterThan(-1);
    expect(khoaPhieu).toBeGreaterThan(khoaOrg);
    expect(fn).toMatch(/v_row\.approval_version IS DISTINCT FROM p_expected_approval_version THEN\s+RAISE EXCEPTION '[^']*' USING ERRCODE = '40001'/);
    expect(fn).toContain("app_private.begin_ie_flex_write_v1(p_voucher, 'REVISE')");
    expect(fn).toContain("app_private.end_ie_flex_write_v1(p_voucher)");
    expect(fn).toContain("app_private.assert_no_engine_request_v1(p_voucher)");
    expect(fn).toContain("app_private.ie_flow_system_owned_v2(p_voucher)");
    expect(fn).toContain("app_private.assert_period_open_for_edit_v1(p_voucher, 'sửa')");
    expect(fn).toContain("approval_version = ie.approval_version + 1");
  });

  it("writer không đụng dấu vết sinh phiếu", () => {
    const fn = thanHamDangChay("revise_pending_income_expense_v1");
    expect(fn).not.toMatch(/\b(birth_operation_id|birth_txid|source_payload_hash|payload_hash_value)\s*=/);
    expect(fn).not.toMatch(/\bapproval_status\s*=\s*'/);
    expect(fn).not.toMatch(/\bposting_status\s*=\s*'/);
  });

  it("chỉ phiếu tay, hoa hồng, trả khách thanh lý; không phiếu gắn hoá đơn/lương/lợi nhuận/bàn giao", () => {
    const fn = thanHamDangChay("revise_pending_income_expense_v1");
    expect(fn).toContain("v_row.system_source NOT IN ('contract.commission', 'termination.refund')");
    for (const cot of [
      "invoice_id", "payment_id", "payment_collection_id", "utility_account_id", "salary_staff_id",
      "shareholder_id", "profit_manager_id", "handover_id", "handover_transfer_id", "reversal_of_income_expense_id",
    ]) {
      expect(fn).toContain(`v_row.${cot} IS NOT NULL`);
    }
    expect(fn).toContain("public.reservation_settlement_vouchers");
    expect(fn).toContain("public.profit_payout_reservations");
  });

  it("luật lý do: trục tiền (Thu/Chi, toà, sổ, KQKD, tiền/loại/kỳ hạng mục) ≥ 8 ký tự", () => {
    const fn = thanHamDangChay("revise_pending_income_expense_v1");
    expect(fn).toMatch(
      /v_money := v_changed && ARRAY\['type', 'building_id', 'account_id', 'business_result_accounting'\]\s+OR v_items_money_changed;/,
    );
    expect(fn).toMatch(/IF v_money AND \(v_reason IS NULL OR char_length\(v_reason\) < 8\)/);
    // Mô tả hạng mục đổi không tính là đổi tiền.
    expect(fn).toMatch(/jsonb_agg\(x\.o - 'd'/);
  });

  it("phiếu hệ thống không đổi khung, không đổi loại hạng mục", () => {
    const fn = thanHamDangChay("revise_pending_income_expense_v1");
    expect(fn).toMatch(/IF v_system AND v_new_type_ids IS DISTINCT FROM v_old_type_ids THEN/);
    expect(fn).toMatch(/IF v_system AND \(\s+t_type IS DISTINCT FROM v_row\.type/);
  });

  it("bảng lịch sử: RLS theo tầm nhìn phiếu, chỉ SELECT, không sửa/xoá được", () => {
    expect(code).toContain("ALTER TABLE public.income_expense_revisions ENABLE ROW LEVEL SECURITY;");
    expect(code).toContain("REVOKE ALL ON public.income_expense_revisions FROM PUBLIC, anon, authenticated, service_role;");
    expect(code).toContain("GRANT SELECT ON public.income_expense_revisions TO authenticated;");
    expect(code).toMatch(/USING \(app_private\.ie_supplement_can_read_v1\(income_expense_id\)\)/);
    expect(code).toMatch(/CREATE TRIGGER ie_revision_immutable\s+BEFORE UPDATE OR DELETE ON public\.income_expense_revisions/);
    expect(code).toMatch(/CREATE TRIGGER ie_revision_no_truncate\s+BEFORE TRUNCATE ON public\.income_expense_revisions/);
    expect(code).toMatch(/UNIQUE \(income_expense_id, revision_no\)/);
  });

  it("quyền gọi: writer + duyệt-có-phiên-bản cho authenticated, không cho anon", () => {
    for (const chuKy of [
      "public.revise_pending_income_expense_v1(uuid, bigint, jsonb, jsonb, text, text)",
      "public.approve_pending_income_expense_checked_v1(uuid, bigint)",
    ]) {
      expect(code).toContain(`REVOKE ALL ON FUNCTION ${chuKy}\n  FROM PUBLIC, anon, authenticated, service_role;`);
      expect(code).toContain(`GRANT EXECUTE ON FUNCTION ${chuKy}\n  TO authenticated;`);
    }
  });

  it("duyệt có phiên bản: cặp bỏ cọc rẽ trước khoá, rồi khoá org → phiếu → CAS → thang duyệt cũ", () => {
    const fn = thanHamDangChay("approve_pending_income_expense_checked_v1");
    const reCoc = fn.indexOf("public.set_termination_forfeit_status_v1(p_voucher, 'APPROVED')");
    const khoaOrg = fn.indexOf("app_private.lock_org_for_decision_v1(v_org)");
    const khoaPhieu = fn.indexOf("FOR UPDATE");
    const cas = fn.indexOf("USING ERRCODE = '40001'");
    expect(reCoc).toBeGreaterThan(-1);
    expect(khoaOrg).toBeGreaterThan(reCoc);
    expect(khoaPhieu).toBeGreaterThan(khoaOrg);
    expect(cas).toBeGreaterThan(khoaPhieu);
    expect(fn).toContain("PERFORM public.approve_income_expense_v1(p_voucher);");
    expect(fn).toContain("PERFORM public.approve_voucher(p_voucher);");
  });

  it("approve_income_expense_v1 giữ tín hiệu fallback, bỏ câu 'canonical không sửa được'", () => {
    const fn = thanHamDangChay("approve_income_expense_v1");
    expect(fn).toContain("Phiếu chưa thuộc luồng canonical — dùng đường legacy");
    expect(fn).not.toContain("canonical không sửa được");
    expect(fn).toContain("Phiếu chưa có sổ quỹ — bấm Sửa phiếu, chọn sổ quỹ rồi mới duyệt được.");
  });
});
