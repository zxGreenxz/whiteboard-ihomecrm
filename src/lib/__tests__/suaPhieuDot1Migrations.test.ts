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
    const fn = thanHamDangChay("next_voucher_code_v1", "app_private");
    // Trigger lúc lập phiếu chỉ còn gọi hàm cấp số chung (cửa sửa phiếu dùng lại khi đổi Thu/Chi).
    const trig = thanHamDangChay("auto_generate_voucher_code");
    expect(trig).toContain("app_private.next_voucher_code_v1(NEW.organization_id, NEW.type)");
    expect(trig).not.toContain("voucher_code_counters");
    expect(fn).toContain("app_private.voucher_code_counters");
    expect(fn).not.toMatch(/\buser_id\b/);
    expect(fn).not.toContain("pg_advisory_xact_lock");
    expect(fn).toContain("org_today_v1(NULL)");
    expect(fn).toMatch(/lpad\(v_next::text, 3, '0'\)/);
  });

  it("khởi tạo từ số đuôi lớn nhất của MỌI mã cùng tiền tố trong tổ chức (không lọc loại)", () => {
    // Sự cố 25/09 PC2609124: bộ đếm cũ lọc theo loại nên cấp lại mã của phiếu đã đổi loại.
    const fn = thanHamDangChay("next_voucher_code_v1", "app_private");
    expect(fn).toMatch(/max\(substring\(ie\.code FROM 7\)::integer\)/);
    expect(fn).toMatch(/ie\.organization_id = p_org/);
    expect(fn).not.toMatch(/ie\.type\s*=/);
    expect(fn).toMatch(/ON CONFLICT \(organization_id, prefix, yymm\) DO NOTHING/);
  });

  it("hàm cấp số không mở cho người gọi thẳng", () => {
    const code = boChuThich(sql);
    expect(code).toMatch(
      /REVOKE ALL ON FUNCTION app_private\.next_voucher_code_v1\(uuid, text\)\s+FROM PUBLIC, anon, authenticated, service_role;/,
    );
    expect(code).not.toMatch(/GRANT EXECUTE ON FUNCTION app_private\.next_voucher_code_v1/);
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
    expect(cot).not.toContain("code");
    expect(fn).toMatch(/NEW\.approval_status IS DISTINCT FROM 'UNAPPROVED'/);
    expect(fn).toMatch(/COALESCE\(OLD\.posting_status, 'UNPOSTED'\) = 'POSTED'/);
    expect(code).toMatch(/CREATE TRIGGER a01_ie_revise_scope_delta\s+BEFORE UPDATE ON public\.income_expenses/);
  });

  it("đổi Thu/Chi: cấp mã MỚI đúng tiền tố; trigger chỉ cho đổi mã khi đổi loại", () => {
    // Sự cố 25/09 PC2609124: phiếu đổi Chi → Thu giữ mã PC làm kẹt dãy mã phiếu chi.
    const guard = thanHamDangChay("ie_revise_scope_delta_guard", "app_private");
    expect(guard).toMatch(/IF NEW\.type IS DISTINCT FROM OLD\.type THEN[\s\S]*?v_cho_doi := v_cho_doi \|\| 'code'::text;/);
    expect(guard).toMatch(/NEW\.code IS NOT DISTINCT FROM OLD\.code/);
    const fn = thanHamDangChay("revise_pending_income_expense_v1");
    expect(fn).toMatch(
      /IF t_type IS DISTINCT FROM v_row\.type THEN\s+t_code := app_private\.next_voucher_code_v1\(v_org, t_type\);\s+v_changed := v_changed \|\| 'code'::text;\s+ELSE\s+t_code := v_row\.code;/,
    );
    expect(fn).toMatch(/SET type = t_type,\s+code = t_code,/);
    // Cấp mã SAU mọi bước kiểm (lần sửa bị từ chối không đốt số).
    expect(fn.indexOf("app_private.next_voucher_code_v1(v_org, t_type)")).toBeGreaterThan(
      fn.indexOf("PERFORM app_private.assert_period_open_for_edit_v1(p_voucher, 'sửa')"),
    );
    expect(thanHamDangChay("ie_revision_snapshot_v1", "app_private")).toContain("'code', ie.code");
  });

  it("writer: khoá org rồi khoá phiếu, CAS phiên bản, mở/đóng cửa REVISE", () => {
    const fn = thanHamDangChay("revise_pending_income_expense_v1");
    const khoaOrg = fn.indexOf("app_private.lock_org_for_decision_v1(v_org)");
    const khoaPhieu = fn.indexOf("FOR UPDATE");
    expect(khoaOrg).toBeGreaterThan(-1);
    expect(khoaPhieu).toBeGreaterThan(khoaOrg);
    expect(fn).toMatch(/v_row\.approval_version IS DISTINCT FROM p_expected_approval_version THEN\s+RAISE EXCEPTION '[^']*' USING ERRCODE = 'PT409'/);
    // KHÔNG dùng 40001: PostgREST coi 40001 là xung đột tuần tự hoá và TỰ CHẠY LẠI giao dịch mãi
    // (đo trên TEST 25/09: lệnh sửa mang phiên bản cũ treo 125 giây rồi 504).
    expect(fn).not.toContain("'40001'");
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
      /v_money := v_changed && ARRAY\['type', 'building_id', 'business_result_accounting'\]\s+OR \('account_id' = ANY \(v_changed\) AND v_row\.account_id IS NOT NULL\)\s+OR v_items_money_changed;/,
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
    const cas = fn.indexOf("USING ERRCODE = 'PT409'");
    expect(fn).not.toContain("'40001'");
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

// ── M4: sổ nhận tiền + đổi hình thức thu ───────────────────────────────────

describe("M4 so_nhan_tien", () => {
  const sql = docFile("so_nhan_tien");
  const code = boChuThich(sql);

  it("khung file đúng khuôn, hai bảng cấu hình trong app_private không mở cho ai", () => {
    kiemKhungFile(sql);
    expect(code).toMatch(/CREATE TABLE IF NOT EXISTS app_private\.personal_cash_books/);
    expect(code).toMatch(/CREATE TABLE IF NOT EXISTS app_private\.building_receiving_cashbooks/);
    expect(code).toMatch(/payment_method text NOT NULL CHECK \(payment_method IN \('TK', 'TT'\)\)/);
    expect(code).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS personal_cash_books_dang_hieu_luc\s+ON app_private\.personal_cash_books \(membership_id\) WHERE valid_to IS NULL/);
    expect(code).toContain(
      "REVOKE ALL ON app_private.personal_cash_books, app_private.building_receiving_cashbooks\n  FROM PUBLIC, anon, authenticated, service_role;",
    );
  });

  it("khởi tạo chỉ ghi vào bảng mới, không đè dòng đã có", () => {
    const top = phanChayLucMigrate(sql);
    expect(top).not.toMatch(/UPDATE\s+public\./i);
    expect(top).toMatch(/INSERT INTO app_private\.personal_cash_books[\s\S]+?AND NOT EXISTS \(\s+SELECT 1 FROM app_private\.personal_cash_books p WHERE p\.membership_id = m\.id\);/);
    expect(top).toMatch(/ON CONFLICT \(building_id, payment_method, account_id\) DO NOTHING;/);
    // Quy tắc chung sổ tiền mặt riêng: "…Thu", không ảo, của chính người đó, đang giữ.
    expect(top).toContain("a.name ~* '\\mthu\\s*$'");
    expect(top).toContain("b.possession_kind = 'CUSTODIAN'");
    // Sổ phụ TK chủ chốt 25/09.
    for (const cap of ["('102LVT', 'TKHIEP')", "('1392QT', 'TKHIEP')", "('403PVB', 'TKHIEP')",
                       "('405PVB', 'TKHIEP')", "('512TT', 'TKHIEP')", "('950NK', 'CGIANG8818')"]) {
      expect(top).toContain(cap);
    }
  });

  it("danh sách sổ: TM = sổ riêng; TK/TT = mặc định trước rồi sổ phụ, giao với sổ người thu giữ/biết", () => {
    const fn = thanHamDangChay("receiving_cashbook_ids_v1", "app_private");
    expect(fn).toContain("FROM app_private.personal_cash_books p");
    expect(fn).toContain("CASE p_method WHEN 'TK' THEN b.default_account_id_tk ELSE b.default_account_id_tt END, 0");
    expect(fn).toContain("FROM app_private.building_receiving_cashbooks r");
    expect(fn).toContain("app_private.ie_has_cashbook_possession_v1(p_org, u.account_id, p_membership)");
    expect(fn).toContain("NOT COALESCE(a.is_virtual, false)");
    expect(fn).toMatch(/array_agg\(g\.account_id ORDER BY g\.thu_tu, g\.name, g\.account_id\)/);
  });

  it("cài đặt + xem sổ người khác: chỉ chủ công ty (neo theo vai) hoặc super admin", () => {
    for (const ten of ["list_receiving_cashbook_settings_v1", "set_personal_cash_book_v1",
                       "set_building_receiving_cashbooks_v1", "get_receiving_cashbooks_v1",
                       "change_collection_tender_method_v1"]) {
      const fn = thanHamDangChay(ten);
      expect(fn, ten).toContain("app_private.ie_actor_is_company_owner_v1(");
      expect(fn, ten).not.toContain("app_private.is_org_owner_v1(");
    }
    // Sổ tiền mặt riêng phải là sổ người đó đang GIỮ.
    const dat = thanHamDangChay("set_personal_cash_book_v1");
    expect(dat).toContain("b.possession_kind = 'CUSTODIAN'");
  });

  it("đổi hình thức thu: khoá đúng thứ tự của hoàn tác, chặn tiền thối/làm tròn, sổ theo NGƯỜI ĐÃ THU", () => {
    const fn = thanHamDangChay("change_collection_tender_method_v1");
    const iDot = fn.indexOf("FROM public.invoice_payment_collections c WHERE c.id = v_collection_id FOR UPDATE");
    const iHd = fn.indexOf("FROM public.invoices i WHERE i.id = v_collection.invoice_id FOR UPDATE");
    const iOrg = fn.indexOf("app_private.lock_org_for_decision_v1(v_org)");
    const iDong = fn.indexOf("FROM public.invoice_payment_tenders t WHERE t.id = p_tender_id FOR UPDATE");
    expect(iDot).toBeGreaterThan(-1);
    expect(iHd).toBeGreaterThan(iDot);
    expect(iOrg).toBeGreaterThan(iHd);
    expect(iDong).toBeGreaterThan(iOrg);
    expect(fn).toContain("Khoản thu có tiền thối nên không đổi hình thức được.");
    expect(fn).toContain("Khoản thu có làm tròn nên không đổi hình thức được.");
    expect(fn).toContain("v_collection.actor_id IS DISTINCT FROM v_actor");
    expect(fn).toContain("app_private.member_of_org_v1(v_org, v_collection.actor_id)");
    expect(fn).toContain("app_private.receiving_cashbook_ids_v1(v_org, v_invoice.building_id, p_new_method,");
    expect(fn).toContain("app_private.assert_period_open_for_edit_v1(v_row.id, 'đổi hình thức thu')");
    expect(fn).toContain("app_private.move_posted_income_cashbook_v1(v_row.id, v_new_account)");
    expect(fn).toMatch(/begin_accounting_chain_write_v1\(\);[\s\S]+UPDATE public\.payments[\s\S]+end_accounting_chain_write_v1\(\);/);
    expect(fn).toContain("'COLLECTION_METHOD'");
    expect(fn).toMatch(/char_length\(v_reason\) < 8/);
    expect(fn).toContain("v_flow IS DISTINCT FROM 'INVOICE_COLLECTION_V5'");
  });

  it("lõi đổi sổ: cửa CASHBOOK_MOVE + hậu kiểm tiền rời hẳn sổ cũ, không mở cho ai", () => {
    const fn = thanHamDangChay("move_posted_income_cashbook_v1", "app_private");
    expect(fn).toContain("app_private.begin_ie_flex_write_v1(p_voucher, 'CASHBOOK_MOVE')");
    expect(fn).toContain("app_private.end_ie_flex_write_v1(p_voucher)");
    expect(fn).toContain("sổ quỹ cũ vẫn còn số dư của phiếu này");
    expect(fn).toContain("sổ quỹ mới không nhận được khoản nào");
    expect(code).toContain(
      "REVOKE ALL ON FUNCTION app_private.move_posted_income_cashbook_v1(uuid, uuid)\n  FROM PUBLIC, anon, authenticated, service_role;",
    );
  });

  it("quyền gọi của M4: 5 RPC cho authenticated, không anon", () => {
    for (const chuKy of [
      "public.get_receiving_cashbooks_v1(uuid, uuid, uuid)",
      "public.list_receiving_cashbook_settings_v1(uuid)",
      "public.set_personal_cash_book_v1(uuid, uuid)",
      "public.set_building_receiving_cashbooks_v1(uuid, text, uuid, uuid[])",
      "public.change_collection_tender_method_v1(uuid, text, uuid, text, text)",
    ]) {
      expect(code).toContain(`REVOKE ALL ON FUNCTION ${chuKy}\n  FROM PUBLIC, anon, authenticated, service_role;`);
      expect(code).toContain(`GRANT EXECUTE ON FUNCTION ${chuKy} TO authenticated;`);
    }
  });
});

// ── M5: đóng đường cũ (áp sau khi web mới lên) ──────────────────────────────

describe("M5 dong_duong_cu_sua_phieu", () => {
  const sql = docFile("dong_duong_cu_sua_phieu");
  const code = boChuThich(sql);
  const TEN_GO = [
    "update_invoice_payment_method_v1",
    "move_income_voucher_cashbook_v1",
    "update_income_expense_quick",
    "lock_profit_month_v1",
    "unlock_profit_month_v1",
  ];

  it("khung file đúng khuôn, preflight md5 hai hàm bị thay, không còn chỗ trống md5", () => {
    kiemKhungFile(sql);
    expect(sql).not.toMatch(/CHUA_DO_SAU/);
    expect(sql).toContain("ARRAY['f57ad822ca8def8a86ab5a5d5d06199b', '3889ab4d9e3b3f48f8f5c928b6ea314d']");
    expect(sql).toContain("ARRAY['c6ed1d47823837349c92e8769932053a', 'ef1cf9abb7ae08a026b6bdf53b7840cf']");
  });

  it("thu tiền: chèn ĐÚNG MỘT chốt danh sách sổ, ngay sau chốt possession", () => {
    const fn = thanHamDangChay("record_invoice_collection_v5");
    const moc = "Bạn không được giao sổ quỹ này (cần là Người giữ sổ hoặc Người biết sổ). Chọn sổ khác.";
    const chot = "app_private.assert_receiving_cashbook_v1(";
    expect(fn.split(chot)).toHaveLength(2);
    expect(fn.indexOf(chot)).toBeGreaterThan(fn.indexOf(moc));
    expect(fn).toContain("v_org, v_invoice.building_id, v_method::text, v_collector_membership, v_account_id);");
    const tro = thanHamDangChay("assert_receiving_cashbook_v1", "app_private");
    expect(tro).toContain("app_private.receiving_cashbook_ids_v1(p_org, p_building, p_method, p_membership)");
    expect(tro).toMatch(/IF p_method IS NULL OR p_method NOT IN \('TM', 'TK', 'TT'\) THEN\s+RETURN;/);
  });

  it("kênh sửa cũ chỉ còn tên/ghi chú/ảnh của phiếu đã duyệt", () => {
    const fn = thanHamDangChay("ie_compat_update_pending_v2");
    expect(fn).not.toContain("v_money_keys");
    expect(fn).toContain("v_meta_keys text[] := ARRAY['name','notes','attachments']");
    expect(fn).toMatch(/IF p_items IS NOT NULL THEN\s+RAISE EXCEPTION '[^']*'\s+USING ERRCODE = '0A000'/);
    expect(fn).toMatch(/IF v_row\.approval_status = 'UNAPPROVED' THEN\s+RAISE EXCEPTION '[^']*'\s+USING ERRCODE = '0A000'/);
    expect(fn).toContain("app_private.ie_attachments_union_v1(ie.attachments, v_clean->'attachments')");
    expect(fn).not.toMatch(/account_id\s*=/);
  });

  it("gỡ 5 hàm không còn ai gọi, có khối chặn nếu còn hàm SQL gọi tới", () => {
    for (const ten of TEN_GO) {
      expect(code).toMatch(new RegExp(`DROP FUNCTION IF EXISTS public\\.${ten}\\(`));
    }
    expect(code).toContain("RAISE EXCEPTION 'Còn hàm gọi tới hàm sắp gỡ: %'");
  });

  it("thu quyền gọi thẳng record_invoice_payment_v4", () => {
    expect(code).toMatch(
      /REVOKE ALL ON FUNCTION public\.record_invoice_payment_v4\(uuid, numeric, public\.payment_method, date, text, uuid, text, text, jsonb, jsonb, text, uuid\)\s+FROM PUBLIC, anon, authenticated, service_role;/,
    );
  });

  // M5 áp SAU khi web mới lên: giao diện, edge function và kịch bản E2E không
  // được còn gọi hàm sắp gỡ (kênh sửa cũ ie_compat_update_pending_v2 vẫn sống
  // nhưng chỉ còn tên/ghi chú/ảnh của phiếu đã duyệt — kiểm ở test bên trên).
  it("giao diện, edge function, E2E không còn gọi 5 hàm đã gỡ", () => {
    const boQua = (duong: string) => {
      const d = duong.split("\\").join("/");
      return d.endsWith("src/integrations/supabase/types.ts") || /\/__tests__\/|\.test\.tsx?$/.test(d);
    };
    const conGoi: string[] = [];
    const duyet = (thuMuc: string) => {
      for (const muc of readdirSync(thuMuc, { withFileTypes: true })) {
        const duong = join(thuMuc, muc.name);
        if (muc.isDirectory()) {
          if (muc.name !== "node_modules") duyet(duong);
          continue;
        }
        if (!/\.(ts|tsx|js|mjs)$/.test(muc.name) || boQua(duong)) continue;
        // Bỏ chú thích (chú thích được phép nhắc tên hàm cũ để giải thích lịch
        // sử). `//` chỉ tính là chú thích khi đứng sau khoảng trắng/đầu dòng —
        // "https://…/rpc/<tên>" trong chuỗi vẫn được soi.
        const noiDung = readFileSync(duong, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/(^|\s)\/\/.*$/gm, "$1");
        for (const ten of TEN_GO) {
          if (new RegExp(`['"\`]${ten}['"\`]`).test(noiDung)) conGoi.push(`${duong} → ${ten}`);
        }
      }
    };
    for (const goc of ["src", join("supabase", "functions"), join(".e2e-fleet", "specs")]) {
      duyet(join(process.cwd(), goc));
    }
    expect(conGoi).toEqual([]);
  });
});
